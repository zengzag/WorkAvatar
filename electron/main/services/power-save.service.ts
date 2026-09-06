import { app, BrowserWindow, powerSaveBlocker } from 'electron'
import DatabaseService from './database.service'
import { createLogger } from './logger'

const logger = createLogger('PowerSave')

// settings 表中的配置键：应用窗口未全部关闭时禁止系统自动熄屏/休眠
export const PREVENT_SLEEP_SETTING_KEY = 'prevent_sleep_when_foreground'

/**
 * 窗口防休眠服务：开启后，只要应用仍存在开启的窗口（即使被其他窗口覆盖、不在前台），
 * 就通过 powerSaveBlocker 阻止系统自动关闭屏幕和进入休眠。
 * 窗口全部隐藏/关闭（仅剩托盘图标）时自动释放。
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
    // 窗口创建后监听显隐/关闭变化，重新评估是否需要保持唤醒（窗口焦点与否不再影响）
    app.on('browser-window-created', (_event, win) => {
      win.on('show', () => this.refresh())
      win.on('hide', () => this.refresh())
      win.on('minimize', () => this.refresh())
      win.on('restore', () => this.refresh())
      win.on('closed', () => this.refresh())
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
      // 未配置过时默认开启
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

  /** 是否存在仍开启的窗口：窗口可见（即使失焦/被覆盖/最小化）即视为开启，全部隐藏（仅剩托盘图标）时返回 false */
  private hasOpenWindow(): boolean {
    return BrowserWindow.getAllWindows().some(
      (win) => !win.isDestroyed() && win.isVisible()
    )
  }

  private refresh(): void {
    const shouldBlock = this.enabled && this.hasOpenWindow()
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