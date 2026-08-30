import { createLogger } from './logger'

const logger = createLogger('ScheduledTask')

/**
 * 轻量级定时任务基类，提供 setInterval + unref 模式的高性能定时检查。
 * 子类只需实现 runCheck()，基类负责定时器管理、并发防护和错误处理。
 */
export abstract class ScheduledTaskBase {
  private timer: NodeJS.Timeout | null = null
  /** 任务是否已启动（isRunning / triggerNow 使用） */
  protected running: boolean = false
  /** 并发防护：同一时刻仅允许一次 runCheck 在执行 */
  private executing: boolean = false
  protected readonly name: string
  protected readonly intervalMs: number

  constructor(name: string, intervalMs: number) {
    this.name = name
    this.intervalMs = intervalMs
  }

  start(): void {
    this.stop()
    this.running = true
    // 启动后立即跑一次，避免错失启动期间到期的任务
    this.runCheckSafe()
    this.timer = setInterval(() => {
      this.runCheckSafe()
    }, this.intervalMs)
    // unref 让定时器不阻止进程退出
    if (this.timer.unref) this.timer.unref()
    logger.info(`[${this.name}] Started: interval=${this.intervalMs}ms`)
  }

  /** 执行检查并带并发防护，避免与 running 状态混淆 */
  private runCheckSafe(): Promise<void> {
    if (this.executing) return Promise.resolve()
    this.executing = true
    return this.runCheck().catch(err => {
      logger.error(`[${this.name}] Scheduled check failed:`, err)
    }).finally(() => {
      this.executing = false
    })
  }

  stop(): void {
    this.running = false
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
      logger.info(`[${this.name}] Stopped`)
    }
  }

  isRunning(): boolean {
    return this.running
  }

  /** 立即触发一次检查（不等待下一个间隔） */
  async triggerNow(): Promise<void> {
    if (!this.running) return
    return this.runCheckSafe()
  }

  protected abstract runCheck(): Promise<void>
}
