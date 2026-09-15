import { useEffect } from 'react'
import { App, Button } from 'antd'
import { useTranslation } from 'react-i18next'

/** 宿主通用通知载荷（自动化完成 / ask_user 交互等） */
export interface NotifyPayload {
  title: string
  body: string
  clickTarget?: string
  clickId?: string
  silent?: boolean
  source?: string
  i18nKey?: string
  i18nTitleKey?: string
  i18nParams?: Record<string, string | number>
}

/** 系统通知点击时由主进程推送的载荷（仅含跳转信息） */
export interface NotifyClickPayload {
  target?: string
  id?: string
}

/**
 * 监听宿主通用通知（主进程 NOTIFY 事件）：
 * - 主窗口激活时由主进程推送，渲染进程用 antd notification 展示
 * - 如果 payload 含 i18nKey / i18nTitleKey，则用 t() 本地化正文与标题；否则直接使用原文
 * - 来源为插件（source = plugin:<id>）时以插件命名空间解析文案键
 * - 点击通知 → 通过 onClick 回调让外层跳转目标
 * （插件通知已由插件内部展示，不经过本 hook）
 */
export function useNotification(onClick?: (payload: NotifyPayload) => void): void {
  const { t } = useTranslation()
  // 必须用 App 上下文的实例：antd 静态 notification.open 不消费 ConfigProvider 主题，暗色下会渲染成白底
  const { notification } = App.useApp()

  useEffect(() => {
    const unsubscribe = window.electronAPI.notification.onNotify((payload: NotifyPayload) => {
      const key = `notify-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
      // 插件通知的文案键位于插件命名空间（plugin:<id>）
      const pluginId = payload?.source?.startsWith('plugin:') ? payload.source.slice('plugin:'.length) : undefined
      const localize = (textKey?: string, fallback?: string): string => {
        if (!textKey) return fallback || ''
        return String(t(textKey, {
          ...(payload?.i18nParams || {}),
          defaultValue: fallback || textKey,
          ...(pluginId ? { ns: pluginId } : {}),
        }))
      }
      const displayTitle = localize(payload?.i18nTitleKey, payload?.title) || payload?.title
      const displayBody = localize(payload?.i18nKey, payload?.body)
      const btn = (
        <Button
          type="link"
          size="small"
          onClick={() => {
            onClick?.(payload)
            notification.destroy(key)
          }}
        >
          {t('common.view')}
        </Button>
      )
      notification.open({
        key,
        title: displayTitle,
        description: displayBody,
        actions: btn,
        duration: 8,
        onClick: () => onClick?.(payload),
        placement: 'topRight',
      })
    })
    return () => { unsubscribe() }
  }, [t, onClick, notification])
}

/**
 * 监听宿主系统通知点击（主进程 NOTIFY_CLICK 事件）。
 * 用于在系统通知点击时跳转到对应页面。
 */
export function useNotificationClick(onClick?: (payload: NotifyClickPayload) => void): void {
  useEffect(() => {
    if (!onClick) return
    const unsubscribe = window.electronAPI.notification.onNotifyClick((payload: NotifyClickPayload) => {
      onClick(payload)
    })
    return () => { unsubscribe() }
  }, [onClick])
}