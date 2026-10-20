import { spawn, execSync } from 'child_process'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import SandboxService, {
  isSandboxDenial,
  isSandboxRunnerFailure,
  type ConfinedLaunch,
  type SandboxFacts,
  type SandboxMode,
} from '../../sandbox.service'
export const IS_WINDOWS = process.platform === 'win32'

/** 强制所有输出用 UTF-8 解码，配合启动时设置 chcp 65001 + [Console]::OutputEncoding */
export function decodeOutputBuffer(buf: Buffer): string {
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

/** 强杀进程树：Windows 用 taskkill /T /F；Unix 先 SIGKILL 子进程再杀进程组（detached 时生效） */
export function killProcessTree(pid: number | undefined, kill?: (signal: NodeJS.Signals) => void): void {
  try {
    if (IS_WINDOWS && pid) {
      killProcessTreeOnWindows(pid)
      return
    }
    try { kill?.('SIGKILL') } catch { /* noop */ }
    if (pid) {
      try { process.kill(-pid, 'SIGKILL') } catch { /* ignore */ }
    }
  } catch { /* noop */ }
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
    // stdin 模式不做 `$input | & { ... }` 包装：实测该写法会让 PowerShell 吞掉 stdin，
    // 块内原生命令（python -/node x.js）读到空输入（探针 LEN=0）。
    // 直接执行命令即可 —— 子进程继承父进程 stdin 管道，写入的 stdinContent 直达命令。
    const fullScript = POWERSHELL_PREFIX + `
${command}
exit $LASTEXITCODE
`
    fs.writeFileSync(psFile, fullScript, 'utf-8')
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

/** 子进程环境：统一 UTF-8（Python 输出编码 + Unix locale），前台/后台执行共用 */
export function buildChildEnv(extraEnv?: Record<string, string>): NodeJS.ProcessEnv {
  return {
    ...process.env,
    ...(IS_WINDOWS ? {
      PYTHONIOENCODING: 'utf-8',
      PYTHONUTF8: '1',
    } : {
      LANG: process.env.LANG || 'en_US.UTF-8',
      LC_ALL: process.env.LC_ALL || 'en_US.UTF-8',
    }),
    PYTHONIOENCODING: 'utf-8',
    PYTHONUTF8: '1',
    NODE_OPTIONS: process.env.NODE_OPTIONS,
    ...(extraEnv || {}),
  }
}

export interface ShellLaunchSpec {
  shell: string
  shellArgs: string[]
  /** PowerShell 长命令 / stdin 模式落盘的临时 .ps1，进程结束后必须清理 */
  tempFile?: string
  /** 实际要写入子进程 stdin 的内容（Unix heredoc 已并入 shellArgs，故为 undefined） */
  stdinContent?: string
}

/**
 * 计算 shell 启动参数：heredoc 解析 → 按平台包装
 * （Windows 统一 PowerShell + UTF-8 + 退出码传递；Unix 用 /bin/bash，heredoc 内容经 cat 管道注入）。
 * 前台（runCommandPlatform）与后台任务共用，保证两者行为一致。
 */
export function resolveShellLaunch(command: string, stdinContent?: string): ShellLaunchSpec {
  let effectiveCommand = command
  let stdin = stdinContent

  const heredoc = parseHeredoc(effectiveCommand)
  if (heredoc) {
    stdin = heredoc.heredocBody
    effectiveCommand = heredoc.preCommand
  }

  if (IS_WINDOWS) {
    const psWrap = wrapPowerShellCommand(effectiveCommand, !!stdin)
    return { shell: psWrap.shell, shellArgs: psWrap.shellArgs, tempFile: psWrap.tempFile, stdinContent: stdin }
  }
  if (stdin) {
    return {
      shell: '/bin/bash',
      shellArgs: ['-c', `cat <<'__INNER_EOF__' | ${effectiveCommand}\n${stdin}\n__INNER_EOF__`],
      stdinContent: undefined,
    }
  }
  return { shell: '/bin/bash', shellArgs: ['-c', effectiveCommand], stdinContent: undefined }
}

/** 清理启动阶段落盘的临时脚本 */
export function cleanupShellLaunch(spec: { tempFile?: string }): void {
  cleanupTempFile(spec.tempFile)
}

export interface RunCommandOptions {
  cwd: string
  timeoutMs: number
  stdinContent?: string
  extraEnv?: Record<string, string>
  /** 可写边界（工作区）；缺省回退到 cwd */
  workspaceRoot?: string
  /** 沙箱模式，默认 workspace-write */
  sandboxMode?: SandboxMode
}

export interface RunCommandResult {
  stdout: string
  stderr: string
  code: number | null
  signal: NodeJS.Signals | null
  /** 沙箱执行事实（未启用沙箱时为空） */
  sandbox?: SandboxFacts
  /** 沙箱运行器自身故障：命令没有真正执行 */
  sandboxRunnerFailed?: boolean
  /** 沙箱不可用导致命令未执行 */
  sandboxError?: string
}

/**
 * 跨平台执行命令（前台，等待结束并聚合全部输出）：
 * - Windows 统一用 PowerShell（自动检测 pwsh.exe 优先，回退 powershell.exe，自动设置 UTF-8 + 正确退出码传递）
 * - Unix 用 /bin/bash -c
 * - 支持通过 stdin 写入 heredoc 内容（避免引号嵌套地狱）
 * - 长命令（>8000 字符）自动写入临时 .ps1 文件执行，避免 PowerShell 命令行参数长度限制
 * - 超时时使用 taskkill /T /F 彻底杀死进程树（Windows），避免孤儿进程残留
 * - 严格分离 stdout / stderr
 * - 所有输出强制 UTF-8 解码
 * - 默认套用文件沙箱（可读全部、只可写工作区 + 私有临时目录），拒绝由内核判定
 *
 * 需要长跑/后台执行时改用 BackgroundShellService（main/services/background-shell.service.ts）。
 */
export function runCommandPlatform(
  command: string,
  opts: RunCommandOptions
): Promise<RunCommandResult> {
  return new Promise((resolve) => {
    // 1) heredoc 解析 + 2) 选择 shell（与后台任务共用同一份启动逻辑）
    const spec = resolveShellLaunch(command, opts.stdinContent)
    const actualStdin = spec.stdinContent

    // 3) 套沙箱：拿不到可用后端时直接拒绝执行，绝不静默降级
    let confined: ConfinedLaunch
    try {
      confined = SandboxService.getInstance().confine({
        program: spec.shell,
        args: spec.shellArgs,
        cwd: opts.cwd,
        workspaceRoot: opts.workspaceRoot || opts.cwd,
        mode: opts.sandboxMode ?? 'workspace-write',
      })
    } catch (err: any) {
      cleanupShellLaunch(spec)
      resolve({
        stdout: '',
        stderr: String(err?.message || err),
        code: -1,
        signal: null,
        sandboxError: String(err?.message || err),
      })
      return
    }

    let child: ReturnType<typeof spawn>
    try {
      child = spawn(confined.program, confined.args, {
        cwd: opts.cwd,
        // Unix 下 detached:true 使 shell 成为独立进程组长，超时才能用 kill(-pid) 杀整棵进程树；
        // 不影响正常等待 close 事件。Windows 的进程树杀灭走 taskkill /T（见超时分支）。
        detached: !IS_WINDOWS,
        // 无 stdin 内容时用 'ignore'（NUL/dev/null 设备）：读到 stdin 的命令立即收到 EOF，
        // 不会对着一根永不关闭的管道挂起等输入直到超时被杀。
        stdio: [actualStdin ? 'pipe' : 'ignore', 'pipe', 'pipe'],
        windowsHide: true,
        shell: false,
        env: { ...buildChildEnv(opts.extraEnv), ...confined.env },
      })
    } catch (err: any) {
      // 清理临时文件与沙箱临时目录
      cleanupShellLaunch(spec)
      confined.cleanup()
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
    let killTimer: NodeJS.Timeout | undefined
    let cleanedUp = false
    const cleanupOnce = () => {
      if (cleanedUp) return
      cleanedUp = true
      cleanupShellLaunch(spec)
      confined.cleanup()
    }

    const finish = (code: number | null, signal: NodeJS.Signals | null, extra?: Partial<RunCommandResult>) => {
      if (settled) return
      settled = true
      // 及时清掉超时定时器，避免事件循环被无谓挂到 timeoutMs+500
      if (killTimer) clearTimeout(killTimer)
      const stdout = decodeOutputBuffer(Buffer.concat(stdoutBufs))
      const stderr = decodeOutputBuffer(Buffer.concat(stderrBufs))
      cleanupOnce()
      const runnerFailed = isSandboxRunnerFailure(stderr)
      // 运行器故障的输出里也可能带「拒绝访问」，此时命令根本没跑，必须与策略拒绝区分开
      const sandbox: SandboxFacts | undefined = confined!.facts.backend === 'none'
        ? undefined
        : { ...confined!.facts, denied: !runnerFailed && isSandboxDenial(stderr) }
      resolve({
        stdout,
        stderr,
        code,
        signal,
        sandbox,
        sandboxRunnerFailed: sandbox ? runnerFailed : undefined,
        ...extra,
      })
    }

    child.stdout?.on('data', (d: Buffer) => { stdoutBufs.push(d) })
    child.stderr?.on('data', (d: Buffer) => { stderrBufs.push(d) })
    child.on('error', (err) => {
      finish(-1, null, { stderr: err.message })
    })
    child.on('close', (code, signal) => finish(code, signal))

    if (opts.timeoutMs) {
      killTimer = setTimeout(() => {
        if (!settled) {
          // 超时强杀整棵进程树（含子进程/孙进程），避免孤儿进程残留
          killProcessTree(child.pid, (signal) => child.kill(signal))
          // 由 finish 统一设置 settled 并 resolve，避免提前设 true 导致 finish 被跳过、Promise 永不 resolve
          finish(-2, 'SIGKILL')
        }
      }, opts.timeoutMs + 500)
      killTimer.unref?.()
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
  const head = text.substring(0, half)
  // 按码元切分可能把 emoji 等代理对切成两半（末尾孤立高代理），再退 1 个码元保证前缀是完整字符
  const safeHead = /[\uD800-\uDBFF]$/.test(head) ? head.slice(0, -1) : head
  return safeHead
    + `\n\n... (中间 ${text.length - maxChars} 字符已截断) ...\n\n`
    + text.substring(text.length - half)
}