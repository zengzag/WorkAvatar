import type { ToolDefinition } from './types'
import { spawn, exec as execCb } from 'child_process'
import { promisify } from 'util'
import * as fs from 'fs'
import * as path from 'path'
import iconv from 'iconv-lite'
import UnifiedInteractionService, { interactionContext } from '../../unified-interaction.service'
import { isPathInWorkspace, confirmOutsideWorkspace, getWorkspacePath } from './fs-tools'

const execAsync = promisify(execCb)
const IS_WINDOWS = process.platform === 'win32'

/** Windows 代码页 → iconv 编码名映射（常见简体中文环境） */
const CODEPAGE_TO_ENCODING: Record<string, string> = {
  '936': 'gbk',
  '932': 'shift_jis',
  '949': 'euc-kr',
  '65001': 'utf-8',
  '1252': 'latin1',
  '28591': 'latin1',
  '437': 'ascii',
  '850': 'latin1',
}

/** 缓存检测到的控制台代码页，避免每次都检测 */
let cachedConsoleCodepage: string | null = null

/** 检测 Windows 当前控制台代码页（chcp），失败回退 936(GBK) */
async function detectConsoleCodepage(): Promise<string> {
  if (!IS_WINDOWS) return '65001'
  if (cachedConsoleCodepage) return cachedConsoleCodepage
  try {
    const { stdout } = await execAsync('chcp', { encoding: 'ascii', windowsHide: true })
    const m = stdout.match(/(\d+)/)
    cachedConsoleCodepage = m ? m[1] : '936'
  } catch {
    cachedConsoleCodepage = '936'
  }
  return cachedConsoleCodepage
}

/** 把 Buffer 按检测到的代码页转成 UTF-8 字符串 */
function decodeBuffer(buf: Buffer, codepage: string): string {
  if (!buf || buf.length === 0) return ''
  const encoding = CODEPAGE_TO_ENCODING[codepage] || 'utf-8'
  try {
    if (encoding === 'utf-8') {
      return buf.toString('utf-8')
    }
    return iconv.decode(buf, encoding)
  } catch {
    return buf.toString('utf-8')
  }
}

/**
 * heredoc 语法解析：从命令字符串中提取 `<<?'?EOF'?...EOF` 块。
 * 返回：{ preCommand: heredoc 前的命令部分, heredocBody: 多行脚本内容, shell: 要使用的 shell 类型 }
 * 未匹配时返回 null。
 */
