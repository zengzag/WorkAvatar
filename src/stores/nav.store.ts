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
  setPlugins: (items: PluginNavItem[], installedIds?: string[]) => void
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
  // 锁定项（settings）始终排在最后，忽略持久化中的历史排序
  return config
    .slice()
    .sort((a, b) => {
      const aLocked = LOCKED_KEYS.includes(a.key as NavItemKey) ? 1 : 0
      const bLocked = LOCKED_KEYS.includes(b.key as NavItemKey) ? 1 : 0
      if (aLocked !== bLocked) return aLocked - bLocked
      return a.order - b.order
    })
    .map((item, idx) => ({ ...item, order: idx }))
}

/**
 * 合并插件项到 config：
 * - 内置项与"已安装插件"（installedIds，含已停用/加载失败的插件）的排序/显隐保留；
 * - 仅移除真正卸载（不在 installedIds）的插件项；
 * - 当前已加载插件缺条目时按 manifest order 追加。
 * installedIds 缺省（调用方拿不到安装清单）时退回旧行为：只保留内置项与当前插件项。
 */
function mergePluginsIntoConfig(
  config: NavItemConfig[],
  plugins: PluginNavItem[],
  installedIds?: string[],
): NavItemConfig[] {
  const builtinKeys = new Set(DEFAULT_NAV_CONFIG.map((c) => c.key))
  const installed = installedIds ? new Set(installedIds) : null
  const merged = config.filter((c) => builtinKeys.has(c.key) || (installed ? installed.has(c.key) : false))
  for (const p of plugins) {
    if (merged.some((c) => c.key === p.key)) continue
    const saved = config.find((c) => c.key === p.key)
    merged.push(saved ? { ...saved } : { key: p.key, visible: true, order: p.order })
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

    setPlugins: (items, installedIds) => {
      set((state) => {
        state.pluginItems = items.slice().sort((a, b) => a.order - b.order)
        // 合并插件项到 config 持久化列表
        state.config = mergePluginsIntoConfig(state.config, items, installedIds)
      })
      // 初始化（读取持久化）完成前 config 还是默认顺序，此时写盘会用 manifest 顺序覆盖用户已保存的排序/显隐
      if (get().initialized) persist(get().config)
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
      if (LOCKED_KEYS.includes(key as NavItemKey)) return
      set((state) => {
        const sorted = state.config.slice().sort((a, b) => a.order - b.order)
        const idx = sorted.findIndex((c) => c.key === key)
        if (idx <= 0) return
        const tmp = sorted[idx].order
        sorted[idx].order = sorted[idx - 1].order
        sorted[idx - 1].order = tmp
        // reindex：锁定项始终排最后（与锁定项换位时归一化，避免设置项跑到上方）
        state.config = reindex(sorted)
      })
      persist(get().config)
    },

    moveDown: (key) => {
      if (LOCKED_KEYS.includes(key as NavItemKey)) return
      set((state) => {
        const sorted = state.config.slice().sort((a, b) => a.order - b.order)
        const idx = sorted.findIndex((c) => c.key === key)
        if (idx < 0 || idx >= sorted.length - 1) return
        const tmp = sorted[idx].order
        sorted[idx].order = sorted[idx + 1].order
        sorted[idx + 1].order = tmp
        state.config = reindex(sorted)
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
      let parsed: NavItemConfig[] | null = null
      try {
        const saved = await window.electronAPI.settings.get({ key: SETTINGS_KEY })
        if (Array.isArray(saved)) {
          parsed = saved as NavItemConfig[]
        } else if (typeof saved === 'string' && saved.trim()) {
          try { parsed = JSON.parse(saved) } catch { /* ignore */ }
        }
      } catch { /* 读取失败按无持久化处理 */ }
      set((state) => {
        // 内置项：优先取持久化中的排序/显隐，缺失（新增内置项）则用默认值
        const merged: NavItemConfig[] = DEFAULT_NAV_CONFIG.map((d) => {
          const s = parsed?.find((c) => c.key === d.key)
          return s ? { ...s } : { ...d }
        })
        // 补充持久化中的插件项（含已卸载插件的历史条目，待 setPlugins 合并时清理）
        if (Array.isArray(parsed)) {
          for (const s of parsed) {
            if (!merged.some((c) => c.key === s.key)) merged.push({ ...s })
          }
        }
        // 启动期插件可能先于本方法注入（loadPlugins 早于 UI 挂载）：保留其条目，避免被持久化合并覆盖丢失
        for (const p of state.pluginItems) {
          if (!merged.some((c) => c.key === p.key)) {
            merged.push({ key: p.key, visible: true, order: p.order })
          }
        }
        state.config = reindex(merged)
        state.initialized = true
      })
    },
  }))
)

/** 获取排序后的可见导航项（内置 + 插件，供 App.tsx 构建菜单使用） */
export function getVisibleNavItems(config: NavItemConfig[]): NavItemConfig[] {
  return config.slice().sort((a, b) => a.order - b.order).filter((c) => c.visible)
}
