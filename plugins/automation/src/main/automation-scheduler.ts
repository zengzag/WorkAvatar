/**
 * 自动化任务调度器（由宿主 automation-scheduler.service.ts 迁移而来）。
 * 差异点：
 * - 不再继承 ScheduledTaskBase，改用 ctx.services.scheduler.every(30s) 定时扫描
 * - 启动时调用 recoverOrphanRuns 清理崩溃残留
 */
import type { PluginContext } from '../../../plugin-sdk/src'
import { getAutomationService } from './automation-service'

const TICK_INTERVAL_MS = 30_000
const MAX_PARALLEL = 4

class AutomationScheduler {
  private jobId: string | null = null
  private ticking = false
  private activeCount = 0

  constructor(private ctx: PluginContext) {}

  async start(): Promise<void> {
    try {
      const recovered = await getAutomationService(this.ctx).recoverOrphanRuns()
      if (recovered.tasks > 0 || recovered.runs > 0) {
        this.ctx.services.logger.info(`Recovered orphan tasks=${recovered.tasks} runs=${recovered.runs}`)
      }
    } catch (err: any) {
      this.ctx.services.logger.warn('Recover orphan runs failed:', err?.message || err)
    }
    // 启动即扫描一次，随后每 30 秒扫描
    this.runCheck()
    this.jobId = this.ctx.services.scheduler!.every(TICK_INTERVAL_MS, () => this.runCheck())
  }

  stop(): void {
    if (this.jobId) {
      this.ctx.services.scheduler!.cancel(this.jobId)
      this.jobId = null
    }
  }

  private async runCheck(): Promise<void> {
    if (this.ticking) return
    this.ticking = true
    try {
      const now = Math.floor(Date.now() / 1000)
      const service = getAutomationService(this.ctx)
      const slots = MAX_PARALLEL - this.activeCount
      if (slots <= 0) return
      const due = service.listDueTaskIds(now, slots)
      if (due.length === 0) return

      this.ctx.services.logger.info(`Found ${due.length} due task(s), ${this.activeCount} active`)
      for (const id of due) {
        this.activeCount++
        service
          .runTask(id, 'scheduler')
          .catch((err: any) => this.ctx.services.logger.warn(`Task ${id} run error:`, err?.message || err))
          .finally(() => { this.activeCount-- })
      }
    } catch (err: any) {
      this.ctx.services.logger.error('Scheduler tick error:', err?.message || err)
    } finally {
      this.ticking = false
    }
  }
}

export default AutomationScheduler
