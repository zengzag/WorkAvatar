import { spawn, type ChildProcess } from 'child_process'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import type { TerminalEvent } from '../../shared/channels/terminal'
import WorkspaceManagerService from './workspace-manager.service'
import { createLogger } from './logger'
import {
  IS_WINDOWS,
  buildChildEnv,
  cleanupShellLaunch,
  decodeOutputBuffer,
  killProcessTree,
  resolveShellLaunch,
} from './agent/tools/exec-shared'

const logger = createLogger('TaskTerminal')

interface TerminalSession {
  /** 工作区根目录：`cd` 不带参数时回到这里 */
  root: string
  cwd: string
  child?: ChildProcess
}

export type TerminalExecOutcome =
  | { ok: true; cwd: string; running?: boolean }
  | { ok: false; error: string }

/**
 * 任务侧边栏的命令级终端。
 *
 * 与后台 terminal（BackgroundShellService）不同：这里由用户逐条输入命令，用于在工作区里
 * 查看/运行产物；不带 PTY，因此交互式程序（vim / REPL）不支持，换取零原生依赖与可预测行为。
 * cwd 由主进程维护（cd 命令），并在工作区边界内校验。
 */
class TerminalService {
  private static instance: TerminalService
  private sessions = new Map<string, TerminalSession>()
  private listener?: (event: TerminalEvent) => void

  static getInstance(): TerminalService {
    if (!TerminalService.instance) TerminalService.instance = new TerminalService()
    return TerminalService.instance
  }

  setEventListener(listener: (event: TerminalEvent) => void): void {
    this.listener = listener
  }

  private emit(event: TerminalEvent): void {
    try { this.listener?.(event) } catch { /* 推送失败不影响命令执行 */ }
  }

  exec(terminalId: string, cwd: string, rawCommand: string): TerminalExecOutcome {
    const id = String(terminalId || '').trim()
    if (!id) return { ok: false, error: 'invalid-cwd' }

    const session = this.ensureSession(id, cwd)
    if (!session) return { ok: false, error: 'invalid-cwd' }
    if (session.child) return { ok: false, error: 'busy' }

    const command = String(rawCommand || '').trim()
    if (!command) return { ok: true, cwd: session.cwd }

    const cdTarget = this.parseCd(command)
    if (cdTarget !== null) return this.changeDirectory(session, cdTarget)

    const spec = resolveShellLaunch(command)
    let child: ChildProcess
    try {
      child = spawn(spec.shell, spec.shellArgs, {
        cwd: session.cwd,
        detached: !IS_WINDOWS,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
        shell: false,
        env: buildChildEnv(),
      })
    } catch (error: any) {
      cleanupShellLaunch(spec)
      return { ok: false, error: String(error?.message || error) }
    }

    session.child = child
    child.stdout?.on('data', (data: Buffer) => {
      this.emit({ terminalId: id, type: 'output', stream: 'stdout', text: decodeOutputBuffer(data) })
    })
    child.stderr?.on('data', (data: Buffer) => {
      this.emit({ terminalId: id, type: 'output', stream: 'stderr', text: decodeOutputBuffer(data) })
    })
    child.on('error', (error) => {
      this.emit({ terminalId: id, type: 'output', stream: 'stderr', text: `${error.message}\n` })
    })
    child.on('close', (code) => {
      cleanupShellLaunch(spec)
      session.child = undefined
      this.emit({ terminalId: id, type: 'exit', code, cwd: session.cwd })
    })

    logger.info(`终端执行: ${id} cwd=${session.cwd} cmd=${command.slice(0, 200)}`)
    return { ok: true, cwd: session.cwd, running: true }
  }

  stop(terminalId: string): void {
    const session = this.sessions.get(String(terminalId || '').trim())
    if (!session?.child) return
    killProcessTree(session.child.pid, (signal) => session.child?.kill(signal))
  }

  /** 应用退出时终止全部执行中的命令 */
  disposeAll(): void {
    for (const session of this.sessions.values()) {
      if (session.child) {
        killProcessTree(session.child.pid, (signal) => session.child?.kill(signal))
      }
    }
    this.sessions.clear()
  }

  private ensureSession(id: string, cwd: string): TerminalSession | null {
    const existing = this.sessions.get(id)
    if (existing) return existing
    const resolved = this.resolveInsideWorkspace(String(cwd || ''))
    if (!resolved) return null
    try { fs.mkdirSync(resolved, { recursive: true }) } catch { /* 创建失败交由 spawn 报错 */ }
    const session: TerminalSession = { root: resolved, cwd: resolved }
    this.sessions.set(id, session)
    return session
  }

  /** 解析 cd / chdir / Set-Location，返回目标参数（无参数返回空串）；非 cd 命令返回 null */
  private parseCd(command: string): string | null {
    const match = command.match(/^(?:cd|chdir|set-location|sl)(?:\s+([\s\S]*))?$/i)
    if (!match) return null
    let target = (match[1] || '').trim()
    // 带管道/串联的命令交给 shell 执行，避免把 `cd x && ls` 误判为切换目录
    if (/[;&|]/.test(target)) return null
    // Windows 的 cd /d 用于跨盘符切换
    if (IS_WINDOWS) target = target.replace(/^\/d\s+/i, '').trim()
    if ((target.startsWith('"') && target.endsWith('"')) || (target.startsWith("'") && target.endsWith("'"))) {
      target = target.slice(1, -1)
    }
    return target
  }

  private changeDirectory(session: TerminalSession, target: string): TerminalExecOutcome {
    if (!target) {
      session.cwd = session.root
      return { ok: true, cwd: session.cwd }
    }
    const expanded = target === '~' || target.startsWith('~/') || target.startsWith('~\\')
      ? path.join(os.homedir(), target.slice(1))
      : target
    const resolved = this.resolveInsideWorkspace(
      path.isAbsolute(expanded) ? expanded : path.resolve(session.cwd, expanded),
    )
    if (!resolved) return { ok: false, error: 'outside' }
    let isDirectory = false
    try { isDirectory = fs.statSync(resolved).isDirectory() } catch { /* 不存在 */ }
    if (!isDirectory) return { ok: false, error: 'not-directory' }
    session.cwd = resolved
    return { ok: true, cwd: session.cwd }
  }

  /** 归一化路径并限制在可访问工作区内（employees/ 或用户指定目录）；越界或不存在返回 null */
  private resolveInsideWorkspace(target: string): string | null {
    if (!target) return null
    let resolved: string
    try { resolved = fs.realpathSync(path.resolve(target)) } catch {
      resolved = path.resolve(target)
    }
    return WorkspaceManagerService.getInstance().isWithinWorkspaceBoundary(resolved) ? resolved : null
  }
}

export default TerminalService
