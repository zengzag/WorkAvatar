import { useEffect } from 'react'
import { notification, Button } from 'antd'
import { useTranslation } from 'react-i18next'
import type { NotifyPayload } from '../types/calendar'

/** 系统通知点击时由主进程推送的载荷（仅含跳转信息） */
export interface NotifyClickPayload {
  target?: string
  id?: string
}

/**
 * 监听主进程的 CALENDAR_NOTIFY 事件：
 * - 主窗口激活时由主进程推送，渲染进程用 antd notification 展示
 * - 如果 payload 含 i18nKey，则用 t() 本地化 body；否则直接使用 body
 * - 点击通知 → 通过 onClick 回调让外层跳转目标
 */
export function useCalendarNotify(onClick?: (payload: NotifyPayload) => void): void {
  const { t } = useTranslation()

  useEffect(() => {
    const unsubscribe = window.electronAPI.calendar.onNotify((payload: NotifyPayload) => {
      const key = `cal-notify-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
      // 如果携带 i18n key，使用 t() 本地化展示文案
      const i18nKey = (payload as any)?.i18nKey as string | undefined
      const displayBody: string = i18nKey
        ? String(t(i18nKey, { ...(payload as any).i18nParams, defaultValue: payload.body }))
        : payload.body
      const btn = (
        <Button
          type="link"
          size="small"
          onClick={() => {
            onClick?.(payload)
            notification.destroy(key)
          }}
        >
          {t('calendar.reminderClickToView')}
        </Button>
      )
      notification.open({
        key,
        message: payload.title,
        description: displayBody,
        btn,
        duration: 8,
        onClick: () => onClick?.(payload),
        placement: 'topRight',
      })
    })
    return () => { unsubscribe() }
  }, [t, onClick])
}

/**
 * 监听 CALENDAR_NOTIFY_CLICK 事件（由主进程在系统通知被点击后推送）。
 * 用于在系统通知点击时跳转到对应日程/TODO。
 */
export function useCalendarNotifyClick(onClick?: (payload: NotifyClickPayload) => void): void {
  useEffect(() => {
    if (!onClick) return
    const unsubscribe = window.electronAPI.calendar.onNotifyClick((payload: NotifyClickPayload) => {
      onClick(payload)
    })
    return () => { unsubscribe() }
  }, [onClick])
}
