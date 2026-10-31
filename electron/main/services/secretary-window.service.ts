import { BrowserWindow, Menu, app, globalShortcut, ipcMain, screen } from 'electron'
import path from 'path'
import DatabaseService from './database.service'
import { createLogger } from './logger'
import mainUiI18n from './ui-i18n.service'
import { IPC_CHANNELS } from '../../shared/ipc-channels'
import {
  DEFAULT_SECRETARY_SETTINGS,
  isSecretaryCharacterId,
  type SecretaryRuntimeState,
  type SecretarySettings,
  type SecretarySide,
} from '../../shared/channels/secretary'

const logger = createLogger('Secretary')

/** settings 表中的持久化键 */
const SETTINGS_KEY = 'secretary_settings'
const POSITION_KEY = 'secretary_pet_position'

/** 面板固定宽度；高度由面板内容上报（clamp 后生效） */
const PANEL_WIDTH = 372
/** 首帧高度取小一点，等渲染端上报真实内容高度再调整，避免开面板瞬间留一大片透明空区 */
const DEFAULT_PANEL_HEIGHT = 300
const MIN_PANEL_HEIGHT = 240
const MAX_PANEL_HEIGHT = 720

/** 挂件窗口在挂件四周预留的透明区域：气泡与通知需要空间 */
const PET_PADDING_X = 140
const PET_PADDING_Y = 110
/** 气泡最大宽度（与 secretary.css 中 .pet-bubble 的 max-width 一致） */
const BUBBLE_MAX_WIDTH = 220
/** 挂件在窗口内距右下角的间距（必须与 secretary.css 中 .pet-anchor 的 right/bottom 一致） */
const PET_ANCHOR_GAP = 12
/** 挂件本体距屏幕边缘的留白 */
const EDGE_MARGIN = 12
/** 挂件边到屏幕边小于该距离才吸附，避免“一拖就贴边” */
const SNAP_DISTANCE = 48

const clamp = (v: number, min: number, max: number) => Math.min(Math.max(v, min), max)

/**
 * 小秘书浮窗服务：
 * - 挂件窗：透明置顶无任务栏，四态表情 + 气泡；透明区域点击穿透（forward 模式）
 * - 面板窗：贴挂件弹出，承载员工切换 / 任务清单 / 发任务 / 权限确认
 * - 两个窗口都加载宿主渲染端路由（/secretary/pet、/secretary/panel），复用主题、i18n 与全部 IPC
 */
class SecretaryWindowService {
  private static instance: SecretaryWindowService

  private mainWindow: BrowserWindow | null = null
  private petWin: BrowserWindow | null = null
  private panelWin: BrowserWindow | null = null
  private panelHeight = DEFAULT_PANEL_HEIGHT
  private settings: SecretarySettings = { ...DEFAULT_SECRETARY_SETTINGS }
  private position: { x: number; y: number } | null = null
  private ipcReady = false
  private registeredHotkey: string | null = null
  /** 拖动起点：光标屏幕坐标 + 窗口坐标 */
  private dragOrigin: { cursorX: number; cursorY: number; winX: number; winY: number } | null = null
  /** 挂件靠屏幕哪一侧（决定窗口留白与气泡方向） */
  private side: SecretarySide = 'right'
  /** 挂件窗当前是否忽略鼠标（透明区域穿透） */
  private ignoreMouse = true
  private cursorTimer: NodeJS.Timeout | null = null
  /** 启用状态变化回调（主进程用它刷新托盘菜单文案） */
  private stateListener: (() => void) | null = null

  static getInstance(): SecretaryWindowService {
    if (!SecretaryWindowService.instance) {
      SecretaryWindowService.instance = new SecretaryWindowService()
    }
    return SecretaryWindowService.instance
  }

  getSettings(): SecretarySettings {
    return { ...this.settings }
  }

  isPanelOpen(): boolean {
    return !!this.panelWin && !this.panelWin.isDestroyed() && this.panelWin.isVisible()
  }

