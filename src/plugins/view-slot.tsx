/**
 * 插件视图注入：宿主界面在指定注入点渲染插件贡献的组件。
 * loadPlugins 收集各插件渲染端入口的 views，存入本模块；
 * 宿主界面用 <PluginViewSlot view="chat.toolbar" /> 在对应位置渲染。
 */
import React from 'react'
import type { PluginViewDefinition } from '../../plugin-sdk/src/renderer'

/** 已收集的视图注入（pluginId:view → 组件） */
const viewRegistry = new Map<string, React.ComponentType<{ context?: unknown }>>()

/** 由 loadPlugins 调用，注册某插件的全部视图注入 */
export function registerPluginViews(pluginId: string, views?: PluginViewDefinition[]): void {
  if (!views) return
  for (const v of views) {
    viewRegistry.set(`${pluginId}:${v.view}`, v.component)
  }
}

/** 查询指定注入点的所有插件组件 */
export function getPluginViews(view: string): Array<{ pluginId: string; component: React.ComponentType<{ context?: unknown }> }> {
  const result: Array<{ pluginId: string; component: React.ComponentType<{ context?: unknown }> }> = []
  for (const [key, component] of viewRegistry) {
    const sep = key.indexOf(':')
    const pluginId = key.slice(0, sep)
    const v = key.slice(sep + 1)
    if (v === view) result.push({ pluginId, component })
  }
  return result
}

/** 宿主界面注入点容器：渲染所有插件贡献到指定 view 的组件 */
export function PluginViewSlot({ view, context }: { view: string; context?: unknown }): React.ReactElement | null {
  const views = getPluginViews(view)
  if (views.length === 0) return null
  return (
    <>
      {views.map(({ pluginId, component: Comp }) => (
        <Comp key={pluginId} context={context} />
      ))}
    </>
  )
}
