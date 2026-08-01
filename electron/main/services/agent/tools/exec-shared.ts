import { spawn, exec as execCb } from 'child_process'
import { promisify } from 'util'
import iconv from 'iconv-lite'

const execAsync = promisify(execCb)
export const IS_WINDOWS = process.platform === 'win32'

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
export async function detectConsoleCodepage(): Promise<string> {
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
export function decodeBuffer(buf: Buffer, codepage: string): string {
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
export function parseHeredoc(command: string): { preCommand: string; heredocBody: string; shell: string } | null {
  const heredocRe = /<<\s*(['"]?)([A-Z_][A-Z0-9_]*)\1\r?\n([\s\S]*?)\r?\n\2\s*$/i
  const m = command.match(heredocRe)
  if (!m) return null
  const heredocBody = m[3]
  const before = command.substring(0, m.index!).trimEnd()
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
export function runCommandPlatform(
  command: string,
  opts: {
    cwd: string
    timeoutMs: number
    stdinContent?: string
    extraEnv?: Record<string, string>
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
      // 有 stdin 内容时强制走 PowerShell：cmd.exe 对 stdin 管道透传不可靠，
      // 尤其是含中文的多行脚本通过 stdin 传给 cmd.exe 子进程时，编码/管道可能
      // 静默失败（exit_code=0 但无输出，或 exit_code=1 且 stderr 为空）
      if (actualStdin) {
        shell = 'powershell.exe'
        shellArgs = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command',
          // $input 读取 stdin 内容，通过管道传给命令
          `$input | & { ${command} }`
        ]
      } else {
        const hasPowershellSyntax = /[|&;()]|(\$\()|(\$env:)|(\b(if|for|while|where|select|sort|measure)\b)/i.test(command)
        if (hasPowershellSyntax) {
          shell = 'powershell.exe'
          shellArgs = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', command]
        } else {
          // cmd.exe 路径：强制设为 UTF-8 代码页，避免中文输出乱码/为空
          shell = 'cmd.exe'
          shellArgs = ['/d', '/s', '/c', `chcp 65001 >nul & "${command}"`]
        }
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
          ...(IS_WINDOWS ? { CHCP: '65001', PYTHONIOENCODING: 'utf-8' } : {}),
          LANG: process.env.LANG || 'en_US.UTF-8',
          PYTHONIOENCODING: process.env.PYTHONIOENCODING || 'utf-8',
          ...(opts.extraEnv || {}),
        },
      })
    } catch (err: any) {
      resolve({ stdout: '', stderr: String(err?.message || err), code: -1, signal: null })
      return
    }

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

/** 截断过长输出（保留前后各半，中间加省略标记） */
export function truncateOutput(text: string, maxChars: number): string {
  if (!text || text.length <= maxChars) return text || ''
  const half = Math.floor(maxChars / 2)
  return text.substring(0, half)
    + `\n\n... (中间 ${text.length - maxChars} 字符已截断) ...\n\n`
    + text.substring(text.length - half)
}

/** 从脚本代码中提取绝对路径（通用） */
export function extractAbsolutePaths(text: string): string[] {
  const paths: string[] = []
  let m: RegExpExecArray | null
  const quotedRe = /["']([A-Za-z]:[\\/][^"'\n]*|\/[^"'\n]+)["']/g
  while ((m = quotedRe.exec(text)) !== null) paths.push(m[1])
  const unquotedRe = /\b([A-Za-z]:[\\/][^\s|&;,\n]+|\/(?:home|tmp|usr|var|etc|root|opt|mnt|srv|Users|ProgramData|Windows)[^\s|&;,\n]*)/g
  while ((m = unquotedRe.exec(text)) !== null) paths.push(m[1])
  return [...new Set(paths)]
}

/** 收集可预览的生成文件 */
export function collectPreviewableFiles(paths: Iterable<string>): Array<{
  path: string
  name: string
  ext: string
  size: number
  mtime: number
}> {
  const PREVIEWABLE_EXTS = new Set([
    'docx', 'docm', 'dotx', 'dotm', 'doc', 'rtf', 'odt',
    'xlsx', 'xltx', 'xlsm', 'xlsb', 'xls', 'csv', 'ods',
    'pptx', 'pptm', 'potx', 'ppsx', 'ppsm', 'odp',
    'pdf', 'ofd',
    'txt', 'md', 'json', 'xml', 'html', 'htm', 'yaml', 'yml',
    'gif', 'jpg', 'jpeg', 'bmp', 'tiff', 'tif', 'png', 'svg', 'webp', 'ico', 'heic',
  ])
  const result: Array<{ path: string; name: string; ext: string; size: number; mtime: number }> = []
  for (const p of paths) {
    try {
      const fs = require('fs') as typeof import('fs')
      const path = require('path') as typeof import('path')
      if (!fs.existsSync(p)) continue
      const stat = fs.statSync(p)
      if (!stat.isFile()) continue
      const ext = path.extname(p).slice(1).toLowerCase()
      if (!PREVIEWABLE_EXTS.has(ext)) continue
      result.push({
        path: p,
        name: path.basename(p),
        ext,
        size: stat.size,
        mtime: stat.mtimeMs,
      })
    } catch { /* 忽略 */ }
  }
  return result
}