  init(mainWindow: BrowserWindow): void {
    this.mainWindow = mainWindow
    this.loadPersisted()
    this.registerIpc()
    if (this.settings.enabled) {
      this.ensurePetWindow()
      this.registerHotkey()
    }
  }

  /** 托盘菜单 / 主窗口入口 */
  togglePanel(): void {
    if (!this.settings.enabled) return
    if (this.isPanelOpen()) this.hidePanel()
    else this.showPanel()
  }

  showPanel(): void {
    const win = this.ensurePanelWindow()
    if (!win) return
    // 首次打开时等首帧渲染完再显示，避免出现空白窗口
    const reveal = () => {
      if (win.isDestroyed()) return
      this.placePanel()
      win.show()
      win.focus()
      this.notifyPanelVisibility()
    }
    if (win.webContents.isLoading()) {
      win.once('ready-to-show', reveal)
    } else {
      reveal()
    }
  }

  hidePanel(): void {
    if (!this.panelWin || this.panelWin.isDestroyed()) return
    this.panelWin.hide()
    this.notifyPanelVisibility()
  }

  setSettings(patch: Partial<SecretarySettings>): SecretarySettings {
    const prev = this.settings
    this.settings = { ...this.settings, ...patch }
    // size / opacity / dnd / employeeId / character 属于渲染端偏好；enabled 与 hotkey 需要主进程生效
    this.settings.size = clamp(Math.round(this.settings.size || DEFAULT_SECRETARY_SETTINGS.size), 64, 192)
    this.settings.opacity = clamp(this.settings.opacity || 1, 0.4, 1)
    if (!isSecretaryCharacterId(this.settings.character)) {
      this.settings.character = DEFAULT_SECRETARY_SETTINGS.character
    }
    this.persistSettings()

    if (prev.enabled !== this.settings.enabled) {
      if (this.settings.enabled) {
        this.ensurePetWindow()
        this.registerHotkey()
      } else {
        this.unregisterHotkey()
        this.destroyWindows()
      }
    } else if (this.settings.enabled) {
      if (prev.size !== this.settings.size) this.applyPetSize()
      if (prev.hotkey !== this.settings.hotkey) this.registerHotkey()
    }
    this.broadcastState()
    this.stateListener?.()
    return this.getSettings()
  }

  setStateListener(fn: (() => void) | null): void {
    this.stateListener = fn
  }

  /** 打开主窗口的「设置 → 小秘书」 */
  openSettings(): void {
    if (!this.mainWindow || this.mainWindow.isDestroyed()) return
    if (this.mainWindow.isMinimized()) this.mainWindow.restore()
    this.mainWindow.show()
    this.mainWindow.focus()
    this.mainWindow.webContents.send(IPC_CHANNELS.SECRETARY_OPEN_SETTINGS)
  }

  dispose(): void {
    this.unregisterHotkey()
    this.destroyWindows()
  }

  /* ================= 窗口 ================= */

  private getPreloadPath(): string {
    return app.isPackaged
      ? path.join(__dirname, '..', 'preload', 'index.js')
      : path.join(process.cwd(), 'dist-electron', 'preload', 'index.js')
  }

  private loadRoute(win: BrowserWindow, route: string): void {
    if (app.isPackaged) {
      win.loadFile(path.join(__dirname, '..', '..', 'dist', 'index.html'), { hash: route })
    } else {
      win.loadURL(`http://localhost:5173/#${route}`)
    }
  }

  private petWindowSize(): { width: number; height: number } {
    // 挂件越小，单侧留白要越大，否则气泡（max 220px）会被窗口边界裁掉
    const padX = Math.max(PET_PADDING_X, BUBBLE_MAX_WIDTH + 8 - this.settings.size)
    return {
      // 左右留白对称：挂件水平居中，贴左/贴右只翻气泡方向，窗口位置不用跟着重算
      width: this.settings.size + padX * 2,
      height: this.settings.size + PET_PADDING_Y,
    }
  }

