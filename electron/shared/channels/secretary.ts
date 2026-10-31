/** 小秘书浮窗：主进程与渲染进程之间的通道与共享类型 */

export const SECRETARY_CHANNELS = {
  /** 显示 / 隐藏 / 切换面板（挂件点击、快捷键、托盘共用） */
  SECRETARY_SHOW_PANEL: 'secretary:show-panel',
  SECRETARY_HIDE_PANEL: 'secretary:hide-panel',
  SECRETARY_TOGGLE_PANEL: 'secretary:toggle-panel',
  /** 主进程 → 挂件窗：面板显隐变化 */
  SECRETARY_PANEL_VISIBILITY: 'secretary:panel-visibility',
  /** 主进程 → 两个窗口：设置变更（尺寸/不透明度/免打扰等） */
  SECRETARY_SETTINGS_CHANGED: 'secretary:settings-changed',
  /** 主进程 → 挂件窗：挂件贴左/贴右变化（气泡朝反方向展开） */
  SECRETARY_SIDE_CHANGED: 'secretary:side-changed',
  /** 读取运行态（设置 + 面板是否打开） */
  SECRETARY_GET_STATE: 'secretary:get-state',
  SECRETARY_SET_SETTINGS: 'secretary:set-settings',
  /** 挂件拖动：按增量移动窗口（send） */
  SECRETARY_MOVE_PET: 'secretary:move-pet',
  /** 拖动结束：吸附到屏幕边缘并落盘 */
  SECRETARY_DRAG_END: 'secretary:drag-end',
  /** 面板内容高度变化：主进程据此调整窗口高度 */
  SECRETARY_SET_PANEL_HEIGHT: 'secretary:set-panel-height',
  /** 透明区域点击穿透开关（挂件窗口用） */
  SECRETARY_SET_IGNORE_MOUSE: 'secretary:set-ignore-mouse',
  /** 退出小秘书（从面板菜单触发） */
  SECRETARY_QUIT: 'secretary:quit',
  /** 打开主窗口并定位到某个任务（面板点击任务行） */
  SECRETARY_OPEN_TASK: 'secretary:open-task',
  /** 挂件右键：由主进程弹出原生菜单（避免小窗裁切） */
  SECRETARY_CONTEXT_MENU: 'secretary:context-menu',
  /** 主进程 → 主窗口：打开「设置 → 小秘书」 */
  SECRETARY_OPEN_SETTINGS: 'secretary:open-settings',
} as const

/** 可选的挂件形象，数组顺序即设置面板展示顺序；robot（波波）屏幕脸默认显示应用图标、可被员工头像图替换，blob 为最初的圆团子 */
export const SECRETARY_CHARACTER_IDS = ['robot', 'blob', 'momo', 'pip'] as const

export type SecretaryCharacterId = (typeof SECRETARY_CHARACTER_IDS)[number]

export function isSecretaryCharacterId(value: unknown): value is SecretaryCharacterId {
  return typeof value === 'string' && (SECRETARY_CHARACTER_IDS as readonly string[]).includes(value)
}

export interface SecretarySettings {
  /** 是否启用小秘书（关闭时销毁窗口并注销快捷键） */
  enabled: boolean
  /** 挂件尺寸（logic px） */
  size: number
  /** 挂件不透明度 0.4–1 */
  opacity: number
  /** 免打扰：只记录角标，不弹通知卡 */
  dnd: boolean
  /** 全局快捷键（Electron accelerator） */
  hotkey: string
  /** 默认绑定的员工 id（空 = 上次使用的员工） */
  employeeId: string
  /** 挂件形象 */
  character: SecretaryCharacterId
}

export interface SecretaryRuntimeState {
  panelOpen: boolean
  settings: SecretarySettings
  /** 快捷键是否注册成功（被系统或其他程序占用时为 false） */
  hotkeyRegistered: boolean
  /** 挂件当前靠屏幕哪一侧：决定窗口内挂件位置与气泡展开方向 */
  side: SecretarySide
}

export type SecretarySide = 'left' | 'right'

export const DEFAULT_SECRETARY_SETTINGS: SecretarySettings = {
  enabled: true,
  size: 128,
  opacity: 1,
  dnd: false,
  hotkey: 'Control+Alt+Space',
  employeeId: '',
  character: 'blob',
}
