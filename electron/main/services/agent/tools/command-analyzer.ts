import * as os from 'os'
import * as path from 'path'
import { normalizePath } from '../../path-normalize'

/**
 * 命令路径分析器：
 * 从 shell 命令文本中提取路径候选（绝对路径 + 相对路径），并将相对路径基于 cwd 解析为绝对路径。
 * 含 shell 变量（$env:TEMP、%APPDATA% 等）的路径无法静态解析，单独归入 unresolvedTokens，
 * 由调用方保守确认，禁止把它们 resolve 到 cwd 下伪装成工作区内路径。
 */

// 删除类命令模式
const FILE_DELETION_PATTERNS = [
  /\brm\s+/i, /\bdel\s+/i, /\brmdir\s+/i, /\berase\s+/i,
  /\bRemove-Item\b/i, /\brd\s+\/s/i, /\brd\s+\/q/i,
  // Python / Node.js 脚本删除原语（脚本经 stdin/heredoc 执行时同样需要拦截）
  /\bos\.(?:remove|unlink|rmdir|removedirs)\s*\(/,
  /\bshutil\.rmtree\s*\(/,
  /\.(?:unlink|rmdir)\s*\(\s*\)/,
  /\bfs(?:\.promises)?\.(?:unlink|rm|rmdir)\w*\s*\(/,
  /\bfs\.(?:unlinkSync|rmSync|rmdirSync)\s*\(/,
]

// 写入/新建/移动/复制类命令模式
const FILE_WRITE_PATTERNS = [
  /\bcopy\s+/i, /\bcp\s+/i,                          // 复制
  /\bmove\s+/i, /\bmv\s+/i,                          // 移动/重命名
  /\bxcopy\s+/i, /\brobocopy\s+/i,                   // Windows 批量复制
  /\bCopy-Item\b/i, /\bMove-Item\b/i,                // PowerShell 复制/移动
  /\bSet-Content\b/i, /\bAdd-Content\b/i,            // PowerShell 写入
  /\bOut-File\b/i,                                   // PowerShell 输出到文件
  /\bNew-Item\b/i,                                   // PowerShell 新建
  /\bmkdir\s+/i, /\bmd\s+/i,                         // 新建目录
  /\btouch\s+/i,                                     // 新建空文件
  /\btee\s+/i,                                       // 写入
  // Python 写/移动/建目录原语
  /\bopen\s*\([^)]*['"][awx]b?\+?['"]/,              // open(p, 'w'|'a'|'x'|'wb'|'w+' ...)
  /\bos\.(?:rename|replace|mkdir|makedirs)\s*\(/,
  /\bshutil\.(?:move|copy|copy2|copyfile|copyfileobj|copytree|make_archive)\s*\(/,
  /\.(?:write_text|write_bytes|rename|replace|mkdir|touch)\s*\(/,
  // Node.js fs 写原语
  /\bfs(?:\.promises)?\.(?:writeFile|appendFile|mkdir|rename|copyFile|createWriteStream|truncate)\w*\s*\(/,
  /\bfs\.(?:writeFileSync|appendFileSync|mkdirSync|renameSync|copyFileSync)\s*\(/,
]

export function isFileDeletionCommand(command: string): boolean {
  return FILE_DELETION_PATTERNS.some(p => p.test(command))
}

/** 检测重定向写入（> file, >> file）；目标首字符支持变量/波浪线/相对路径点，排除 2>&1 句柄重定向 */
export function hasRedirection(command: string): boolean {
  return /(^|[\s|&;(])>>?\s*(?=[A-Za-z"'/$~%.])/.test(command)
}

export function isFileWriteCommand(command: string): boolean {
  return FILE_WRITE_PATTERNS.some(p => p.test(command)) || hasRedirection(command)
}

/** 带引号的路径 token（引号内含 / 或 \，支持空格路径） */
const QUOTED_PATH_TOKEN_RE = /["']([^"'\n]+[\\/][^"'\n]*)["']/g

/** 不带引号的路径 word token：包含 / 或 \ 的连续词（排除引号、管道符等） */
const WORD_PATH_TOKEN_RE = /(?:^|[\s=,(])(\.{0,2}[\w.\-]*[\\/][^\s"'|&;,()<>]*)/g

/** token 内含 shell 变量引用：$VAR、${VAR}、$(cmd)、$env:X、%VAR%（cmd）、!VAR!（延迟扩展） */
const VARIABLE_TOKEN_RE = /(?:\$[\w{(]|%[\w]+%|![\w]+!)/

/**
 * 命令正文中无法静态归类的裸变量/波浪线目标（引号包裹的路径已由 token 提取覆盖）：
 * - $VAR/..、${VAR}/..、$env:X\..（要求出现分隔符，避免内容中普通变量误报）
 * - %VAR%\..、!VAR!\..
 * - 独立 ~ 或 ~/x、~\x（家目录）
 */
const BARE_DYNAMIC_TARGET_RE =
  /\$[\w{(][^\s"'|&;<>)]*[\\/]|%[\w]+%[\\/]|![\w]+![\\/]|(?:^|[\s=,(>])~(?=[\\/]|["'\s;|&)]|$)/

/** cd/Set-Location/pushd 到变量或家目录后，后续裸词目标将随之落在该目录（可能在工作区外） */
const CD_DYNAMIC_RE = /(?:^|[\s;&|])(?:cd|chdir|pushd|Set-Location)\s+["']?(?:\$|%\w+%|~)/i

/** 命令是否含无法静态解析目标路径的变量/波浪线引用（写/删命令需保守确认） */
export function hasUnresolvedDynamicTarget(command: string): boolean {
  return BARE_DYNAMIC_TARGET_RE.test(command) || CD_DYNAMIC_RE.test(command)
}

/** 提取命令中的绝对路径（带引号/不带引号） */
export function extractAbsolutePaths(text: string): string[] {
  const paths: string[] = []
  let m: RegExpExecArray | null
  const quotedRe = /["']([A-Za-z]:[\\/][^"'\n]*|\/[^"'\n]+)["']/g
  while ((m = quotedRe.exec(text)) !== null) paths.push(m[1])
  // 排除引号：无引号正则在引号路径内部也会命中（\b 边界在引号与盘符之间成立），
  // 不排除会把闭合引号吞进路径，产生 `ok.txt"` 脏路径
  const unquotedRe = /\b([A-Za-z]:[\\/][^\s|&;,\n"']+|\/(?:home|tmp|usr|var|etc|root|opt|mnt|srv|Users|ProgramData|Windows)[^\s|&;,\n"']*)/g
  while ((m = unquotedRe.exec(text)) !== null) paths.push(m[1])
  return [...new Set(paths)]
}

/** 提取命令中的相对路径候选 token（含 / 或 \，含引号包裹的空格路径），排除 URL 与选项 */
export function extractRelativePathTokens(text: string): string[] {
  const tokens: string[] = []
  let m: RegExpExecArray | null
  QUOTED_PATH_TOKEN_RE.lastIndex = 0
  while ((m = QUOTED_PATH_TOKEN_RE.exec(text)) !== null) {
    if (m[1] && m[1].length <= 500) tokens.push(m[1])
  }
  WORD_PATH_TOKEN_RE.lastIndex = 0
  while ((m = WORD_PATH_TOKEN_RE.exec(text)) !== null) {
    const token = m[1]
    if (!token || token.length > 500) continue
    if (/^[a-z]+:\/\//i.test(token)) continue // URL
    if (/^--?[\w-]*$/.test(token)) continue // 选项
    tokens.push(token)
  }
  return [...new Set(tokens)]
}

/** 展开 POSIX/PowerShell 风格的 ~ 家目录前缀；非 ~ 开头原样返回 */
function expandHome(token: string): string {
  if (token === '~') return os.homedir()
  if (token.startsWith('~/') || token.startsWith('~\\')) return path.join(os.homedir(), token.slice(1))
  return token
}

export interface AnalyzedCommandPaths {
  /** 绝对路径（原文） */
  absolutePaths: string[]
  /** 相对路径 token 基于 cwd 解析后的绝对路径（规范化，~ 已展开家目录） */
  resolvedRelativePaths: string[]
  /** 含变量引用、无法静态解析的路径 token（原文），调用方必须保守确认 */
  unresolvedTokens: string[]
}

/**
 * 分析命令中的全部路径：绝对路径原样返回；相对路径 token 解析到 cwd 下并规范化；
 * 含变量的 token 不做 resolve（否则会得到 cwd 下的假路径），归入 unresolvedTokens。
 */
export function analyzeCommandPaths(command: string, cwd: string): AnalyzedCommandPaths {
  const absolutePaths = extractAbsolutePaths(command)
  const resolvedRelativePaths: string[] = []
  const unresolvedTokens: string[] = []
  for (const token of extractRelativePathTokens(command)) {
    if (VARIABLE_TOKEN_RE.test(token)) {
      unresolvedTokens.push(token)
      continue
    }
    try {
      const resolved = normalizePath(path.resolve(cwd, expandHome(token)))
      if (resolved) resolvedRelativePaths.push(resolved)
    } catch { /* 忽略无法解析的 token */ }
  }
  return {
    absolutePaths,
    resolvedRelativePaths: [...new Set(resolvedRelativePaths)],
    unresolvedTokens: [...new Set(unresolvedTokens)],
  }
}

/** 工作区边界判定接口（由 FilePermissionService 适配，保持本函数无副作用可单测） */
export interface PathBoundary {
  isInside: (p: string) => boolean
  isAuthorized: (p: string) => boolean
}

export type ModifyOperation = '删除' | '修改'

export type CommandAccessDecision =
  | { kind: 'allow' }
  /** 存在字面量区外路径：批量弹窗确认 */
  | { kind: 'authorize-paths'; operation: ModifyOperation; paths: string[] }
  /** cwd 本身在区外且无具体目标：按 cwd 目录授权（授权范围即 cwd 自身） */
  | { kind: 'authorize-dir'; operation: ModifyOperation; dir: string }
  /** 目标含变量/波浪线无法静态归类，或删除命令无任何目标：逐条命令保守确认 */
  | { kind: 'confirm-command'; operation: ModifyOperation }

/**
 * 纯函数：基于命令类型与路径分析结果给出访问决策。
 * 安全优先级：区外字面路径拦截 > cwd 区外兜底 > 变量/不可解析目标保守确认 > 区内放行。
 */
export function decideCommandAccess(params: {
  command: string
  cwd: string
  isDeletion: boolean
  isWrite: boolean
  boundary: PathBoundary
}): CommandAccessDecision {
  const { command, cwd, isDeletion, isWrite, boundary } = params
  if (!isDeletion && !isWrite) return { kind: 'allow' }
  const operation: ModifyOperation = isDeletion ? '删除' : '修改'

  const { absolutePaths, resolvedRelativePaths, unresolvedTokens } = analyzeCommandPaths(command, cwd)
  const literalTargets = [...new Set([...absolutePaths, ...resolvedRelativePaths])]
  const outside = literalTargets.filter(p => !boundary.isInside(p) && !boundary.isAuthorized(p))
  if (outside.length > 0) return { kind: 'authorize-paths', operation, paths: outside }

  if (!boundary.isInside(cwd)) return { kind: 'authorize-dir', operation, dir: cwd }

  if (unresolvedTokens.length > 0 || hasUnresolvedDynamicTarget(command)) {
    return { kind: 'confirm-command', operation }
  }

  // 工作区内删除命令但完全解析不出目标（glob/裸词等），保守确认
  if (isDeletion && literalTargets.length === 0) {
    return { kind: 'confirm-command', operation }
  }

  return { kind: 'allow' }
}
