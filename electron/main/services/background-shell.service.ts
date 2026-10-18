import { spawn, type ChildProcess } from 'child_process'
import {
  IS_WINDOWS,
  buildChildEnv,
  cleanupShellLaunch,
  decodeOutputBuffer,
  killProcessTree,
  resolveShellLaunch,
} from './agent/tools/exec-shared'
import { createLogger } from './logger'

const logger = createLogger('BackgroundShell')

export type BackgroundShellStatus = 'running' | 'exited' | 'killed'

/** 单任务保留的输出窗口（字符）：只留尾部，避免长跑任务吃满内存 */
const MAX_BUFFER_CHARS = 200_000
/** 同一属主（会话）并发运行的任务数上限 */
const MAX_RUNNING_PER_OWNER = 8
/** 已结束任务的保留数量上限，超出按结束时间淘汰 */
const MAX_RETAINED_TASKS = 20
/** 发出终止信号后等待 close 事件的兜底时长 */
const KILL_FALLBACK_MS = 3000

interface BackgroundShellTask {
  id: string
  command: string
  cwd: string
  ownerKey: string
  child: ChildProcess
  pid?: number
  status: BackgroundShellStatus
  exitCode: number | null
  signal: string | null
  startedAt: number
  endedAt?: number
  /** 累计产出的字符数（读取偏移的绝对基准） */
  totalChars: number
  /** 当前缓冲区首字符对应的绝对偏移 */
  bufferStart: number
  buffer: string
  /** 有新输出 / 进程结束时的唤醒回调 */
  waiters: Array<() => void>
  launchTempFile?: string
  killRequested?: boolean
}

export interface BackgroundShellSnapshot {
  id: string
  command: string
  cwd: string
  pid?: number
  status: BackgroundShellStatus
  exitCode: number | null
  signal: string | null
  startedAt: number
  endedAt?: number
  totalChars: number
  bufferStart: number
  /** 属主键（conversationId 优先，降级 sessionId）：按会话过滤与回收用 */
  ownerKey: string
}

export interface BackgroundShellReadResult {
  ok: true
  snapshot: BackgroundShellSnapshot
  /** 本次返回的输出片段 */
  text: string
  /** 下次续读应传入的偏移（绝对字符位置） */
  nextOffset: number
  /** 请求的起始偏移已被缓冲区淘汰的字符数（>0 说明开头丢失） */
  droppedChars: number
  /** 是否还有未返回的输出（受 max_chars 限制） */
  hasMore: boolean
}

/**
 * 后台（长跑）shell 任务管理器。
 *
 * - 与前台 shell_exec 共用同一份启动逻辑（resolveShellLaunch）与强杀逻辑（killProcessTree），
 *   仅执行方式不同：不设超时、立即返回任务 ID、输出累积到有界内存缓冲区供增量读取。
 * - 任务不属于某一次 LLM 请求：不绑定 abortSignal，可跨轮次读取；由会话删除与应用退出统一回收。
 * - stdout 与 stderr 合并为单条时间线（后台场景没有「返回码决定读哪个流」的语境）。
 */
class BackgroundShellService {
  private static instance: BackgroundShellService
  private tasks = new Map<string, BackgroundShellTask>()
  /** 任务集合/状态变化通知（渲染端刷新入口列表用；只推状态变化，不推每次输出，避免高频 IPC） */
  private changeListener?: () => void

  static getInstance(): BackgroundShellService {
    if (!BackgroundShellService.instance) {
      BackgroundShellService.instance = new BackgroundShellService()
    }
    return BackgroundShellService.instance
  }

  /** 注册变化监听（覆盖式，重复调用只保留最后一个，保证幂等） */
  setChangeListener(listener: () => void): void {
    this.changeListener = listener
  }

  private notifyChange(): void {
    try { this.changeListener?.() } catch { /* 通知失败不影响任务本身 */ }
  }

