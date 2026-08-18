import { BrowserWindow, Notification, ipcMain } from 'electron'
import { IPC_CHANNELS } from '../../shared/ipc-channels'
import { createLogger } from './logger'
import PluginHostService from './plugin/plugin-host.service'

const logger = createLogger('Notification')

export interface NotifyPayload {
  title: string
  body: string
  /** 点击通知后前端跳转目标 */
  clickTarget?: 'event' | 'todo' | 'calendar' | 'ask_user' | 'automation'
  clickId?: string
  /** 静默：不弹 antd notification，仅写日志（如批量提醒去重时） */
  silent?: boolean
  /** 来源标记：`plugin:<id>` 表示插件通知（渲染端经插件桥路由），其余为宿主通知 */
  source?: string
  /** 渲染端可用 t() 本地化的文案键与参数（插件通知透传） */
  i18nKey?: string
  i18nParams?: Record<string, string | number>
}

/** 从 source 解析插件 id：`plugin:<id>` → id，否则 null */
function pluginIdFromSource(source?: string): string | null {
  if (!source || !source.startsWith('plugin:')) return null
  const id = source.slice('plugin:'.length)
  return id || null
}

/**
 * 应用通知服务：
 * - 主窗口失焦或最小化时：使用 Electron 系统通知（OS 级）
 * - 主窗口激活时：通过 IPC 推 CALENDAR_NOTIFY 事件给渲染进程，由 antd notification 显示
 * - 通知点击：聚焦主窗口 + 推 CALENDAR_NOTIFY_CLICK 让前端跳转
 *
 * 同时被日历提醒调度器、ask_user 工具共用。
 */
class NotificationService {
  private static instance: NotificationService
  private mainWindow: BrowserWindow | null = null
  private ipcRegistered = false

  private constructor() {}

  static getInstance(): NotificationService {
    if (!NotificationService.instance) {
      NotificationService.instance = new NotificationService()
    }
    return NotificationService.instance
  }

  setMainWindow(win: BrowserWindow | null): void {
    this.mainWindow = win
  }

  /** 主窗口当前是否处于"用户可见但未激活"状态——需要弹系统通知的判定依据 */
  isMainWindowInactive(): boolean {
    if (!this.mainWindow || this.mainWindow.isDestroyed()) return true
    // isFocused 表示窗口正在前台接收输入；隐藏 / 最小化 / 失焦都视为 inactive
    if (!this.mainWindow.isVisible()) return true
    if (this.mainWindow.isMinimized()) return true
    return !this.mainWindow.isFocused()
  }

  /**
   * 发送通知。返回是否实际发出。
   * - 主窗口未激活：弹系统通知
   * - 主窗口激活：仅推事件给渲染进程（宿主通知走 CALENDAR_NOTIFY；插件通知经插件桥广播 'notify'）
   * - 启用系统通知被关闭时，仍走 IPC 通道（前端弹 antd notification）
   */
  notify(payload: NotifyPayload): boolean {
    if (!payload || !payload.title) return false
    this.ensureIpcRegistered()

    const pluginId = pluginIdFromSource(payload.source)
    const inactive = this.isMainWindowInactive()
    const shouldUseSystem = inactive && Notification.isSupported()

    if (shouldUseSystem) {
      try {
        const n = new Notification({
          title: payload.title,
          body: payload.body,
          silent: payload.silent === true,
        })
        n.on('click', () => {
          this.focusMainWindow()
          this.broadcastClick(payload)
        })
        n.show()
        logger.info(`System notification shown: ${payload.title}`)
        return true
      } catch (err: any) {
        logger.warn('System notification failed, fallback to IPC:', err?.message || err)
      }
    }

    // 推送给渲染进程（主窗口激活或系统通知失败时）
    try {
      if (pluginId) {
        // 插件通知：经插件桥广播到插件渲染端（主窗口 + 独立窗口），由插件渲染端展示 antd notification
        PluginHostService.getInstance().broadcast(pluginId, 'notify', payload)
      } else if (this.mainWindow && !this.mainWindow.isDestroyed()) {
        this.mainWindow.webContents.send(IPC_CHANNELS.CALENDAR_NOTIFY, payload)
      }
    } catch (err: any) {
      logger.warn('IPC notify failed:', err?.message || err)
    }
    return true
  }

  /** 聚焦主窗口（系统通知点击时调用） */
  focusMainWindow(): void {
    if (!this.mainWindow || this.mainWindow.isDestroyed()) return
    if (this.mainWindow.isMinimized()) this.mainWindow.restore()
    this.mainWindow.show()
    this.mainWindow.focus()
  }

  private broadcastClick(payload: NotifyPayload): void {
    try {
      const pluginId = pluginIdFromSource(payload.source)
      const clickData = { target: payload.clickTarget, id: payload.clickId }
      if (pluginId) {
        PluginHostService.getInstance().broadcast(pluginId, 'notify-click', clickData)
        return
      }
      if (this.mainWindow && !this.mainWindow.isDestroyed()) {
        this.mainWindow.webContents.send(IPC_CHANNELS.CALENDAR_NOTIFY_CLICK, clickData)
      }
    } catch (err: any) {
      logger.warn('Broadcast click failed:', err?.message || err)
    }
  }

  private ensureIpcRegistered(): void {
    if (this.ipcRegistered) return
    this.ipcRegistered = true
    // 渲染进程主动请求系统通知（如前端在某些场景下也想触发系统通知）
    ipcMain.handle(IPC_CHANNELS.NOTIFY_SEND, (_event, payload: NotifyPayload) => {
      this.notify(payload)
      return { ok: true }
    })
  }
}

export default NotificationService