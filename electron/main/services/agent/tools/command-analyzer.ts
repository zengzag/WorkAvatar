import * as os from 'os'
import * as path from 'path'
import { normalizePath } from '../../path-normalize'

const IS_WINDOWS = process.platform === 'win32'

/**
 * 命令路径分析器：
 * 从 shell 命令文本中提取路径候选（绝对路径 + 相对路径），并将相对路径基于 cwd 解析为绝对路径。
 * 含 shell 变量（$env:TEMP、%APPDATA% 等）的路径无法静态解析，单独归入 unresolvedTokens，
 * 由调用方保守确认，禁止把它们 resolve 到 cwd 下伪装成工作区内路径。
 *
 * 删除类识别（isFileDeletionCommand）供 shell_exec / javascript_exec 直接拒绝使用：
 * 删除一律改由 file_delete 工具执行，因此删除命令不进入下面的路径决策。
 */

// 删除类命令模式
const FILE_DELETION_PATTERNS = [
  /\brm\s+/i, /\bdel\s+/i, /\brmdir\s+/i, /\berase\s+/i,
  /\bRemove-Item\b/i, /\brd\s+\/s/i, /\brd\s+\/q/i,
  // Python / Node.js 脚本删除原语（脚本经 stdin/heredoc/文件执行时同样需要拦截）
  /\bos\.(?:remove|unlink|rmdir|removedirs)\s*\(/,
  /\bshutil\.rmtree\s*\(/,
  // 方法调用形式：p.unlink() / Path(p).unlink(missing_ok=True) / require('fs').unlinkSync(p)
  /\b(?:unlink|unlinkSync|rmdir|rmdirSync|rmSync)\s*\(/,
  /require\(['"](?:node:)?fs['"]\)\s*\.\s*(?:promises\s*\.\s*)?(?:rm|unlink|rmdir)\w*\s*\(/,
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

/** 命令是否含无法静态解析目标路径的变量/波浪线引用（写入命令需保守确认） */
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

/**
 * 斜杠开关外形：单个分隔符起头、其后不再出现分隔符的 token（`/c`、`/s`、`/q`、`/b`、`/mir`、`/a:-d`）。
 * Windows 命令行用 `/` 前缀作选项，而 path.resolve(cwd, '/c') 会把它当成"当前盘根下的 c"，
 * 凭空造出 `C:\c` 这类不存在的盘根目标，使写入类命令被误判为操作工作区外的盘根路径。
 * 真正的路径至少还有第二段（/var/log、//server/share、MSYS 风格的 /c/Users/...），故不会误伤。
 * 判定与平台无关，是否过滤由调用方按平台决定（POSIX 上 `/s` 是合法绝对路径）。
 */
export function isSwitchLikeSlashToken(token: string): boolean {
  return token.startsWith('/') && !/[/\\]/.test(token.slice(1))
}

/** 交给解释器执行的脚本文件后缀（用于把删除检测从命令文本扩展到脚本内容） */
const SCRIPT_FILE_RE = /[^\s"'|&;,()<>]+\.(?:py|pyw|js|mjs|cjs|ts|ps1|sh|bash|zsh|rb|pl|bat|cmd|vbs)\b/i

/** 以解释器（可带路径，如 /usr/bin/python、C:\Python\python.exe）开头的命令段 */
const INTERPRETER_SEGMENT_RE =
  /^(?:[^\s"']*[\\/])?(?:python3?|py|node|nodejs|pwsh|powershell|bash|sh|zsh|deno|bun|ruby|perl|cmd)(?:\.exe|[\d.]+)?\s+([\s\S]*)$/i

/**
 * 提取命令行里"交给解释器执行"的脚本文件路径（python a.py / node b.js / pwsh -File c.ps1 / cmd /c d.bat）。
 * 调用方据此读取脚本内容继续做删除检测：否则"先用 file_write 写脚本、再执行脚本"可绕过命令文本层面的拦截。
 * 只检查以解释器开头的命令段（按 ; & | 换行切分），避免把路径片段（如 git checkout src/node/config.js）
 * 误当成待执行脚本。返回未解析、未判存在的原始 token。
 */
export function extractInvokedScriptPaths(command: string): string[] {
  const paths: string[] = []
  const scriptRe = new RegExp(`(?:^|[\\s=,("'\`])(${SCRIPT_FILE_RE.source})["']?(?=[\\s"'|&;,()<>]|$)`, 'gi')
  for (const segment of command.split(/[;&|\n]+/)) {
    const segmentMatch = INTERPRETER_SEGMENT_RE.exec(segment.trim())
    if (!segmentMatch) continue
    const args = segmentMatch[1]
    let m: RegExpExecArray | null
    scriptRe.lastIndex = 0
    while ((m = scriptRe.exec(args)) !== null) {
      if (m[1].startsWith('-')) continue // 选项（-File、--config=x.py）
      paths.push(m[1])
    }
  }
  return [...new Set(paths)]
}

/** 扫描结果：可作为路径解析的 token + 被判为 Windows 斜杠开关的 token */
interface ScannedPathTokens {
  pathTokens: string[]
  switchTokens: string[]
}

/**
 * 扫描命令中的路径候选 token（含 / 或 \，含引号包裹的空格路径），排除 URL 与 `-`/`--` 选项。
 * Windows 下斜杠开关单独归入 switchTokens：`/c`、`/s`、`/q` 这类既不是路径，
 * path.resolve 又会把它们错解成盘根路径（见 isSwitchLikeSlashToken）。
 */
function scanPathTokens(text: string): ScannedPathTokens {
  const pathTokens: string[] = []
  const switchTokens: string[] = []
  const push = (token: string | undefined) => {
    if (!token || token.length > 500) return
    if (IS_WINDOWS && isSwitchLikeSlashToken(token)) {
      switchTokens.push(token)
      return
    }
    pathTokens.push(token)
  }
  let m: RegExpExecArray | null
  QUOTED_PATH_TOKEN_RE.lastIndex = 0
  while ((m = QUOTED_PATH_TOKEN_RE.exec(text)) !== null) push(m[1])
  WORD_PATH_TOKEN_RE.lastIndex = 0
  while ((m = WORD_PATH_TOKEN_RE.exec(text)) !== null) {
    const token = m[1]
    if (!token) continue
    if (/^[a-z]+:\/\//i.test(token)) continue // URL
    if (/^--?[\w-]*$/.test(token)) continue // 选项
    push(token)
  }
  return { pathTokens: [...new Set(pathTokens)], switchTokens: [...new Set(switchTokens)] }
}

/** 提取命令中的相对路径候选 token（含 / 或 \，含引号包裹的空格路径），排除 URL 与选项 */
export function extractRelativePathTokens(text: string): string[] {
  return scanPathTokens(text).pathTokens
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
  /**
   * Windows 斜杠开关 token（原文）：既可能是命令行选项，也可能是"盘根下路径"的写法（/dst）。
   * 二者无法静态区分，调用方必须保守确认，不能当作"无目标"直接放行。
   */
  switchLikeTokens: string[]
}

/**
 * 分析命令中的全部路径：绝对路径原样返回；相对路径 token 解析到 cwd 下并规范化；
 * 含变量的 token 不做 resolve（否则会得到 cwd 下的假路径），归入 unresolvedTokens。
 */
export function analyzeCommandPaths(command: string, cwd: string): AnalyzedCommandPaths {
  const absolutePaths = extractAbsolutePaths(command)
  const { pathTokens, switchTokens } = scanPathTokens(command)
  const resolvedRelativePaths: string[] = []
  const unresolvedTokens: string[] = []
  for (const token of pathTokens) {
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
    switchLikeTokens: switchTokens,
  }
}

/** 工作区边界判定接口（由 FilePermissionService 适配，保持本函数无副作用可单测） */
export interface PathBoundary {
  isInside: (p: string) => boolean
  isAuthorized: (p: string) => boolean
}

export type CommandAccessDecision =
  | { kind: 'allow' }
  /** 存在字面量区外路径：批量弹窗确认 */
  | { kind: 'authorize-paths'; paths: string[] }
  /** cwd 本身在区外且无具体目标：按 cwd 目录授权（授权范围即 cwd 自身） */
  | { kind: 'authorize-dir'; dir: string }
  /** 目标含变量/波浪线/斜杠开关无法静态归类：逐条命令保守确认 */
  | { kind: 'confirm-command' }

/**
 * 按规范化路径去重：同一目标的原文与解析结果（`D:\a\x` 与 `d:\a\x`）只保留首次出现的写法，
 * 避免同一路径在确认弹窗里被列两遍。
 */
function dedupeNormalized(paths: string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const p of paths) {
    const key = normalizePath(p)
    if (!key || seen.has(key)) continue
    seen.add(key)
    out.push(p)
  }
  return out
}

/**
 * 纯函数：对**写入类**命令基于路径分析结果给出访问决策（删除类命令由调用方直接拒绝，不经过此函数）。
 * 安全优先级：区外字面路径拦截 > cwd 区外兜底 > 变量/不可解析目标保守确认 > 区内放行。
 */
export function decideCommandAccess(params: {
  command: string
  cwd: string
  isWrite: boolean
  boundary: PathBoundary
}): CommandAccessDecision {
  const { command, cwd, isWrite, boundary } = params
  if (!isWrite) return { kind: 'allow' }

  const { absolutePaths, resolvedRelativePaths, unresolvedTokens, switchLikeTokens } = analyzeCommandPaths(command, cwd)
  const literalTargets = dedupeNormalized([...absolutePaths, ...resolvedRelativePaths])
  const outside = literalTargets.filter(p => !boundary.isInside(p) && !boundary.isAuthorized(p))
  if (outside.length > 0) return { kind: 'authorize-paths', paths: outside }

  if (!boundary.isInside(cwd)) return { kind: 'authorize-dir', dir: cwd }

  // 斜杠开关（/c、/s、/q）与变量目标同属"无法静态归类"：不能因为排除开关就丢掉目标直接放行
  if (unresolvedTokens.length > 0 || switchLikeTokens.length > 0 || hasUnresolvedDynamicTarget(command)) {
    return { kind: 'confirm-command' }
  }

  return { kind: 'allow' }
}