  /** 挂件本体在窗口内的偏移（左上角相对窗口左上角） */
  private petInset(): { left: number; top: number } {
    const { width, height } = this.petWindowSize()
    return {
      left: (width - this.settings.size) / 2,
      top: height - PET_ANCHOR_GAP - this.settings.size,
    }
  }

  /** 由窗口 bounds 反推挂件本体在屏幕上的矩形 */
  private petRect(bounds: Electron.Rectangle): Electron.Rectangle {
    const inset = this.petInset()
    return {
      x: bounds.x + inset.left,
      y: bounds.y + inset.top,
      width: this.settings.size,
      height: this.settings.size,
    }
  }

  /** 把挂件本体放到指定屏幕位置（反算窗口位置） */
  private movePetTo(petLeft: number, petTop: number): void {
    if (!this.petWin || this.petWin.isDestroyed()) return
    const inset = this.petInset()
    const x = Math.round(petLeft - inset.left)
    const y = Math.round(petTop - inset.top)
    this.petWin.setPosition(x, y)
    this.position = { x, y }
    if (this.isPanelOpen()) this.placePanel()
  }

  /** 挂件停在屏幕左半侧时，窗口留白与气泡一起翻到右侧 */
  private updateSide(area: Electron.Rectangle, petCenterX: number): void {
    const next: SecretarySide = petCenterX < area.x + area.width / 2 ? 'left' : 'right'
    if (next === this.side) return
    this.side = next
    if (this.petWin && !this.petWin.isDestroyed()) {
      this.petWin.webContents.send(IPC_CHANNELS.SECRETARY_SIDE_CHANGED, this.side)
    }
  }

  private notifySide(): void {
    if (this.petWin && !this.petWin.isDestroyed()) {
      this.petWin.webContents.send(IPC_CHANNELS.SECRETARY_SIDE_CHANGED, this.side)
    }
  }

  private defaultPosition(): { x: number; y: number } {
    const area = screen.getPrimaryDisplay().workArea
    const inset = this.petInset()
    // 默认让挂件本体落在右下角留白处，而不是让窗口贴边
    return {
      x: area.x + area.width - EDGE_MARGIN - this.settings.size - inset.left,
      y: area.y + area.height - EDGE_MARGIN - this.settings.size - inset.top,
    }
  }

  /** 位置落在哪块屏幕的工作区内（显示器被拔掉或挂件跑出屏幕时回退主屏） */
  private resolvePosition(): { x: number; y: number } {
    const fallback = this.defaultPosition()
    if (!this.position) return fallback
    const { width, height } = this.petWindowSize()
    const rect = { x: this.position.x, y: this.position.y, width, height }
    const area = screen.getDisplayMatching(rect).workArea
    // 用挂件本体判断是否还在屏内：窗口带 140px 透明留白，贴左边缘时窗口 x 会是负数
    const pet = this.petRect(rect)
    const visibleX = Math.min(pet.x + pet.width, area.x + area.width) - Math.max(pet.x, area.x)
    const visibleY = Math.min(pet.y + pet.height, area.y + area.height) - Math.max(pet.y, area.y)
    if (visibleX < 48 || visibleY < 48) return fallback
    const inset = this.petInset()
    return {
      x: Math.round(clamp(pet.x, area.x + EDGE_MARGIN, area.x + area.width - EDGE_MARGIN - pet.width) - inset.left),
      y: Math.round(clamp(pet.y, area.y + EDGE_MARGIN, area.y + area.height - EDGE_MARGIN - pet.height) - inset.top),
    }
  }

