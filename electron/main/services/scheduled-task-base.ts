import { createLogger } from './logger'

const logger = createLogger('ScheduledTask')

/**
 * 轻量级定时任务基类，提供 setInterval + unref 模式的高性能定时检查。
 * 子类只需实现 runCheck()，基类负责定时器管理、并发防护和错误处理。
 */
export abstract class ScheduledTaskBase {
  private timer: NodeJS.Timeout | null = null
  protected running: boolean = false
  protected readonly name: string
  protected readonly intervalMs: number

  constructor(name: string, intervalMs: number) {
    this.name = name
    this.intervalMs = intervalMs
  }

  start(): void {
    this.stop()
    this.timer = setInterval(() => {
      this.runCheck().catch(err => {
        logger.error(`[${this.name}] Scheduled check failed:`, err)
      })
    }, this.intervalMs)
    // unref 让定时器不阻止进程退出
    if (this.timer.unref) this.timer.unref()
    logger.info(`[${this.name}] Started: interval=${this.intervalMs}ms`)
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
      logger.info(`[${this.name}] Stopped`)
    }
  }

  get isRunning(): boolean {
    return this.running
  }

  /** 立即触发一次检查（不等待下一个间隔） */
  async triggerNow(): Promise<void> {
    return this.runCheck()
  }

  protected abstract runCheck(): Promise<void>
}
