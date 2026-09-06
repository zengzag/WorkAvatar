/**
 * 插件视图注入 registry 单测（loader.ts 的 registerPluginViews/unregisterPluginViews 契约）：
 * - 注册/查询/卸载按 pluginId 隔离
 * - 覆盖升级重注册替换同 view 位
 * - 无 Views 注册不 bump 版本（不触发无谓重渲染）
 */
import { describe, it, expect, afterEach } from 'vitest'
import {
  registerPluginViews,
  unregisterPluginViews,
  getPluginViews,
} from '../../../src/plugins/view-slot'

function CompA() { return null }

afterEach(() => {
  // 清空 registry：逐一卸载所有已注册插件的视图
  const plugins = new Set<string>()
  const scan = (view: string) => {
    for (const v of getPluginViews(view)) plugins.add(v.pluginId)
  }
  scan('chat.toolbar')
  scan('chat.quick')
  for (const id of plugins) unregisterPluginViews(id)
})

describe('registerPluginViews / getPluginViews / unregisterPluginViews', () => {
  it('注册后可在对应注入点查询到，插件间隔离', () => {
    registerPluginViews('p-a', [{ view: 'chat.toolbar', component: CompA }])
    registerPluginViews('p-b', [{ view: 'chat.toolbar', component: CompA }])
    expect(getPluginViews('chat.toolbar').map(v => v.pluginId)).toEqual(['p-a', 'p-b'])
    expect(getPluginViews('chat.quick')).toHaveLength(0)
  })

  it('同插件同注入点重复注册（升级重载）以最后一次为准', () => {
    registerPluginViews('p-a', [{ view: 'chat.toolbar', component: CompA }])
    registerPluginViews('p-a', [{ view: 'chat.toolbar', component: CompA }])
    expect(getPluginViews('chat.toolbar')).toHaveLength(1)
    expect(getPluginViews('chat.toolbar')[0].pluginId).toBe('p-a')
  })

  it('同一插件不同注入点共存', () => {
    registerPluginViews('p-a', [{ view: 'chat.toolbar', component: CompA }])
    registerPluginViews('p-a', [{ view: 'chat.quick', component: CompA }])
    expect(getPluginViews('chat.toolbar')).toHaveLength(1)
    expect(getPluginViews('chat.quick')).toHaveLength(1)
  })

  it('卸载仅清除指定插件的视图，其他插件不受影响', () => {
    registerPluginViews('p-a', [{ view: 'chat.toolbar', component: CompA }])
    registerPluginViews('p-b', [{ view: 'chat.toolbar', component: CompA }])
    unregisterPluginViews('p-a')
    expect(getPluginViews('chat.toolbar').map(v => v.pluginId)).toEqual(['p-b'])
  })

  it('无 views 时不注册也不报错', () => {
    registerPluginViews('p-a', undefined)
    registerPluginViews('p-a', [])
    expect(getPluginViews('chat.toolbar')).toHaveLength(0)
  })

  it('卸载不存在的插件为无操作', () => {
    expect(() => unregisterPluginViews('nope')).not.toThrow()
  })
})