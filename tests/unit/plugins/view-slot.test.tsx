// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import React from 'react'
import { createRoot } from 'react-dom/client'
import { act } from 'react'

/**
 * view-slot 测试：验证视图注入注册、查询与渲染。
 * 注意：viewRegistry 是模块级状态，测试间用 vi.resetModules 重新加载。
 */

function MockComp({ context }: { context?: unknown }) {
  return <div data-testid="mock-comp">{String(context ?? 'no-context')}</div>
}

describe('registerPluginViews / getPluginViews', () => {
  beforeEach(() => {
    vi.resetModules()
  })

  it('注册后可按 view 查询', async () => {
    const { registerPluginViews, getPluginViews } = await import('../../../src/plugins/view-slot')
    registerPluginViews('plugin-a', [{ view: 'chat.toolbar', component: MockComp }])
    const views = getPluginViews('chat.toolbar')
    expect(views.length).toBe(1)
    expect(views[0].pluginId).toBe('plugin-a')
  })

  it('未注册的 view 返回空数组', async () => {
    const { getPluginViews } = await import('../../../src/plugins/view-slot')
    expect(getPluginViews('sidebar.footer')).toEqual([])
  })

  it('undefined views 不注册', async () => {
    const { registerPluginViews, getPluginViews } = await import('../../../src/plugins/view-slot')
    registerPluginViews('plugin-a', undefined)
    expect(getPluginViews('chat.toolbar')).toEqual([])
  })

  it('多个插件注册同一 view 都返回', async () => {
    const { registerPluginViews, getPluginViews } = await import('../../../src/plugins/view-slot')
    registerPluginViews('plugin-a', [{ view: 'chat.toolbar', component: MockComp }])
    registerPluginViews('plugin-b', [{ view: 'chat.toolbar', component: MockComp }])
    const views = getPluginViews('chat.toolbar')
    expect(views.length).toBe(2)
    expect(views.map(v => v.pluginId)).toEqual(['plugin-a', 'plugin-b'])
  })

  it('不同 view 互不干扰', async () => {
    const { registerPluginViews, getPluginViews } = await import('../../../src/plugins/view-slot')
    registerPluginViews('plugin-a', [{ view: 'chat.toolbar', component: MockComp }])
    expect(getPluginViews('chat.toolbar').length).toBe(1)
    expect(getPluginViews('sidebar.footer').length).toBe(0)
  })
})

describe('PluginViewSlot 渲染', () => {
  let container: HTMLDivElement

  beforeEach(() => {
    vi.resetModules()
    container = document.createElement('div')
    document.body.appendChild(container)
  })

  afterEach(() => {
    document.body.removeChild(container)
  })

  async function renderSlot(view: string, context?: unknown) {
    const { PluginViewSlot } = await import('../../../src/plugins/view-slot')
    const root = createRoot(container)
    await act(async () => {
      root.render(<PluginViewSlot view={view} context={context} />)
    })
    return root
  }

  it('无注入时渲染空', async () => {
    await renderSlot('chat.toolbar')
    expect(container.textContent).toBe('')
  })

  it('有注入时渲染组件并透传 context', async () => {
    const { registerPluginViews } = await import('../../../src/plugins/view-slot')
    registerPluginViews('plugin-a', [{ view: 'chat.toolbar', component: MockComp }])
    await renderSlot('chat.toolbar', 'hello')
    expect(container.textContent).toBe('hello')
  })

  it('多个插件注入同一 view 都渲染', async () => {
    const { registerPluginViews } = await import('../../../src/plugins/view-slot')
    registerPluginViews('plugin-a', [{ view: 'chat.toolbar', component: MockComp }])
    registerPluginViews('plugin-b', [{ view: 'chat.toolbar', component: MockComp }])
    await renderSlot('chat.toolbar')
    expect(container.querySelectorAll('[data-testid="mock-comp"]').length).toBe(2)
  })

  it('不同 view 只渲染对应注入', async () => {
    const { registerPluginViews } = await import('../../../src/plugins/view-slot')
    registerPluginViews('plugin-a', [{ view: 'chat.toolbar', component: MockComp }])
    await renderSlot('sidebar.footer')
    expect(container.querySelector('[data-testid="mock-comp"]')).toBeNull()
  })
})
