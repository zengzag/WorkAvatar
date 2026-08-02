import { create } from 'zustand'
import { immer } from 'zustand/middleware/immer'

/**
 * 导航项配置：
 * - visible：是否在左侧菜单显示
 * - order：排序权重（升序）
 *
 * 持久化通过 window.electronAPI.settings.set/get，key = SETTINGS_KEY。
 * settings 项始终可见（避免被隐藏后无法恢复），其它项可自由显隐与排序。
 */

export type NavItemKey =
  | 'tasks'
  | 'employees'
  | 'kms'
  | 'voice'
  | 'calendar'
  | 'notes'
  | 'automation'
  | 'settings'

export interface NavItemConfig {
  key: NavItemKey
  visible: boolean
  order: number
}

const SETTINGS_KEY = 'nav_items_config'

/** 固定导航项，settings 不可隐藏 */
export const LOCKED_KEYS: NavItemKey[] = ['settings']

export const DEFAULT_NAV_CONFIG: NavItemConfig[] = [
  { key: 'tasks', visible: true, order: 0 },
  { key: 'notes', visible: true, order: 1 },
  { key: 'calendar', visible: true, order: 2 },
  { key: 'automation', visible: true, order: 3 },
  { key: 'kms', visible: true, order: 4 },
  { key: 'voice', visible: true, order: 5 },
  { key: 'employees', visible: true, order: 6 },
  { key: 'settings', visible: true, order: 7 },
]

interface NavConfigState {
  config: NavItemConfig[]
  initialized: boolean
  setConfig: (config: NavItemConfig[]) => void
  toggleVisible: (key: NavItemKey) => void
  moveUp: (key: NavItemKey) => void
  moveDown: (key: NavItemKey) => void
  reset: () => void
  initialize: () => Promise<void>
}

function persist(config: NavItemConfig[]): void {
  try {
    window.electronAPI.settings.set({ key: SETTINGS_KEY, value: JSON.stringify(config) })
  } catch { /* ignore */ }
}

function reindex(config: NavItemConfig[]): NavItemConfig[] {
  return config
    .slice()
    .sort((a, b) => a.order - b.order)
    .map((item, idx) => ({ ...item, order: idx }))
}

export const useNavConfigStore = create<NavConfigState>()(
  immer((set, get) => ({
    config: DEFAULT_NAV_CONFIG,
    initialized: false,

    setConfig: (config) => {
      const reindexed = reindex(config)
      set((state) => { state.config = reindexed })
      persist(reindexed)
    },

    toggleVisible: (key) => {
      if (LOCKED_KEYS.includes(key)) return
      set((state) => {
        const item = state.config.find((c) => c.key === key)
        if (item) item.visible = !item.visible
      })
      persist(get().config)
    },

    moveUp: (key) => {
      set((state) => {
        const sorted = state.config.slice().sort((a, b) => a.order - b.order)
        const idx = sorted.findIndex((c) => c.key === key)
        if (idx <= 0) return
        const tmp = sorted[idx].order
        sorted[idx].order = sorted[idx - 1].order
        sorted[idx - 1].order = tmp
        state.config = sorted
      })
      persist(get().config)
    },

    moveDown: (key) => {
      set((state) => {
        const sorted = state.config.slice().sort((a, b) => a.order - b.order)
        const idx = sorted.findIndex((c) => c.key === key)
        if (idx < 0 || idx >= sorted.length - 1) return
        const tmp = sorted[idx].order
        sorted[idx].order = sorted[idx + 1].order
        sorted[idx + 1].order = tmp
        state.config = sorted
      })
      persist(get().config)
    },

    reset: () => {
      set((state) => { state.config = DEFAULT_NAV_CONFIG.map((c, i) => ({ ...c, order: i })) })
      persist(get().config)
    },

    initialize: async () => {
      if (get().initialized) return
      try {
        const saved = await window.electronAPI.settings.get({ key: SETTINGS_KEY })
        let parsed: NavItemConfig[] | null = null
        if (Array.isArray(saved)) {
          parsed = saved as NavItemConfig[]
        } else if (typeof saved === 'string' && saved.trim()) {
          try { parsed = JSON.parse(saved) } catch { /* ignore */ }
        }
        if (Array.isArray(parsed)) {
          // 合并：保留已保存项，补充新增的默认项（如新版本加的导航）
          const merged: NavItemConfig[] = DEFAULT_NAV_CONFIG.map((d) => {
            const s = parsed!.find((c) => c.key === d.key)
            return s ? { ...s } : { ...d }
          })
          // 过滤已废弃的旧 key
          const validKeys = DEFAULT_NAV_CONFIG.map((d) => d.key)
          const filtered = merged.filter((c) => validKeys.includes(c.key))
          set((state) => {
            state.config = reindex(filtered)
            state.initialized = true
          })
        } else {
          set((state) => {
            state.config = DEFAULT_NAV_CONFIG.map((c, i) => ({ ...c, order: i }))
            state.initialized = true
          })
        }
      } catch {
        set((state) => {
          state.config = DEFAULT_NAV_CONFIG.map((c, i) => ({ ...c, order: i }))
          state.initialized = true
        })
      }
    },
  }))
)

/** 获取排序后的可见导航项（供 App.tsx 构建菜单使用） */
export function getVisibleNavItems(config: NavItemConfig[]): NavItemConfig[] {
  return config.slice().sort((a, b) => a.order - b.order).filter((c) => c.visible)
}