  private ensurePetWindow(): BrowserWindow {
    if (this.petWin && !this.petWin.isDestroyed()) return this.petWin
    const { width, height } = this.petWindowSize()
    const pos = this.resolvePosition()
    const win = new BrowserWindow({
      x: pos.x,
      y: pos.y,
      width,
      height,
      transparent: true,
      backgroundColor: '#00000000',
      frame: false,
      resizable: false,
      maximizable: false,
      minimizable: false,
      skipTaskbar: true,
      alwaysOnTop: true,
      hasShadow: false,
      show: false,
      webPreferences: {
        preload: this.getPreloadPath(),
        nodeIntegration: false,
        contextIsolation: true,
      },
    })
    win.setAlwaysOnTop(true, 'floating')
    win.once('ready-to-show', () => {
      win.showInactive()
      // 透明区域不拦截桌面点击；渲染端命中挂件本体时再临时关闭
      win.setIgnoreMouseEvents(true, { forward: true })
      this.ignoreMouse = true
      this.startCursorWatcher()
    })
    win.on('closed', () => {
      this.petWin = null
      this.hidePanel()
    })
    this.petWin = win
    this.loadRoute(win, '/secretary/pet')
    logger.info('Pet window created')
    return win
  }

  private ensurePanelWindow(): BrowserWindow | null {
    if (this.panelWin && !this.panelWin.isDestroyed()) return this.panelWin
    const win = new BrowserWindow({
      width: PANEL_WIDTH,
      height: this.panelHeight,
      transparent: true,
      backgroundColor: '#00000000',
      frame: false,
      resizable: false,
      maximizable: false,
      minimizable: false,
      skipTaskbar: true,
      alwaysOnTop: true,
      hasShadow: false,
      show: false,
      webPreferences: {
        preload: this.getPreloadPath(),
        nodeIntegration: false,
        contextIsolation: true,
      },
    })
    win.setAlwaysOnTop(true, 'floating')
    win.on('closed', () => {
      this.panelWin = null
      this.notifyPanelVisibility()
    })
    this.panelWin = win
    this.loadRoute(win, '/secretary/panel')
    logger.info('Panel window created')
    return win
  }

  /** 面板贴挂件弹出：挂件在右半屏时面板放左侧，反之放右侧；底边对齐挂件本体并夹在工作区内 */
  private placePanel(): void {
    const panel = this.panelWin
    if (!panel || panel.isDestroyed()) return
    const pet = this.petWin
    const petBounds = pet && !pet.isDestroyed()
      ? pet.getBounds()
      : { x: this.resolvePosition().x, y: this.resolvePosition().y, ...this.petWindowSize() }
    const area = screen.getDisplayMatching(petBounds).workArea
    // 以挂件本体为锚点：窗口比挂件大一圈，用窗口坐标会让面板偏离挂件
    const body = this.petRect(petBounds)
    const preferLeft = body.x + body.width / 2 > area.x + area.width / 2

    let x = preferLeft ? body.x - PANEL_WIDTH - 14 : body.x + body.width + 14
    if (x < area.x + 12 || x + PANEL_WIDTH > area.x + area.width - 12) {
      x = preferLeft ? body.x + body.width + 14 : body.x - PANEL_WIDTH - 14
    }
    x = clamp(x, area.x + 12, Math.max(area.x + 12, area.x + area.width - PANEL_WIDTH - 12))
    const y = clamp(
      body.y + body.height - this.panelHeight,
      area.y + 12,
      Math.max(area.y + 12, area.y + area.height - this.panelHeight - 12)
    )
    panel.setBounds({ x: Math.round(x), y: Math.round(y), width: PANEL_WIDTH, height: this.panelHeight })
  }

  private applyPetSize(): void {
    if (!this.petWin || this.petWin.isDestroyed()) return
    const { width, height } = this.petWindowSize()
    const bounds = this.petWin.getBounds()
    const area = screen.getDisplayMatching(bounds).workArea
    const oldPet = this.petRect(bounds)
    const size = this.settings.size
    // 缩放时保持挂件左上角不动（左右留白与顶部间距都是常量，挂件坐标不受尺寸影响），再夹回工作区
    const left = clamp(oldPet.x, area.x + EDGE_MARGIN, area.x + area.width - EDGE_MARGIN - size)
    const top = clamp(oldPet.y, area.y + EDGE_MARGIN, area.y + area.height - EDGE_MARGIN - size)
    this.petWin.setBounds({ x: bounds.x, y: bounds.y, width, height })
    this.updateSide(area, left + size / 2)
    this.movePetTo(left, top)
    this.persistPosition()
  }

