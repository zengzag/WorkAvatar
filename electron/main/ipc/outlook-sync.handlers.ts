/**
 * 日历 Outlook 同步 IPC handlers。
 *
 * 登录/登出、状态查询、同步配置读写、手动触发同步。
 * 同步状态变化通过 CALENDAR_OUTLOOK_SYNC_CHANGED 推送。
 */

import { IPC_CHANNELS } from '../../shared/ipc-channels'
import type { OutlookSyncConfig } from '../../shared/ipc-channels'
import OutlookAuthService from '../services/calendar/outlook-auth.service'
import OutlookSyncService from '../services/calendar/outlook-sync.service'
import { safeHandle } from './_shared'

export function registerOutlookSyncHandlers(): void {
  const auth = OutlookAuthService.getInstance()
  const sync = OutlookSyncService.getInstance()

  safeHandle(IPC_CHANNELS.CALENDAR_OUTLOOK_LOGIN, async () => {
    const result = await auth.login()
    if ('error' in result && result.error) return { error: result.error }
    // 登录成功后立即触发一次全量同步
    sync.runSync().catch(() => { /* ignore */ })
    return sync.getStatus()
  })

  safeHandle(IPC_CHANNELS.CALENDAR_OUTLOOK_LOGOUT, () => {
    auth.logout()
    sync.onLogout()
    return sync.getStatus()
  })

  safeHandle(IPC_CHANNELS.CALENDAR_OUTLOOK_STATUS, () => {
    return sync.getStatus()
  })

  safeHandle(IPC_CHANNELS.CALENDAR_OUTLOOK_SET_CONFIG, (params: Partial<OutlookSyncConfig>) => {
    sync.setConfig(params || {})
    return sync.getStatus()
  })

  safeHandle(IPC_CHANNELS.CALENDAR_OUTLOOK_SYNC_NOW, async () => {
    return sync.syncNow()
  })
}
