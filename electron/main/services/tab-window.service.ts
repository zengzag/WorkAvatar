import { BrowserWindow, app } from 'electron'
import path from 'path'
import { createLogger } from './logger'
import { IPC_CHANNELS } from '../../shared/ipc-channels'

const logger = createLogger('TabWindow')

/** 可分离为独立窗口的 tab key（与 NavItemKey 对齐，排除 settings） */
export const DETACHABLE_TABS = ['tasks', 'employees', 'kms', 'voice', 'calendar', 'notes', 'automation'] as const
export type DetachableTab = typeof DETACHABLE_TABS[number]

function isDetachable(tabKey: string): tabKey is DetachableTab {
  return (DETACHABLE_TABS as readonly string[]).includes(tabKey)
}

/**
 * Tab 独立窗口管理器：
 * - 每个 tabKey 同时只允许一个独立窗口（单窗口独占，避免数据竞争）
 * - 主窗口通过订阅 TAB_WINDOW_DETACHED_CHANGED 接收 detached 状态变化
 * - 独立窗口关闭时自动通知主窗口解锁对应 tab
 * - 主窗口关闭时联动关闭所有独立窗口
 */
class TabWindowService {
  private static instance: TabWindowService
  /** tabKey → 独立窗口 */
  private windows = new Map<string, BrowserWindow>()
  /** 主窗口引用（用于推送 detached 状态变化） */
  private mainWindow: BrowserWindow | null = null

  private constructor() {}

  static getInstance(): TabWindowService {
    if (!TabWindowService.instance) {
      TabWindowService.instance = new TabWindowService()
    }
    return TabWindowService.instance
  }

  setMainWindow(win: BrowserWindow | null): void {
    this.mainWindow = win
  }

  private getPreloadPath(): string {
    const isDev = !app.isPackaged
    if (isDev) {
      return path.join(process.cwd(), 'dist-electron', 'preload', 'index.js')
    }
    return path.join(__dirname, '..', 'preload', 'index.js')
  }

  private loadTabUrl(win: BrowserWindow, tabKey: string): void {
    const isDev = !app.isPackaged
    if (isDev) {
      win.loadURL(`http://localhost:5173/#/window/${tabKey}`)
    } else {
      // loadFile 的 hash 选项自动加 # 前缀，需带前导 / 匹配 createHashRouter
      win.loadFile(path.join(__dirname, '..', '..', 'dist', 'index.html'), { hash: `/window/${tabKey}` })
    }
  }

  private getAppIconPath(): string {
    const isDev = !app.isPackaged
    const res = (p: string[]) => (isDev ? path.join(process.cwd(), ...p) : path.join(process.resourcesPath, ...p))
    if (process.platform === 'win32') return res(['resources', 'icons', 'icon.ico'])
    if (process.platform === 'darwin') return res(['resources', 'icons', 'icon.icns'])
    return res(['resources', 'icons', 'icon.png'])
  }

  /** 推送 detached tabs 列表给主窗口 */
  private notifyDetachedChange(): void {
    if (this.mainWindow && !this.mainWindow.isDestroyed()) {
      this.mainWindow.webContents.send(IPC_CHANNELS.TAB_WINDOW_DETACHED_CHANGED, Array.from(this.windows.keys()))
    }
  }

  /** 打开（或聚焦已存在的）tab 独立窗口 */
  openTabWindow(tabKey: string): { success: boolean; error?: string } {
    if (!isDetachable(tabKey)) {
      return { success: false, error: `Tab "${tabKey}" is not detachable` }
    }

    const existing = this.windows.get(tabKey)
    if (existing && !existing.isDestroyed()) {
      if (existing.isMinimized()) existing.restore()
      existing.show()
      existing.focus()
      return { success: true }
    }

    const win = new BrowserWindow({
      title: 'WorkAvatar',
      width: 1080,
      height: 720,
      minWidth: 720,
      minHeight: 480,
      icon: this.getAppIconPath(),
      webPreferences: {
        preload: this.getPreloadPath(),
        nodeIntegration: false,
        contextIsolation: true,
        webSecurity: true,
      },
      autoHideMenuBar: true,
      frame: false,
      show: false,
    })

    this.windows.set(tabKey, win)

    win.on('ready-to-show', () => {
      win.show()
    })

    // 用户关闭独立窗口 = 自动回归主窗口
    win.on('closed', () => {
      this.windows.delete(tabKey)
      this.notifyDetachedChange()
    })

    // 失焦/获焦时同步暂停/恢复 KMS 自动索引（与主窗口行为一致）
    win.on('blur', () => {
      try {
        require('./kms/kms-index-manager.service').default.getInstance().pauseAutoIndex()
      } catch { /* ignore */ }
    })
    win.on('focus', () => {
      try {
        require('./kms/kms-index-manager.service').default.getInstance().resumeAutoIndex()
      } catch { /* ignore */ }
    })

    win.webContents.setWindowOpenHandler((details) => {
      require('electron').shell.openExternal(details.url)
      return { action: 'deny' }
    })

    this.loadTabUrl(win, tabKey)

    this.notifyDetachedChange()
    logger.info(`Tab window opened: ${tabKey}`)
    return { success: true }
  }

  /** 主动关闭 tab 独立窗口（回归主窗口） */
  closeTabWindow(tabKey: string): void {
    const win = this.windows.get(tabKey)
    if (win && !win.isDestroyed()) {
      win.destroy()
    }
    // closed 事件会清理 map + notify，这里无需重复
  }

  /** 获取当前已分离的 tab key 列表 */
  getDetachedTabs(): string[] {
    return Array.from(this.windows.keys())
  }

  /** 聚焦指定 tab 的独立窗口（若存在） */
  focusTabWindow(tabKey: string): boolean {
    const win = this.windows.get(tabKey)
    if (!win || win.isDestroyed()) return false
    if (win.isMinimized()) win.restore()
    win.show()
    win.focus()
    return true
  }

  /** 主窗口关闭时联动关闭所有独立窗口 */
  closeAll(): void {
    for (const [, win] of this.windows) {
      if (!win.isDestroyed()) win.destroy()
    }
    this.windows.clear()
  }
}

export default TabWindowService
