/**
 * 日历提醒调度器（由宿主 calendar-scheduler.service.ts 迁移而来）。
 * 差异点：
 * - 不再继承 ScheduledTaskBase，改用 ctx.services.scheduler.every(30s) 定时扫描
 * - 提醒推送：settings.enable_system_notification=false 走 ctx.ipc.broadcast('notify')，否则 ctx.services.notification.notify
 */
import type { PluginContext } from '../../../plugin-sdk/src'
import { getCalendarService } from './calendar-service'

const TICK_INTERVAL_MS = 30_000

class CalendarScheduler {
  private jobId: string | null = null

  constructor(private ctx: PluginContext) {}

  start(): void {
    try {
      const cleaned = getCalendarService(this.ctx).cleanupOldReminders()
      if (cleaned > 0) this.ctx.services.logger.info(`Cleaned ${cleaned} old reminders`)
    } catch (err: any) {
      this.ctx.services.logger.warn('Cleanup old reminders failed:', err?.message || err)
    }
    // 启动即扫描一次，随后每 30 秒扫描
    this.checkReminders()
    this.jobId = this.ctx.services.scheduler!.every(TICK_INTERVAL_MS, () => this.checkReminders())
  }

  stop(): void {
    if (this.jobId) {
      this.ctx.services.scheduler!.cancel(this.jobId)
      this.jobId = null
    }
  }

  private async checkReminders(): Promise<void> {
    try {
      const now = Math.floor(Date.now() / 1000)
      const calendar = getCalendarService(this.ctx)
      const due = calendar.listDueReminders(now)
      if (due.length === 0) return

      const settings = calendar.getSettings()

      for (const reminder of due) {
        const payload = reminder.payload || {}
        const title = payload.title || '日历提醒'
        const body = payload.body || ''
        // 用户禁用系统通知时，仍走 IPC 广播（前端弹 antd notification）
        if (!settings.enable_system_notification) {
          this.ctx.ipc.broadcast('notify', { title, body, clickTarget: payload.clickTarget, clickId: payload.clickId, source: 'calendar' })
        } else {
          this.ctx.services.notification!.notify({
            title,
            body,
            clickTarget: payload.clickTarget,
            clickId: payload.clickId,
            source: 'calendar',
          })
        }
        calendar.markReminderFired(reminder.id)
        // 提醒触发后检查重复事件/TODO 的未来提醒是否耗尽，滚动再生避免 90 天后静默消失
        try {
          calendar.ensureRemindersForRecurring(reminder.target_type, reminder.target_id)
        } catch (err: any) {
          this.ctx.services.logger.warn(`ensureRemindersForRecurring failed for ${reminder.target_type}:${reminder.target_id}:`, err?.message || err)
        }
      }
      this.ctx.services.logger.info(`Fired ${due.length} reminder(s)`)
    } catch (err: any) {
      this.ctx.services.logger.error('Scheduler tick error:', err?.message || err)
    }
  }
}

export default CalendarScheduler
