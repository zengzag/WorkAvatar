/**
 * 宿主通用通知通道。
 * 由宿主 NotificationService 推送（自动化任务完成、ask_user 交互等），
 * 日历提醒等插件通知经插件桥广播（plugin 事件），不再占用宿主通道。
 */
export const NOTIFY_CHANNELS = {
  /** 主进程 → 渲染进程：antd notification 展示载荷 */
  CALENDAR_NOTIFY: 'calendar:notify',
  /** 系统通知点击后主进程 → 渲染进程：跳转信息 */
  CALENDAR_NOTIFY_CLICK: 'calendar:notify-click',
  /** 渲染进程主动请求系统通知 */
  NOTIFY_SEND: 'notify:send',
} as const

export interface NotifyPayload {
  title: string
  body: string
  /** 点击通知后前端跳转目标（内核语义：automation/ask_user；命中插件 id 时跳插件页） */
  clickTarget?: string
  clickId?: string
  /** 静默：不弹 antd notification，仅写日志 */
  silent?: boolean
  /** 来源标记 */
  source?: string
  /** 渲染端可用 t() 本地化的文案键与参数 */
  i18nKey?: string
  i18nParams?: Record<string, string | number>
}
