import { spawn, execSync } from 'child_process'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
export const IS_WINDOWS = process.platform === 'win32'

/** 强制所有输出用 UTF-8 解码，配合启动时设置 chcp 65001 + [Console]::OutputEncoding */
function decodeBuffer(buf: Buffer): string {
  if (!buf || buf.length === 0) return ''
  return buf.toString('utf-8')
}

// 缓存 pwsh 检测结果，避免重复查询文件系统
let _pwshPath: string | null | undefined = undefined

/**
 * 检测 PowerShell 7 (pwsh.exe) 是否可用。
 * 优先使用 pwsh（更快、UTF-8 原生支持更好、功能更丰富、含 ForEach-Object -Parallel 等现代特性），
 * 回退到 powershell.exe (Windows PowerShell 5.1)。
 * 参考：Claude Code 的 CLAUDE_CODE_USE_POWERSHELL_TOOL=1 策略
 */
function detectPowerShell(): string {
  if (!IS_WINDOWS) return 'powershell.exe'
  if (_pwshPath !== undefined) return _pwshPath || 'powershell.exe'
  try {
    const candidates: string[] = []
    // 常见安装路径
    const progFiles = process.env['ProgramFiles'] || 'C:\\Program Files'
    const progFilesX86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)'
    const localAppData = process.env['LOCALAPPDATA'] || ''
    candidates.push(path.join(progFiles, 'PowerShell', '7', 'pwsh.exe'))
    candidates.push(path.join(progFilesX86, 'PowerShell', '7', 'pwsh.exe'))
    if (localAppData) candidates.push(path.join(localAppData, 'Microsoft', 'WindowsApps', 'pwsh.exe'))
    // PATH 中查找
    const PATH = process.env['PATH'] || ''
    for (const dir of PATH.split(';')) {
      try {
        const p = path.join(dir.trim(), 'pwsh.exe')
        if (fs.existsSync(p)) candidates.push(p)
      } catch { /* ignore */ }
    }
    // 去重检测
    const seen = new Set<string>()
    for (const p of candidates) {
      if (seen.has(p)) continue
      seen.add(p)
      try {
        if (fs.existsSync(p)) {
          _pwshPath = p
          return p
        }
      } catch { /* ignore */ }
    }
    // 尝试 which 命令
    try {
      execSync('where pwsh.exe', { stdio: 'pipe', timeout: 2000 })
        .toString().trim().split('\n').some(line => {
          const p = line.trim()
          if (p && fs.existsSync(p)) {
            _pwshPath = p
            return true
          }
          return false
        })
      if (_pwshPath) return _pwshPath
    } catch { /* not found */ }
  } catch { /* ignore */ }
  _pwshPath = null
  return 'powershell.exe'
}

/**
 * 在 Windows 上彻底杀死进程树（包括子进程和孙进程）。
 * - 使用 taskkill /T /F 强制终止整个进程树
 * - 回退到 child.kill('SIGKILL')
 * 参考：Codex CLI 的 Windows Job Object 进程树管理策略
 */
function killProcessTreeOnWindows(pid: number): void {
  try {
    execSync(`taskkill /PID ${pid} /T /F 2>nul`, { timeout: 3000, windowsHide: true })
  } catch {
    // taskkill 可能失败（进程已结束/权限不够），回退到简单 kill
    try {
      process.kill(pid, 'SIGKILL')
    } catch { /* ignore */ }
  }
}

/**
 * Windows PowerShell 前缀：统一设置 UTF-8 编码、错误输出重定向、正确捕获退出码
 * - chcp 65001: 设置控制台代码页为 UTF-8
 * - [Console]::OutputEncoding/InputEncoding: 确保 .NET 控制台 API 使用 UTF-8
 * - $OutputEncoding = [Console]::OutputEncoding: 确保 PowerShell 输出流编码一致
 * - $ErrorActionPreference = 'Continue': 错误不终止脚本，但会写入 stderr
 * - $PSNativeCommandUseErrorActionPreference: PowerShell 7 中原生命令错误也走 $ErrorActionPreference(PowerShell 7+)
 * - 包装命令执行，最后 exit $LASTEXITCODE 确保原生命令退出码正确传递
 */
const POWERSHELL_PREFIX = `
$OutputEncoding = [System.Text.Encoding]::UTF8
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
[Console]::InputEncoding = [System.Text.Encoding]::UTF8
$ErrorActionPreference = 'Continue'
if ($PSVersionTable.PSVersion.Major -ge 7) { $PSNativeCommandUseErrorActionPreference = $true }
chcp 65001 > $null 2>&1
`

/**
 * PowerShell 命令最大长度阈值（字符数）。
 * 超过此长度的命令会被写入临时 .ps1 文件执行，避免 PowerShell -Command 参数长度限制（约 32KB）。
 */
const PS_LONG_COMMAND_THRESHOLD = 8000

/**
 * 为 Windows PowerShell 包装命令：确保退出码和 stderr 正确返回
 * 对简单命令和复杂命令都适用，原生命令的 $LASTEXITCODE 会被正确传递
 * 长命令（>8000 字符）自动写入临时 .ps1 文件执行，避免命令行参数长度限制
 */