  private destroyWindows(): void {
    if (this.cursorTimer) {
      clearInterval(this.cursorTimer)
      this.cursorTimer = null
    }
    if (this.panelWin && !this.panelWin.isDestroyed()) this.panelWin.destroy()
    if (this.petWin && !this.petWin.isDestroyed()) this.petWin.destroy()
    this.panelWin = null
    this.petWin = null
  }

  /**
   * 轮询光标位置切换鼠标穿透：
   * ignoreMouseEvents(true, { forward: true }) 只转发 mousemove，收不到拖拽事件，
   * 只靠渲染端悬停判定会导致「文件拖到挂件上直接穿透到桌面」。主进程轮询能覆盖拖拽场景。
   */
  private startCursorWatcher(): void {
    if (this.cursorTimer) return
    this.cursorTimer = setInterval(() => {
      const win = this.petWin
      if (!win || win.isDestroyed() || !win.isVisible()) return
      const body = this.petRect(win.getBounds())
      const p = screen.getCursorScreenPoint()
      const inside = p.x >= body.x && p.x <= body.x + body.width
        && p.y >= body.y && p.y <= body.y + body.height
      const nextIgnore = !inside
      if (nextIgnore === this.ignoreMouse) return
      this.ignoreMouse = nextIgnore
      win.setIgnoreMouseEvents(nextIgnore, { forward: true })
    }, 150)
    this.cursorTimer.unref?.()
  }

  private notifyPanelVisibility(): void {
    if (this.petWin && !this.petWin.isDestroyed()) {
      this.petWin.webContents.send(IPC_CHANNELS.SECRETARY_PANEL_VISIBILITY, this.isPanelOpen())
    }
  }

  private broadcastState(): void {
    for (const win of [this.petWin, this.panelWin]) {
      if (!win || win.isDestroyed()) continue
      win.webContents.send(IPC_CHANNELS.SECRETARY_PANEL_VISIBILITY, this.isPanelOpen())
      win.webContents.send(IPC_CHANNELS.SECRETARY_SETTINGS_CHANGED, this.getSettings())
    }
    this.notifySide()
  }

  /* ================= 快捷键 ================= */

  private registerHotkey(): void {
    this.unregisterHotkey()
    const accel = (this.settings.hotkey || DEFAULT_SECRETARY_SETTINGS.hotkey).trim()
    if (!accel) return
    try {
      const ok = globalShortcut.register(accel, () => this.togglePanel())
      if (ok) {
        this.registeredHotkey = accel
        logger.info(`Hotkey registered: ${accel}`)
      } else {
        logger.warn(`Hotkey registration rejected: ${accel}`)
      }
    } catch (err: any) {
      logger.warn('Hotkey registration failed:', err?.message || err)
    }
  }

  private unregisterHotkey(): void {
    if (!this.registeredHotkey) return
    try {
      globalShortcut.unregister(this.registeredHotkey)
    } catch { /* ignore */ }
    this.registeredHotkey = null
  }

  /* ================= 持久化 ================= */

  private loadPersisted(): void {
    try {
      const db = DatabaseService.getInstance().getDb()
      const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(SETTINGS_KEY) as { value?: string } | undefined
      if (row?.value) {
        this.settings = { ...DEFAULT_SECRETARY_SETTINGS, ...JSON.parse(row.value) }
        if (!isSecretaryCharacterId(this.settings.character)) {
          this.settings.character = DEFAULT_SECRETARY_SETTINGS.character
        }
      }
      const posRow = db.prepare('SELECT value FROM settings WHERE key = ?').get(POSITION_KEY) as { value?: string } | undefined
      if (posRow?.value) {
        const parsed = JSON.parse(posRow.value)
        if (Number.isFinite(parsed?.x) && Number.isFinite(parsed?.y)) {
          this.position = { x: parsed.x, y: parsed.y }
        }
        if (parsed?.side === 'left' || parsed?.side === 'right') {
          this.side = parsed.side
        }
      }
    } catch (err: any) {
      logger.warn('读取小秘书设置失败，使用默认值:', err?.message || err)
    }
  }

