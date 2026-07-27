import { BrowserWindow } from 'electron'
import CalendarService from './calendar.service'
import NotificationService from '../notification.service'
import { createLogger } from '../logger'
import { ScheduledTaskBase } from '../scheduled-task-base'

const logger = createLogger('CalendarScheduler')

const TICK_INTERVAL_MS = 30_000

/**
 * 日历提醒调度器：每 30 秒扫描一次 calendar_reminders 表，
 * 将到期未触发的提醒通过 NotificationService 推送出去，并落 fired_at 防重。
 *
 * 启动时清理 7 天前已 fired 的提醒，避免表无限膨胀。
 */
class CalendarSchedulerService extends ScheduledTaskBase {
  private static instance: CalendarSchedulerService

  private constructor() {
    super('CalendarScheduler', TICK_INTERVAL_MS)
  }

  static getInstance(): CalendarSchedulerService {
    if (!CalendarSchedulerService.instance) {
      CalendarSchedulerService.instance = new CalendarSchedulerService()
    }
    return CalendarSchedulerService.instance
  }

  start(): void {
    try {
      const cleaned = CalendarService.getInstance().cleanupOldReminders()
      if (cleaned > 0) logger.info(`Cleaned ${cleaned} old reminders`)
    } catch (err: any) {
      logger.warn('Cleanup old reminders failed:', err?.message || err)
    }
    super.start()
  }

  protected async runCheck(): Promise<void> {
    try {
      const now = Math.floor(Date.now() / 1000)
      const calendar = CalendarService.getInstance()
      const due = calendar.listDueReminders(now)
      if (due.length === 0) return

      const notifier = NotificationService.getInstance()
      const settings = calendar.getSettings()

      for (const reminder of due) {
        const payload = reminder.payload || {}
        const title = payload.title || '日历提醒'
        const body = payload.body || ''
        // 用户禁用系统通知时，仍走 IPC（前端弹 antd notification）
        if (!settings.enable_system_notification) {
          this.pushToRenderer({ title, body, clickTarget: payload.clickTarget, clickId: payload.clickId, source: 'calendar' })
        } else {
          notifier.notify({
            title,
            body,
            clickTarget: payload.clickTarget,
            clickId: payload.clickId,
            source: 'calendar',
          })
        }
        calendar.markReminderFired(reminder.id)
      }
      logger.info(`Fired ${due.length} reminder(s)`)
    } catch (err: any) {
      logger.error('Scheduler tick error:', err?.message || err)
    }
  }

  private pushToRenderer(payload: { title: string; body: string; clickTarget?: string; clickId?: string; source?: string }): void {
    const windows = BrowserWindow.getAllWindows()
    for (const win of windows) {
      if (!win.isDestroyed()) {
        try {
          win.webContents.send('calendar:notify', payload)
        } catch { /* ignore */ }
      }
    }
  }
}

export default CalendarSchedulerService