  /** 启动后台任务；调用方负责已完成命令策略校验与文件授权 */
  start(params: {
    command: string
    stdinContent?: string
    cwd: string
    ownerKey: string
  }): { ok: true; snapshot: BackgroundShellSnapshot } | { ok: false; error: string } {
    const running = this.countRunning(params.ownerKey)
    if (running >= MAX_RUNNING_PER_OWNER) {
      return {
        ok: false,
        error: `同一会话最多同时运行 ${MAX_RUNNING_PER_OWNER} 个后台任务（当前 ${running} 个）。请先用 shell_kill 终止不再需要的任务，或等待其结束`,
      }
    }

    const spec = resolveShellLaunch(params.command, params.stdinContent)
    let child: ChildProcess
    try {
      child = spawn(spec.shell, spec.shellArgs, {
        cwd: params.cwd,
        // Unix 下 detached 让 shell 成为独立进程组长，终止时可用 kill(-pid) 清掉整棵树
        detached: !IS_WINDOWS,
        stdio: [spec.stdinContent ? 'pipe' : 'ignore', 'pipe', 'pipe'],
        windowsHide: true,
        shell: false,
        env: buildChildEnv(),
      })
    } catch (error: any) {
      cleanupShellLaunch(spec)
      return { ok: false, error: `后台任务启动失败: ${error?.message || error}` }
    }

    const id = `bg_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`
    const task: BackgroundShellTask = {
      id,
      command: params.command,
      cwd: params.cwd,
      ownerKey: params.ownerKey,
      child,
      pid: child.pid,
      status: 'running',
      exitCode: null,
      signal: null,
      startedAt: Date.now(),
      totalChars: 0,
      bufferStart: 0,
      buffer: '',
      waiters: [],
      launchTempFile: spec.tempFile,
    }
    this.tasks.set(id, task)

    if (spec.stdinContent && child.stdin && !child.stdin.destroyed) {
      try {
        child.stdin.write(spec.stdinContent, 'utf-8')
        child.stdin.end()
      } catch {
        try { child.stdin.destroy() } catch { /* noop */ }
      }
    }

    child.stdout?.on('data', (d: Buffer) => this.append(task, decodeOutputBuffer(d)))
    child.stderr?.on('data', (d: Buffer) => this.append(task, decodeOutputBuffer(d)))
    child.on('error', (error) => this.finish(task, -1, null, error.message))
    child.on('close', (code, signal) => this.finish(task, code, signal))

    this.gc()
    logger.info(`后台任务已启动: ${id} pid=${child.pid ?? '未知'} cwd=${params.cwd}`)
    this.notifyChange()
    return { ok: true, snapshot: this.snapshot(task) }
  }

  /** 读取输出：不传 offset 时返回尾部窗口；waitMs>0 时等待新输出或进程结束 */
  async read(id: string, opts: { offset?: number; maxChars?: number; waitMs?: number } = {}): Promise<
    BackgroundShellReadResult | { ok: false; error: string }
  > {
    const task = this.tasks.get(id)
    if (!task) return { ok: false, error: `后台任务不存在: ${id}（可能已被回收，请重新启动）` }

    const maxChars = Math.min(Math.max(Number(opts.maxChars) || 8000, 1), 30_000)
    const waitMs = Math.min(Math.max(Number(opts.waitMs) || 0, 0), 30_000)
    const requestedStart = opts.offset === undefined ? task.bufferStart : Math.max(0, Number(opts.offset) || 0)

    if (waitMs > 0) {
      const deadline = Date.now() + waitMs
      while (task.status === 'running' && task.totalChars <= requestedStart && Date.now() < deadline) {
        await this.waitForChange(task, deadline - Date.now())
      }
    }

    const start = Math.max(requestedStart, task.bufferStart)
    const end = Math.min(start + maxChars, task.totalChars)
    return {
      ok: true,
      snapshot: this.snapshot(task),
      text: task.buffer.slice(start - task.bufferStart, end - task.bufferStart),
      nextOffset: end,
      droppedChars: start - requestedStart,
      hasMore: end < task.totalChars,
    }
  }

  /** 终止任务（幂等：已结束的任务直接返回当前快照） */
  kill(id: string): { ok: true; snapshot: BackgroundShellSnapshot } | { ok: false; error: string } {
    const task = this.tasks.get(id)
    if (!task) return { ok: false, error: `后台任务不存在: ${id}` }
    if (task.status === 'running') {
      task.killRequested = true
      killProcessTree(task.pid, (signal) => task.child.kill(signal))
      // 兜底：taskkill 失败或 close 事件迟迟不到时，避免任务永远停在 running
      setTimeout(() => this.finish(task, null, 'SIGKILL'), KILL_FALLBACK_MS).unref?.()
      logger.info(`后台任务已请求终止: ${id} pid=${task.pid ?? '未知'}`)
      this.notifyChange()
    }
    return { ok: true, snapshot: this.snapshot(task) }
  }

