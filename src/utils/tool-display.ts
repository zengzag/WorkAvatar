// 工具显示文案统一解析（中英文）：
// 1) 宿主 locale workbench.toolNames.<name>（内置/系统/委托/技能等工具）
// 2) 插件 locale toolNames.<name>（namespace = 插件 id），并兼容 title 本身是插件 i18n key 的旧模式
// 3) 后端工具目录 title（listBuiltin，与设置页同源）兜底 → 工具原名（如 MCP 外部工具）
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

export function getToolDisplayName(name: string): string {
  const info = catalogByName?.get(name)
  return resolveToolLabel(name, info?.title, info?.pluginId)
}

// 渲染端模块加载即拉取工具目录，保证聊天页渲染时文案已就绪
void loadToolDisplayNames()
