/**
 * calendar 插件渲染端入口
 */
import { Button, notification } from 'antd'
import { setBridge, setHostI18n, cal, hostT } from './store'
import CalendarPage from './CalendarPage'
import type { PluginRendererEntry, PluginRendererHost } from '../../../plugin-sdk/src/renderer'
import type { NotifyPayload } from './types'

/** 全局日历提醒：仅主窗口订阅（独立窗口不重复弹），展示 antd notification + 点击跳转日历页 */
function setupGlobalNotify(): () => void {
  let disposed = false
  const disposeCallbacks: Array<() => void> = []
  const navigateToCalendar = () => {
    // hash 路由：跳转到插件日历页
    window.location.hash = '#/plugin/calendar'
  }
  // 独立窗口不展示全局提醒（主窗口已展示）
  window.electronAPI.tabWindow.getOwnTab().then((ownTab) => {
    if (disposed || ownTab) return
    disposeCallbacks.push(cal.onNotify((payload: NotifyPayload) => {
      const key = `cal-notify-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
      const i18nKey = (payload as any)?.i18nKey as string | undefined
      const displayBody: string = i18nKey
        ? String(hostT(i18nKey, { ...((payload as any).i18nParams || {}), defaultValue: payload.body }))
        : payload.body
      const btn = (
        <Button
          type="link"
          size="small"
          onClick={() => {
            navigateToCalendar()
            notification.destroy(key)
          }}
        >
          {hostT('calendar.reminderClickToView')}
        </Button>
      )
      notification.open({
        key,
        message: payload.title,
        description: displayBody,
        btn,
        duration: 8,
        onClick: () => navigateToCalendar(),
        placement: 'topRight',
      })
    }))
    disposeCallbacks.push(cal.onNotifyClick(() => navigateToCalendar()))
  })
  return () => {
    disposed = true
    disposeCallbacks.forEach((fn) => fn())
  }
}

let disposeNotify: (() => void) | null = null

const entry: PluginRendererEntry = {
  routes: [{ path: '', component: CalendarPage }],

  init(host: PluginRendererHost): void {
    setBridge(host.bridge)
    setHostI18n(host.i18n.t)
    disposeNotify = setupGlobalNotify()
  },

  dispose(): void {
    disposeNotify?.()
    disposeNotify = null
  },
}

export default entry
