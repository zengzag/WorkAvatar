import { app, BrowserWindow, powerSaveBlocker } from 'electron'
import DatabaseService from './database.service'
import { createLogger } from './logger'

const logger = createLogger('PowerSave')

// settings 表中的配置键：应用处于前台时禁止系统自动熄屏/休眠
export const PREVENT_SLEEP_SETTING_KEY = 'prevent_sleep_when_foreground'

/**
 * 前台防休眠服务：开启后，只要应用存在可见且聚焦的窗口，
 * 就通过 powerSaveBlocker 阻止系统自动关闭屏幕和进入休眠。
 * 窗口最小化、隐藏（关闭到托盘）或失焦时自动释放。
 */
class PowerSaveService {
  private static instance: PowerSaveService
  private blockerId: number | null = null
  private enabled = false

  static getInstance(): PowerSaveService {
    if (!PowerSaveService.instance) {
      PowerSaveService.instance = new PowerSaveService()
    }
    return PowerSaveService.instance
  }

  init(): void {
    this.enabled = this.readEnabled()
    // 窗口焦点/可见性变化时重新评估是否需要保持唤醒
    app.on('browser-window-focus', () => this.refresh())
    app.on('browser-window-blur', () => this.refresh())
    app.on('browser-window-created', (_event, win) => {
      win.on('show', () => this.refresh())
      win.on('hide', () => this.refresh())
      win.on('minimize', () => this.refresh())
      win.on('restore', () => this.refresh())
    })
    this.refresh()
  }

  setEnabled(enabled: boolean): void {
    if (this.enabled === enabled) return
    this.enabled = enabled
    this.writeEnabled(enabled)
    this.refresh()
  }

  getEnabled(): boolean {
    return this.enabled
  }

  /** 应用退出前释放 powerSaveBlocker */
  shutdown(): void {
    if (this.blockerId !== null) {
      powerSaveBlocker.stop(this.blockerId)
      this.blockerId = null
    }
  }

  private readEnabled(): boolean {
    try {
      const row = DatabaseService.getInstance()
        .getDb()
        .prepare('SELECT value FROM settings WHERE key = ?')
        .get(PREVENT_SLEEP_SETTING_KEY) as { value: string } | undefined
      // 未配置过时默认开启，符合"前台防休眠"的产品预期
      return row?.value !== '0'
    } catch {
      return true
    }
  }

  private writeEnabled(enabled: boolean): void {
    try {
      DatabaseService.getInstance()
        .getDb()
        .prepare(
          'INSERT INTO settings (key, value, updated_at) VALUES (?, ?, unixepoch()) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at'
        )
        .run(PREVENT_SLEEP_SETTING_KEY, enabled ? '1' : '0')
    } catch (err: any) {
      logger.warn('Failed to persist prevent-sleep setting:', err?.message || err)
    }
  }

  /** 是否存在可见且聚焦的前台窗口（最小化/隐藏/失焦均视为不在前台） */
  private hasForegroundWindow(): boolean {
    return BrowserWindow.getAllWindows().some(
      (win) => !win.isDestroyed() && win.isVisible() && win.isFocused() && !win.isMinimized()
    )
  }

  private refresh(): void {
    const shouldBlock = this.enabled && this.hasForegroundWindow()
    if (shouldBlock && this.blockerId === null) {
      // prevent-display-sleep：同时阻止屏幕关闭与系统休眠
      this.blockerId = powerSaveBlocker.start('prevent-display-sleep')
      logger.info('Power save blocker started (prevent-display-sleep)')
    } else if (!shouldBlock && this.blockerId !== null) {
      powerSaveBlocker.stop(this.blockerId)
      this.blockerId = null
      logger.info('Power save blocker stopped')
    }
  }
}

export default PowerSaveService
