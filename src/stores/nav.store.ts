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
  | 'settings'

export interface NavItemConfig {
  key: string
  visible: boolean
  order: number
}

/** 插件导航项：随插件启停由启动加载器注入；排序/显隐随 config 持久化 */
export interface PluginNavItem {
  key: string
  /** 文案或 i18n key（以插件 namespace 解析） */
  label: string
  icon?: string
  /** manifest 默认 order（首次出现时的初始顺序） */
  order: number
  detachable: boolean
}

const SETTINGS_KEY = 'nav_items_config'

/** 固定导航项，settings 不可隐藏 */
export const LOCKED_KEYS: NavItemKey[] = ['settings']

export const DEFAULT_NAV_CONFIG: NavItemConfig[] = [
  { key: 'tasks', visible: true, order: 0 },
  { key: 'kms', visible: true, order: 1 },
  { key: 'employees', visible: true, order: 2 },
  { key: 'settings', visible: true, order: 3 },
]

interface NavConfigState {
  config: NavItemConfig[]
  pluginItems: PluginNavItem[]
  initialized: boolean
  setConfig: (config: NavItemConfig[]) => void
  setPlugins: (items: PluginNavItem[]) => void
  toggleVisible: (key: string) => void
  moveUp: (key: string) => void
  moveDown: (key: string) => void
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

/** 合并插件项到 config：保留已保存的排序/显隐，新增插件按 manifest order 插入 */
function mergePluginsIntoConfig(config: NavItemConfig[], plugins: PluginNavItem[]): NavItemConfig[] {
  const pluginKeys = new Set(plugins.map((p) => p.key))
  // 保留已持久化的 config（含插件项），移除已卸载的插件项
  const merged = config.filter((c) => !pluginKeys.has(c.key) || plugins.some((p) => p.key === c.key))
  for (const p of plugins) {
    if (!merged.some((c) => c.key === p.key)) {
      merged.push({ key: p.key, visible: true, order: p.order })
    }
  }
  return reindex(merged)
}

export const useNavConfigStore = create<NavConfigState>()(
  immer((set, get) => ({
    config: DEFAULT_NAV_CONFIG,
    pluginItems: [],
    initialized: false,

    setConfig: (config) => {
      const reindexed = reindex(config)
      set((state) => { state.config = reindexed })
      persist(reindexed)
    },

    setPlugins: (items) => {
      set((state) => {
        state.pluginItems = items.slice().sort((a, b) => a.order - b.order)
        // 合并插件项到 config 持久化列表
        state.config = mergePluginsIntoConfig(state.config, items)
      })
      persist(get().config)
    },

    toggleVisible: (key) => {
      if (LOCKED_KEYS.includes(key as NavItemKey)) return
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
      set((state) => {
        // 仅重置内置项，插件项保留
        const builtin = DEFAULT_NAV_CONFIG.map((c, i) => ({ ...c, order: i }))
        const pluginOnly = state.config.filter((c) => !DEFAULT_NAV_CONFIG.some((d) => d.key === c.key))
        state.config = reindex([...builtin, ...pluginOnly])
      })
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
          // 合并已保存（含插件项）、补充新增内置项
          const merged: NavItemConfig[] = DEFAULT_NAV_CONFIG.map((d) => {
            const s = parsed!.find((c) => c.key === d.key)
            return s ? { ...s } : { ...d }
          })
          // 补充已保存的插件项（插件加载后 setPlugins 会再次合并，但过早读取时已有）
          for (const s of parsed) {
            if (!merged.some((c) => c.key === s.key)) {
              merged.push({ ...s })
            }
          }
          set((state) => {
            state.config = reindex(merged)
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

/** 获取排序后的可见导航项（内置 + 插件，供 App.tsx 构建菜单使用） */
export function getVisibleNavItems(config: NavItemConfig[]): NavItemConfig[] {
  return config.slice().sort((a, b) => a.order - b.order).filter((c) => c.visible)
}
