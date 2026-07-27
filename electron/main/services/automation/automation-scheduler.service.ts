import AutomationService from './automation.service'
import { createLogger } from '../logger'
import { ScheduledTaskBase } from '../scheduled-task-base'

const logger = createLogger('AutomationScheduler')

const TICK_INTERVAL_MS = 30_000
const MAX_PARALLEL = 4

/**
 * 自动化任务调度器：每 30 秒扫描一次到期任务，
 * 调用 AutomationService.runTask 触发执行。
 *
 * 设计要点：
 * - 启动时清理 status='running' 的孤儿任务（崩溃恢复）
 * - 每次最多并行 MAX_PARALLEL 个任务，避免一次性触发过多对话
 * - runTask 内部已做 last_status='running' 跳过与重试，这里只负责发现到期任务
 */
class AutomationSchedulerService extends ScheduledTaskBase {
  private static instance: AutomationSchedulerService
  private ticking = false
  private activeCount = 0

  private constructor() {
    super('AutomationScheduler', TICK_INTERVAL_MS)
  }

  static getInstance(): AutomationSchedulerService {
    if (!AutomationSchedulerService.instance) {
      AutomationSchedulerService.instance = new AutomationSchedulerService()
    }
    return AutomationSchedulerService.instance
  }

  start(): void {
    try {
      const recovered = AutomationService.getInstance().recoverOrphanRuns()
      if (recovered.tasks > 0 || recovered.runs > 0) {
        logger.info(`Recovered orphan tasks=${recovered.tasks} runs=${recovered.runs}`)
      }
    } catch (err: any) {
      logger.warn('Recover orphan runs failed:', err?.message || err)
    }
    super.start()
  }

  protected async runCheck(): Promise<void> {
    if (this.ticking) return
    this.ticking = true
    try {
      const now = Math.floor(Date.now() / 1000)
      const service = AutomationService.getInstance()
      // fire-and-forget 模式：不等待任务完成，用 activeCount 控制并发
      // 避免长任务执行期间 ticking 阻塞后续 tick 导致新到期任务被延迟
      const slots = MAX_PARALLEL - this.activeCount
      if (slots <= 0) return
      const due = service.listDueTaskIds(now, slots)
      if (due.length === 0) return

      logger.info(`Found ${due.length} due task(s), ${this.activeCount} active`)
      for (const id of due) {
        this.activeCount++
        service
          .runTask(id, 'scheduler')
          .catch((err: any) => logger.warn(`Task ${id} run error:`, err?.message || err))
          .finally(() => { this.activeCount-- })
      }
    } catch (err: any) {
      logger.error('Scheduler tick error:', err?.message || err)
    } finally {
      this.ticking = false
    }
  }
}

export default AutomationSchedulerService