function parseHeredoc(command: string): { preCommand: string; heredocBody: string; shell: string } | null {
  const heredocRe = /<<\s*(['"]?)([A-Z_][A-Z0-9_]*)\1\r?\n([\s\S]*?)\r?\n\2\s*$/i
  const m = command.match(heredocRe)
  if (!m) return null
  const heredocBody = m[3]
  const before = command.substring(0, m.index!).trimEnd()
  // 解析出 shell 解释器（command 中 heredoc 之前的部分，如 `python -`、`bash -s` 或 `node -`）
  return { preCommand: before, heredocBody, shell: before }
}

/**
 * 跨平台执行命令：
 * - Windows 优先用 PowerShell（支持管道、复杂语法），fallback cmd
 * - Unix 用 /bin/bash -c
 * - 支持通过 stdin 写入 heredoc 内容（避免引号嵌套地狱）
 * - 自动根据控制台代码页转码输出
 * - 严格分离 stdout / stderr
 */
function runCommandPlatform(
  command: string,
  opts: {
    cwd: string
    timeoutMs: number
    stdinContent?: string
  }
): Promise<{
  stdout: string
  stderr: string
  code: number | null
  signal: NodeJS.Signals | null
}> {
  return new Promise(async (resolve) => {
    const codepage = await detectConsoleCodepage()
    let shell: string
    let shellArgs: string[]
    let actualStdin: string | undefined = opts.stdinContent

    // 1) 先尝试解析 heredoc 语法：如果检测到 heredoc，把 body 作为 stdinContent 传入
    const heredoc = parseHeredoc(command)
    if (heredoc) {
      actualStdin = heredoc.heredocBody
      command = heredoc.preCommand
    }

    // 2) 选择 shell
    if (IS_WINDOWS) {
      const hasPowershellSyntax = /[|&;()]|(\$\()|(\$env:)|(\b(if|for|while|where|select|sort|measure)\b)/i.test(command)
      if (hasPowershellSyntax || !actualStdin) {
        shell = 'powershell.exe'
        shellArgs = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command',
          // 管道输入给外部解释器：若 stdin 非空，通过 $input 变量转发
          actualStdin
            ? `$input | Out-String -Stream | & { ${command} }`
            : command
        ]
      } else {
        shell = 'cmd.exe'
        shellArgs = ['/d', '/s', '/c', `"${command}"`]
      }
    } else {
      shell = '/bin/bash'
      shellArgs = ['-c', actualStdin ? `cat <<'__INNER_EOF__' | ${command}\n${actualStdin}\n__INNER_EOF__` : command]
      actualStdin = undefined
    }

    let child: ReturnType<typeof spawn>
    try {
      child = spawn(shell, shellArgs, {
        cwd: opts.cwd,
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
        shell: false,
        env: {
          ...process.env,
          // Windows 下强制 UTF-8 输出（对于尊重 CHCP 的程序生效）
          ...(IS_WINDOWS ? { CHCP: '65001', PYTHONIOENCODING: 'utf-8' } : {}),
          LANG: process.env.LANG || 'en_US.UTF-8',
          PYTHONIOENCODING: process.env.PYTHONIOENCODING || 'utf-8',
        },
      })
    } catch (err: any) {
      resolve({ stdout: '', stderr: String(err?.message || err), code: -1, signal: null })
      return
    }

    // 写入 heredoc stdin（如果有）
    if (actualStdin && child.stdin && !child.stdin.destroyed) {
      try {
        child.stdin.write(actualStdin, 'utf-8')
        child.stdin.end()
      } catch {
        try { child.stdin.destroy() } catch { /* noop */ }
      }
    }

    const stdoutBufs: Buffer[] = []
    const stderrBufs: Buffer[] = []
    let settled = false

    const finish = (code: number | null, signal: NodeJS.Signals | null) => {
      if (settled) return
      settled = true
      const stdout = decodeBuffer(Buffer.concat(stdoutBufs), codepage)
      const stderr = decodeBuffer(Buffer.concat(stderrBufs), codepage)
      resolve({ stdout, stderr, code, signal })
    }

    child.stdout?.on('data', (d: Buffer) => { stdoutBufs.push(d) })
    child.stderr?.on('data', (d: Buffer) => { stderrBufs.push(d) })
    child.on('error', (err) => {
      if (!settled) {
        settled = true
        resolve({ stdout: '', stderr: err.message, code: -1, signal: null })
      }
    })
    child.on('close', (code, signal) => finish(code, signal))

    // 超时兜底
    if (opts.timeoutMs) {
      setTimeout(() => {
        if (!settled) {
          try { child.kill('SIGKILL') } catch { /* noop */ }
          finish(-2, 'SIGKILL')
        }
      }, opts.timeoutMs + 500)
    }
  })
}

const dangerousPatterns = [
  // 删除类（含 --recursive/--force 长选项形式）
  /\brm\s+(-[rf]{1,2}\s+|--recursive\b|--force\b)/i, /\bdel\s+\/f\b/i, /\brmdir\s+\/s\b/i,
  /\bRemove-Item\b.*-Recurse/i, /\bRemove-Item\b.*-Force/i,
  // 系统破坏类
  /\bformat\s+[a-z]:/i, /\bdiskpart\b/i, /\bdd\s+if=/i,
  /\bshutdown\b/i, /\breboot\b/i, /:.*?\(\)\s*\{.*?\};\s*:/,
  // 编码/混淆执行（绕过检测）
  /\bpowershell\s+.*-enc\b/i, /\bpowershell\s+.*-EncodedCommand\b/i,
  /\bcmd\s+\/c\s+.*\becho\b.*\|.*\bclip\b/i,
  // 危险解释器执行（python/node 已被释放，允许智能体使用系统环境）
  /\bperl\s+-e\b/i,
]

// 删除类命令模式
const fileDeletionPatterns = [
  /\brm\s+/i, /\bdel\s+/i, /\brmdir\s+/i, /\berase\s+/i,
  /\bRemove-Item\b/i, /\brd\s+\/s/i, /\brd\s+\/q/i,
]

// 写入/新建/移动/复制类命令模式
const fileWritePatterns = [
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
]

function isFileDeletionCommand(command: string): boolean {
  return fileDeletionPatterns.some(p => p.test(command))
}

/** 检测重定向写入（> file, >> file），避免误匹配比较运算符 */
function hasRedirection(command: string): boolean {
  // 匹配 > 或 >> 后紧跟路径首字符（盘符/斜杠/引号/点），排除 2>&1 等句柄重定向
  return /(^|[\s|&;(])>>?\s*(?=[A-Za-z"'/])/.test(command)
}

function isFileWriteCommand(command: string): boolean {
  return fileWritePatterns.some(p => p.test(command)) || hasRedirection(command)
}

/** 从命令中提取绝对路径（用于非工作区确认） */
function extractPathsFromCommand(command: string): string[] {
  const paths: string[] = []
  let m: RegExpExecArray | null
  // 1. 引号包裹的绝对路径
  const quotedRe = /["']([A-Za-z]:[\\/][^"'\n]*|\/[^"'\n]+)["']/g
  while ((m = quotedRe.exec(command)) !== null) paths.push(m[1])
  // 2. 重定向后的路径
  const redirRe = /(?:>>|>)\s*([A-Za-z]:[\\/][^\s|&;\n]+|\/[^\s|&;\n]+)/g
  while ((m = redirRe.exec(command)) !== null) paths.push(m[1])
  // 3. 未引用的绝对路径（Windows 盘符 或 Unix 常见根目录）
  const unquotedRe = /\b([A-Za-z]:[\\/][^\s|&;,\n]+|\/(?:home|tmp|usr|var|etc|root|opt|mnt|srv|Users|ProgramData|Windows)[^\s|&;,\n]*)/g
  while ((m = unquotedRe.exec(command)) !== null) paths.push(m[1])
  return [...new Set(paths)]
}

/** 截断过长输出（保留前后各半，中间加省略标记） */
function truncateOutput(text: string, maxChars: number): string {
  if (!text || text.length <= maxChars) return text || ''
  const half = Math.floor(maxChars / 2)
  return text.substring(0, half)
    + `\n\n... (中间 ${text.length - maxChars} 字符已截断) ...\n\n`
    + text.substring(text.length - half)
}

/** 构造命令失败时的结构化错误上下文 */
function buildErrorContext(params: {
  command: string
  code: number | null
  signal: NodeJS.Signals | null
  stdout: string
  stderr: string
  timeoutSec: number
  cwd: string
}): string {
  const { command, code, signal, stdout, stderr, timeoutSec, cwd } = params
  const lines: string[] = []
  lines.push('## 命令执行失败上下文')
  lines.push('')
  lines.push(`- **退出码**: ${code === null ? '(无，被信号终止)' : code}`)
  if (signal) lines.push(`- **终止信号**: ${signal}`)
  lines.push(`- **超时设置**: ${timeoutSec}s`)
  lines.push(`- **工作目录**: ${cwd}`)
  lines.push('- **命令**:')
  lines.push('```')
  lines.push(command.length > 500 ? command.substring(0, 500) + `\n...(命令共 ${command.length} 字符，已截断)` : command)
  lines.push('```')
  if (stdout && stdout.trim()) {
    lines.push('')
    lines.push('- **stdout (标准输出)**:')
    lines.push('```')
    lines.push(truncateOutput(stdout, 2000) || '(空)')
    lines.push('```')
  }
  if (stderr && stderr.trim()) {
    lines.push('')
    lines.push('- **stderr (标准错误)**:')
    lines.push('```')
    lines.push(truncateOutput(stderr, 2000) || '(空)')
    lines.push('```')
  }
  // 常见退出码诊断
  lines.push('')
  lines.push('### 诊断提示')
  if (code === -2 || signal === 'SIGKILL') lines.push('- 命令已超时或被强制 kill：考虑增大 timeout 参数或拆分长命令')
  else if (code === 127) lines.push('- 退出码 127：命令/解释器不存在，检查命令拼写或 PATH')
  else if (code === 126) lines.push('- 退出码 126：文件不可执行或权限不足')
  else if (code === 2 && IS_WINDOWS) lines.push('- Windows 退出码 2：常见于文件未找到或 CMD/PowerShell 语法错误')
  else if ((code ?? 0) !== 0) lines.push(`- 非零退出码：请根据 stderr 与命令内容定位原因`)
  else lines.push('- 退出码为 0 但报错：常见于 stderr 警告 + 上层业务判断失败')
  return lines.join('\n')
}

export const shellExecTool: ToolDefinition = {
  id: 'shell_exec',
  name: 'shell_exec',
  title: 'Shell命令执行',
  summary: `执行系统 shell 命令（${IS_WINDOWS ? 'PowerShell/CMD' : 'Bash'}），支持多行 heredoc 脚本与 stdin 输入。运行系统命令、Python/Node 脚本时使用。`,
  description:
    `执行系统 shell 命令。${IS_WINDOWS ? 'Windows 环境，优先 PowerShell（含管道/条件语法），简单命令回退 CMD；' : '类 Unix 环境，使用 /bin/bash -c；'}`
    + `统一 UTF-8 输出（自动检测 Windows 代码页并转码，避免中文乱码）。`
    + `严格分离 stdout 与 stderr，非 0 退出码返回完整错误上下文。`
    + `**支持两种多行脚本写法（避免引号转义地狱）**：`
    + `\n1) heredoc 语法：command 写为 \`python - <<'EOF'\n脚本多行\nEOF\`，shell_exec 会把中间的脚本块作为 stdin 传入解释器；`
    + `\n2) stdin_content 参数：把多行脚本传入 stdin_content，command 写 \`python -\`（或 \`node -\` 等），完全避免 JSON 字符串中的引号转义。`,
  parameters: {
    type: 'object',
    properties: {
      command: {
        type: 'string',
        description:
          '要执行的 shell 命令。支持 heredoc 语法（如 python - <<\'EOF\'\\n多行脚本\\nEOF），此时 heredoc 内的多行内容会作为 stdin 传入命令；配合 stdin_content 时，这里通常写为解释器加 \"-\" 或 \"-s\" 来从 stdin 读取脚本（如 python -、node -、bash -s）'
      },
      stdin_content: {
        type: 'string',
        description:
          '可选：通过 stdin 传给命令的多行脚本内容（推荐）。当你需要执行多行 Python/Node/Bash 脚本时，把代码写在这里，command 参数只需写解释器（如 python -）。这种写法完全避免了 JSON 字符串的引号与换行转义问题，比 heredoc 语法更稳定'
      },
      working_dir: { type: 'string', description: '可选的工作目录（绝对路径），不传则使用员工工作区' },
      timeout: {
        type: 'number',
        description: '超时时间（秒），默认 30 秒，最大 300 秒。执行脚本/构建等长命令请适当调大',
        minimum: 1,
        maximum: 300
      }
    },
    required: ['command']
  },
  // 设置工具级超时为 310s（略大于最大 300s），避免 middleware 默认 30s 超时截断用户指定的长命令
  timeoutMs: 310_000,
  handler: async (args: any) => {
    try {
      const command = String(args.command || '').trim()
      const stdinContent: string | undefined =
        typeof args.stdin_content === 'string' && args.stdin_content.length > 0
          ? args.stdin_content
          : undefined

      if (!command && !stdinContent) {
        return { success: false, error: 'command 不能为空（stdin_content 存在时 command 仍需指定解释器，如 python -）' }
      }

      // 安全检查：合并 command + heredoc 解析出的 body + stdin_content 一起检查
      const heredocInfo = parseHeredoc(command)
      const scriptContentForCheck = [
        command,
        heredocInfo?.heredocBody || '',
        stdinContent || ''
      ].join('\n')

      for (const pattern of dangerousPatterns) {
        if (pattern.test(scriptContentForCheck)) {
          return { success: false, error: '命令被安全策略拦截：检测到潜在危险操作' }
        }
      }

      const isDeletion = isFileDeletionCommand(scriptContentForCheck)
      const isWrite = isFileWriteCommand(scriptContentForCheck)
      const isModify = isDeletion || isWrite

      const ctx = interactionContext.getStore()
      const highPermission = !!ctx?.highPermission

      if (isModify && !highPermission) {
        const paths = extractPathsFromCommand(scriptContentForCheck)
        const nonWorkspacePaths = paths.filter(p => !isPathInWorkspace(p))

        if (nonWorkspacePaths.length > 0) {
          if (!ctx) {
            const op = isDeletion ? '删除' : '修改'
            return { success: false, error: `文件${op}操作涉及工作区外路径，但当前无交互上下文（可能是后台任务），已拒绝执行` }
          }
          const operation = isDeletion ? '删除' : '修改'
          for (const p of nonWorkspacePaths) {
            const result = await confirmOutsideWorkspace(operation, p)
            if (!result.ok) return { success: false, error: result.error }
          }
        } else if (isDeletion) {
          if (!ctx) {
            return { success: false, error: '删除类命令需要用户确认，但当前无交互上下文（可能是后台任务），已拒绝执行' }
          }
          try {
            const interactionService = UnifiedInteractionService.getInstance()
            const displayCmd = command.length > 200 ? command.substring(0, 200) + '...' : command
            const response = await interactionService.request({
              type: 'confirm',
              title: '确认执行删除命令',
              message: `即将执行可能删除文件的命令：\n\n${displayCmd}\n\n此操作不可撤销，是否确认执行？`,
              danger: true,
              source: 'security:shell_delete',
            })
            if (response.cancelled || response.confirmed !== true) {
              return { success: false, error: '用户取消了删除命令的执行' }
            }
          } catch {
            return { success: false, error: '删除命令确认失败，操作已取消' }
          }
        }
      }

      const employeeWorkspace = getWorkspacePath()
      const cwd = args.working_dir || employeeWorkspace || process.cwd()
      const timeoutSec = Math.min(Math.max(Number(args.timeout) || 30, 1), 300)
      const timeoutMs = timeoutSec * 1000

      const runResult = await runCommandPlatform(command, {
        cwd,
        timeoutMs,
        stdinContent,
      })

      const { stdout, stderr, code, signal } = runResult
      const succeeded = code === 0 && !signal

      // 组装输出：严格分离 stdout / stderr，即使成功也显示 stderr 告警
      const MAX_OUTPUT = 10000
      const sections: string[] = []
      if (stdout && stdout.trim()) {
        sections.push('### stdout')
        sections.push('```')
        sections.push(truncateOutput(stdout, MAX_OUTPUT))
        sections.push('```')
      }
      if (stderr && stderr.trim()) {
        sections.push(succeeded ? '### stderr (警告/提示)' : '### stderr')
        sections.push('```')
        sections.push(truncateOutput(stderr, MAX_OUTPUT))
        sections.push('```')
      }
      if (sections.length === 0) {
        sections.push('(命令执行完成，stdout 与 stderr 均为空)')
      }

      // 元信息行
      const meta: string[] = [`exit_code=${code === null ? 'null' : code}`]
      if (signal) meta.push(`signal=${signal}`)
      if (stdout.length > MAX_OUTPUT) meta.push(`stdout_total=${stdout.length}字符(已截断)`)
      if (stderr.length > MAX_OUTPUT) meta.push(`stderr_total=${stderr.length}字符(已截断)`)
      sections.unshift(`_${meta.join(', ')}_`)
      sections.unshift('')

      // 收集可预览的生成文件
      const generatedFiles: any[] = []
      const PREVIEWABLE_EXTS = new Set([
        'docx', 'docm', 'dotx', 'dotm', 'doc', 'rtf', 'odt',
        'xlsx', 'xltx', 'xlsm', 'xlsb', 'xls', 'csv', 'ods',
        'pptx', 'pptm', 'potx', 'ppsx', 'ppsm', 'odp',
        'pdf', 'txt', 'md', 'json', 'xml', 'html', 'htm', 'yaml', 'yml',
        'png', 'jpg', 'jpeg', 'gif', 'bmp', 'svg', 'webp',
      ])
      const candidatePaths = extractPathsFromCommand(scriptContentForCheck)
      for (const p of candidatePaths) {
        try {
          const resolved = path.resolve(p)
          if (!fs.existsSync(resolved)) continue
          const stat = fs.statSync(resolved)
          if (!stat.isFile()) continue
          const ext = path.extname(resolved).slice(1).toLowerCase()
          if (!PREVIEWABLE_EXTS.has(ext)) continue
          generatedFiles.push({
            path: resolved,
            name: path.basename(resolved),
            ext,
            size: stat.size,
            mtime: stat.mtimeMs,
          })
        } catch { /* 忽略单个文件检查失败 */ }
      }

      const output = sections.join('\n')

      if (!succeeded) {
        const errorCtx = buildErrorContext({
          command,
          code,
          signal,
          stdout,
          stderr,
          timeoutSec,
          cwd,
        })
        return {
          success: false,
          error: `命令执行失败（exit_code=${code === null ? 'null' : code}${signal ? `, signal=${signal}` : ''}）`,
          output: output + '\n\n' + errorCtx,
          stdout,
          stderr,
          generatedFiles,
        }
      }

      return { success: true, output, stdout, stderr, generatedFiles }
    } catch (error: any) {
      return {
        success: false,
        error: `命令执行异常: ${error?.message || error}`,
        stdout: error?.stdout || '',
        stderr: error?.stderr || '',
        output: error?.message || String(error),
      }
    }
  },
  source: 'builtin',
  // shell_exec 从按需工具提升为常驻工具：直接加入 LLM tools 数组
  onDemand: false,
}