function wrapPowerShellCommand(command: string, stdinMode: boolean): { shell: string; shellArgs: string[]; tempFile?: string } {
  const shell = detectPowerShell()
  // 长命令或 stdin 模式：写入临时 .ps1 文件执行
  if (stdinMode || command.length > PS_LONG_COMMAND_THRESHOLD) {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-shell-'))
    const psFile = path.join(tempDir, 'script.ps1')
    const fullScript = POWERSHELL_PREFIX + `
${command}
exit $LASTEXITCODE
`
    fs.writeFileSync(psFile, fullScript, 'utf-8')
    if (stdinMode) {
      // stdin 模式：脚本从 stdin 读取内容
      const stdinScript = POWERSHELL_PREFIX + `
$input | & {
${command}
}
exit $LASTEXITCODE
`
      fs.writeFileSync(psFile, stdinScript, 'utf-8')
    }
    return {
      shell,
      shellArgs: ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', psFile],
      tempFile: psFile,
    }
  }
  // 普通模式：直接执行命令，最后 exit $LASTEXITCODE
  const wrappedScript = POWERSHELL_PREFIX + `
${command}
exit $LASTEXITCODE
`
  return {
    shell,
    shellArgs: ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', wrappedScript],
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
 * - Windows 统一用 PowerShell（自动检测 pwsh.exe 优先，回退 powershell.exe，自动设置 UTF-8 + 正确退出码传递）
 * - Unix 用 /bin/bash -c
 * - 支持通过 stdin 写入 heredoc 内容（避免引号嵌套地狱）
 * - 长命令（>8000 字符）自动写入临时 .ps1 文件执行，避免 PowerShell 命令行参数长度限制
 * - 超时时使用 taskkill /T /F 彻底杀死进程树（Windows），避免孤儿进程残留
 * - 严格分离 stdout / stderr
 * - 所有输出强制 UTF-8 解码
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
  return new Promise((resolve) => {
    let shell: string
    let shellArgs: string[]
    let actualStdin: string | undefined = opts.stdinContent
    let tempFile: string | undefined

    // 1) 先尝试解析 heredoc 语法：如果检测到 heredoc，把 body 作为 stdinContent 传入
    const heredoc = parseHeredoc(command)
    if (heredoc) {
      actualStdin = heredoc.heredocBody
      command = heredoc.preCommand
    }

    // 2) 选择 shell
    if (IS_WINDOWS) {
      // Windows 统一用 PowerShell：
      // - 自动检测 pwsh.exe (PowerShell 7) 优先，回退 powershell.exe (PowerShell 5.1)
      // - 长命令自动写入临时 .ps1 文件执行
      // - cmd.exe 完全废弃：编码/管道/退出码问题太多
      const psWrap = wrapPowerShellCommand(command, !!actualStdin)
      shell = psWrap.shell
      shellArgs = psWrap.shellArgs
      tempFile = psWrap.tempFile
    } else {
      shell = '/bin/bash'
      // Unix 下设置 LANG/LC_ALL 确保 UTF-8 输出
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
          ...(IS_WINDOWS ? {
            CHCP: '65001',
            PYTHONIOENCODING: 'utf-8',
            PYTHONUTF8: '1',
          } : {
            LANG: process.env.LANG || 'en_US.UTF-8',
            LC_ALL: process.env.LC_ALL || 'en_US.UTF-8',
          }),
          PYTHONIOENCODING: 'utf-8',
          PYTHONUTF8: '1',
          NODE_OPTIONS: process.env.NODE_OPTIONS,
          ...(opts.extraEnv || {}),
        },
      })
    } catch (err: any) {
      // 清理临时文件
      cleanupTempFile(tempFile)
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
      const stdout = decodeBuffer(Buffer.concat(stdoutBufs))
      const stderr = decodeBuffer(Buffer.concat(stderrBufs))
      // 清理临时文件
      cleanupTempFile(tempFile)
      resolve({ stdout, stderr, code, signal })
    }

    child.stdout?.on('data', (d: Buffer) => { stdoutBufs.push(d) })
    child.stderr?.on('data', (d: Buffer) => { stderrBufs.push(d) })
    child.on('error', (err) => {
      if (!settled) {
        settled = true
        cleanupTempFile(tempFile)
        resolve({ stdout: '', stderr: err.message, code: -1, signal: null })
      }
    })
    child.on('close', (code, signal) => finish(code, signal))

    if (opts.timeoutMs) {
      setTimeout(() => {
        if (!settled) {
          const pid = child.pid
          try {
            // Windows 使用 taskkill /T /F 彻底杀死进程树（包括所有子进程/孙进程）
            // 参考：Codex CLI 的 Windows Job Object + 进程树管理策略
            if (IS_WINDOWS && pid) {
              killProcessTreeOnWindows(pid)
            } else {
              try { child.kill('SIGKILL') } catch { /* noop */ }
              // Unix: 尝试杀进程组
              if (pid) {
                try { process.kill(-pid, 'SIGKILL') } catch { /* ignore */ }
              }
            }
          } catch { /* noop */ }
          // 由 finish 统一设置 settled 并 resolve，避免提前设 true 导致 finish 被跳过、Promise 永不 resolve
          finish(-2, 'SIGKILL')
        }
      }, opts.timeoutMs + 500)
    }
  })
}

/** 清理临时 .ps1 文件 */
function cleanupTempFile(tempFile?: string): void {
  if (!tempFile) return
  try {
    const dir = path.dirname(tempFile)
    fs.rmSync(dir, { recursive: true, force: true })
  } catch { /* ignore */ }
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