  private persistSettings(): void {
    try {
      DatabaseService.getInstance().getDb()
        .prepare('INSERT INTO settings (key, value, updated_at) VALUES (?, ?, unixepoch()) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at')
        .run(SETTINGS_KEY, JSON.stringify(this.settings))
    } catch (err: any) {
      logger.warn('保存小秘书设置失败:', err?.message || err)
    }
  }

  private persistPosition(): void {
    if (!this.position) return
    try {
      DatabaseService.getInstance().getDb()
        .prepare('INSERT INTO settings (key, value, updated_at) VALUES (?, ?, unixepoch()) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at')
        .run(POSITION_KEY, JSON.stringify({ ...this.position, side: this.side }))
    } catch (err: any) {
      logger.warn('保存挂件位置失败:', err?.message || err)
    }
  }

  /* ================= IPC ================= */

  private state(): SecretaryRuntimeState {
    return {
      panelOpen: this.isPanelOpen(),
      settings: this.getSettings(),
      hotkeyRegistered: !this.settings.hotkey || this.registeredHotkey === this.settings.hotkey,
      side: this.side,
    }
  }

  private registerIpc(): void {
    if (this.ipcReady) return
    this.ipcReady = true

    ipcMain.handle(IPC_CHANNELS.SECRETARY_GET_STATE, () => this.state())
    ipcMain.handle(IPC_CHANNELS.SECRETARY_SHOW_PANEL, () => { this.showPanel(); return true })
    ipcMain.handle(IPC_CHANNELS.SECRETARY_HIDE_PANEL, () => { this.hidePanel(); return true })
    ipcMain.handle(IPC_CHANNELS.SECRETARY_TOGGLE_PANEL, () => { this.togglePanel(); return this.isPanelOpen() })
    ipcMain.handle(IPC_CHANNELS.SECRETARY_SET_SETTINGS, (_e, patch: Partial<SecretarySettings>) => {
      this.setSettings(patch || {})
      return this.state()
    })

    ipcMain.on(IPC_CHANNELS.SECRETARY_MOVE_PET, (_e, cursor: { x: number; y: number }) => {
      if (!this.petWin || this.petWin.isDestroyed() || !cursor) return
      // 首次收到拖动消息时记录光标与窗口的起点：窗口移动不会改变光标的屏幕坐标，
      // 因此必须用「起点 + 光标位移」计算，而不是累加每帧增量（会互相抵消导致拖不动）
      if (!this.dragOrigin) {
        const b = this.petWin.getBounds()
        this.dragOrigin = { cursorX: cursor.x, cursorY: cursor.y, winX: b.x, winY: b.y }
      }
      const origin = this.dragOrigin
      const x = Math.round(origin.winX + (cursor.x - origin.cursorX))
      const y = Math.round(origin.winY + (cursor.y - origin.cursorY))
      this.petWin.setPosition(x, y)
      this.position = { x, y }
      if (this.isPanelOpen()) this.placePanel()
    })

    ipcMain.on(IPC_CHANNELS.SECRETARY_DRAG_END, () => {
      this.dragOrigin = null
      if (!this.petWin || this.petWin.isDestroyed()) return
      const bounds = this.petWin.getBounds()
      const area = screen.getDisplayMatching(bounds).workArea
      const pet = this.petRect(bounds)

      // 以「挂件本体」而不是窗口（含 140×110 透明留白）贴边，
      // 并且只在与屏幕边缘的距离小于 SNAP_DISTANCE 时吸附，中间区域保持自由摆放
      let left = pet.x
      let top = pet.y

      const distLeft = pet.x - area.x
      const distRight = area.x + area.width - (pet.x + pet.width)
      const distTop = pet.y - area.y
      const distBottom = area.y + area.height - (pet.y + pet.height)

      if (distLeft <= SNAP_DISTANCE) left = area.x + EDGE_MARGIN
      else if (distRight <= SNAP_DISTANCE) left = area.x + area.width - EDGE_MARGIN - pet.width

      if (distTop <= SNAP_DISTANCE) top = area.y + EDGE_MARGIN
      else if (distBottom <= SNAP_DISTANCE) top = area.y + area.height - EDGE_MARGIN - pet.height

      // 兜底夹紧：挂件本体必须完整留在工作区内
      left = clamp(left, area.x + EDGE_MARGIN, area.x + area.width - EDGE_MARGIN - pet.width)
      top = clamp(top, area.y + EDGE_MARGIN, area.y + area.height - EDGE_MARGIN - pet.height)

      // 先决定靠哪一侧（窗口留白与气泡随之翻转），再按挂件坐标落窗口位置
      this.updateSide(area, left + pet.width / 2)
      this.movePetTo(left, top)
      this.persistPosition()
    })

    ipcMain.on(IPC_CHANNELS.SECRETARY_SET_PANEL_HEIGHT, (_e, height: number) => {
      const next = clamp(Math.round(Number(height) || DEFAULT_PANEL_HEIGHT), MIN_PANEL_HEIGHT, MAX_PANEL_HEIGHT)
      if (Math.abs(next - this.panelHeight) < 2) return
      this.panelHeight = next
      if (this.panelWin && !this.panelWin.isDestroyed()) {
        const b = this.panelWin.getBounds()
        this.panelWin.setBounds({ x: b.x, y: b.y, width: PANEL_WIDTH, height: next })
        this.placePanel()
      }
    })

    ipcMain.on(IPC_CHANNELS.SECRETARY_SET_IGNORE_MOUSE, (event, ignore: boolean) => {
      const win = BrowserWindow.fromWebContents(event.sender)
      if (!win || win.isDestroyed()) return
      if (win !== this.petWin) return
      this.ignoreMouse = !!ignore
      win.setIgnoreMouseEvents(this.ignoreMouse, { forward: true })
    })

    ipcMain.on(IPC_CHANNELS.SECRETARY_CONTEXT_MENU, (event) => {
      const win = BrowserWindow.fromWebContents(event.sender)
      if (!win || win.isDestroyed() || win !== this.petWin) return
      // 用原生菜单：小窗只有挂件大小，渲染端浮层会被裁掉
      Menu.buildFromTemplate([
        { label: mainUiI18n.t('secretaryMenuOpen'), click: () => this.showPanel() },
        { type: 'separator' },
        { label: mainUiI18n.t('secretaryMenuHide'), click: () => this.setSettings({ enabled: false }) },
        { type: 'separator' },
        { label: mainUiI18n.t('secretaryMenuSettings'), click: () => this.openSettings() },
      ]).popup({ window: win })
    })

    ipcMain.handle(IPC_CHANNELS.SECRETARY_QUIT, () => {
      this.setSettings({ enabled: false })
      return true
    })

    ipcMain.handle(IPC_CHANNELS.SECRETARY_OPEN_TASK, (_e, payload: { employeeId: string; conversationId: string }) => {
      if (!payload?.conversationId) return false
      if (this.mainWindow && !this.mainWindow.isDestroyed()) {
        if (this.mainWindow.isMinimized()) this.mainWindow.restore()
        this.mainWindow.show()
        this.mainWindow.focus()
        this.mainWindow.webContents.send(IPC_CHANNELS.SECRETARY_OPEN_TASK, payload)
      }
      return true
    })
  }
}

export default SecretaryWindowService
