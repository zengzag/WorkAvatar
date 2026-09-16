// 工具显示文案统一解析（中英文）：
// 1) 宿主 locale workbench.toolNames.<name>（内置/系统/委托/技能等工具）
// 2) 插件 locale toolNames.<name>（namespace = 插件 id），并兼容 title 本身是插件 i18n key 的旧模式
// 3) 后端工具目录 title（listBuiltin，与设置页同源）兜底 → 工具原名（如 MCP 外部工具）
// 另：按后端分类目录（getCategories）解析工具所属分组的 icon 键，供消息等场景复用分组图标
import i18n from '../i18n'

interface CatalogEntry {
  title: string
  pluginId?: string
}

let catalogByName: Map<string, CatalogEntry> | null = null
let loadingPromise: Promise<void> | null = null

export function loadToolDisplayNames(): Promise<void> {
  if (loadingPromise) return loadingPromise
  if (!window.electronAPI?.tool?.listBuiltin) {
    loadingPromise = Promise.resolve()
    return loadingPromise
  }
  loadingPromise = window.electronAPI.tool
    .listBuiltin()
    .then((tools: Array<{ name: string; title: string; pluginId?: string }>) => {
      catalogByName = new Map(tools.map(t => [t.name, { title: t.title, pluginId: t.pluginId }]))
    })
    .catch(() => { /* 加载失败时回退 locale/原名，不阻塞 UI */ })
  return loadingPromise
}

/** 按当前语言解析工具文案；pluginId 存在时优先走插件命名空间 */
export function resolveToolLabel(name: string, fallbackTitle?: string, pluginId?: string): string {
  if (pluginId) {
    const byName = i18n.t(`toolNames.${name}`, { ns: pluginId, defaultValue: '' })
    if (byName) return byName
    if (fallbackTitle) {
      // 兼容旧模式：插件工具 title 直接存插件 locale key（如 hello-world）
      const byTitleKey = i18n.t(fallbackTitle, { ns: pluginId, defaultValue: '' })
      if (byTitleKey) return byTitleKey
    }
  } else {
    const byName = i18n.t(`workbench.toolNames.${name}`, { defaultValue: '' })
    if (byName) return byName
  }
  return fallbackTitle || name
}

/**
 * 按当前语言解析工具说明（仅界面展示用；后端 description 面向 LLM，作为兜底）。
 * 与 resolveToolLabel 同源：宿主 locale workbench.toolDescriptions.<name>，
 * 插件工具走插件命名空间 toolDescriptions.<name>。
 */
export function resolveToolDescription(name: string, fallbackDescription?: string, pluginId?: string): string {
  const byName = pluginId
    ? i18n.t(`toolDescriptions.${name}`, { ns: pluginId, defaultValue: '' })
    : i18n.t(`workbench.toolDescriptions.${name}`, { defaultValue: '' })
  return byName || fallbackDescription || ''
}

export function getToolDisplayName(name: string): string {
  const info = catalogByName?.get(name)
  return resolveToolLabel(name, info?.title, info?.pluginId)
}

let toolIconByName: Map<string, string> | null = null
let iconLoadingPromise: Promise<void> | null = null

/** 拉取工具分类目录，建立 工具名 → 分组 icon 键 的映射（分类的 toolIds 即工具名） */
export function loadToolIconKeys(): Promise<void> {
  if (iconLoadingPromise) return iconLoadingPromise
  if (!window.electronAPI?.tool?.getCategories) {
    iconLoadingPromise = Promise.resolve()
    return iconLoadingPromise
  }
  iconLoadingPromise = window.electronAPI.tool
    .getCategories()
    .then((categories: Array<{ icon: string; tool_ids: string[] }>) => {
      const map = new Map<string, string>()
      for (const cat of categories || []) {
        for (const toolId of cat.tool_ids || []) map.set(toolId, cat.icon)
      }
      toolIconByName = map
    })
    .catch(() => { /* 加载失败时回退默认图标，不阻塞 UI */ })
  return iconLoadingPromise
}

/** 工具所属分组的 icon 键；未分组或分类目录未就绪时返回 undefined（由调用方回退默认图标） */
export function getToolIconKey(name: string): string | undefined {
  return toolIconByName?.get(name)
}

// 渲染端模块加载即拉取工具目录，保证聊天页渲染时文案已就绪
void loadToolDisplayNames()
void loadToolIconKeys()