  /** 列出任务快照（可按属主过滤），按启动时间倒序 */
  list(ownerKey?: string): BackgroundShellSnapshot[] {
    return [...this.tasks.values()]
      .filter(t => !ownerKey || t.ownerKey === ownerKey)
      .sort((a, b) => b.startedAt - a.startedAt)
      .map(t => this.snapshot(t))
  }

  /** 终止并移除指定属主（会话）的全部任务，返回被终止的运行中任务数 */
  killForOwners(ownerKeys: string[]): number {
    const keys = new Set(ownerKeys)
    let killed = 0
    let removed = 0
    for (const task of [...this.tasks.values()]) {
      if (!keys.has(task.ownerKey)) continue
      if (task.status === 'running') {
        this.kill(task.id)
        killed++
      }
      this.tasks.delete(task.id)
      removed++
    }
    if (removed > 0) this.notifyChange()
    return killed
  }

  /** 应用退出时终止全部任务 */
  disposeAll(): void {
    for (const task of this.tasks.values()) {
      if (task.status !== 'running') continue
      task.killRequested = true
      killProcessTree(task.pid, (signal) => task.child.kill(signal))
    }
    this.tasks.clear()
    this.notifyChange()
  }

  private append(task: BackgroundShellTask, text: string): void {
    if (!text) return
    task.totalChars += text.length
    task.buffer += text
    if (task.buffer.length > MAX_BUFFER_CHARS) {
      const drop = task.buffer.length - MAX_BUFFER_CHARS
      task.buffer = task.buffer.slice(drop)
      task.bufferStart += drop
    }
    this.wake(task)
  }

  private finish(task: BackgroundShellTask, code: number | null, signal: NodeJS.Signals | null, errorMessage?: string): void {
    if (task.status !== 'running') return
    task.status = task.killRequested ? 'killed' : 'exited'
    task.exitCode = code
    task.signal = signal
    task.endedAt = Date.now()
    if (errorMessage) this.append(task, `\n[进程错误] ${errorMessage}\n`)
    cleanupShellLaunch({ tempFile: task.launchTempFile })
    task.launchTempFile = undefined
    this.wake(task)
    this.notifyChange()
  }

  private wake(task: BackgroundShellTask): void {
    const waiters = task.waiters.splice(0)
    for (const waiter of waiters) {
      try { waiter() } catch { /* noop */ }
    }
  }

  private waitForChange(task: BackgroundShellTask, timeoutMs: number): Promise<void> {
    return new Promise<void>((resolve) => {
      let done = false
      const finish = () => {
        if (done) return
        done = true
        clearTimeout(timer)
        const idx = task.waiters.indexOf(finish)
        if (idx >= 0) task.waiters.splice(idx, 1)
        resolve()
      }
      const timer = setTimeout(finish, Math.max(Math.floor(timeoutMs), 50))
      task.waiters.push(finish)
    })
  }

  private snapshot(task: BackgroundShellTask): BackgroundShellSnapshot {
    return {
      id: task.id,
      command: task.command,
      cwd: task.cwd,
      pid: task.pid,
      status: task.status,
      exitCode: task.exitCode,
      signal: task.signal,
      startedAt: task.startedAt,
      endedAt: task.endedAt,
      totalChars: task.totalChars,
      bufferStart: task.bufferStart,
      ownerKey: task.ownerKey,
    }
  }

  private countRunning(ownerKey: string): number {
    let count = 0
    for (const task of this.tasks.values()) {
      if (task.ownerKey === ownerKey && task.status === 'running') count++
    }
    return count
  }

  /** 淘汰超出保留上限的已结束任务（先结束先淘汰） */
  private gc(): void {
    if (this.tasks.size <= MAX_RETAINED_TASKS) return
    const ended = [...this.tasks.values()]
      .filter(t => t.status !== 'running')
      .sort((a, b) => (a.endedAt || 0) - (b.endedAt || 0))
    while (this.tasks.size > MAX_RETAINED_TASKS && ended.length > 0) {
      this.tasks.delete(ended.shift()!.id)
    }
  }
}

export default BackgroundShellService
