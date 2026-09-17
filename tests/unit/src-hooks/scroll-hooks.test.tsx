// @vitest-environment jsdom
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest'
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { useChatScroll } from '../../../src/hooks/useChatScroll'
import { useAutoFollowScroll } from '../../../src/hooks/useAutoFollowScroll'

/**
 * 滚动 hook 的纯逻辑验证（需 DOM + rAF）：
 * useChatScroll：底部阈值判定、rAF 节流合并、上滚后暂停自动跟随、强制滚底
 * useAutoFollowScroll：MutationObserver + rAF 自动跟底、onScroll 阈值 20 暂停/恢复、容器切换重建 observer
 */

beforeAll(() => {
  ;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true
  if (!(Element.prototype as any).scrollIntoView) {
    ;(Element.prototype as any).scrollIntoView = () => { /* noop */ }
  }
  if (!globalThis.requestAnimationFrame) {
    globalThis.requestAnimationFrame = ((cb: FrameRequestCallback) =>
      setTimeout(() => cb(Date.now()), 0) as unknown as number) as any
    globalThis.cancelAnimationFrame = ((id: number) => clearTimeout(id)) as any
  }
})

function setMetrics(
  el: HTMLElement,
  m: { scrollTop?: number; scrollHeight?: number; clientHeight?: number },
) {
  for (const [key, value] of Object.entries(m)) {
    Object.defineProperty(el, key, { value, writable: true, configurable: true })
  }
}

/** 等待 rAF / MutationObserver 回调落地 */
const flush = async (ms = 60) => {
  await act(async () => { await new Promise(r => setTimeout(r, ms)) })
}

let scrollApi: ReturnType<typeof useChatScroll<number>> | null = null
let followApi: ReturnType<typeof useAutoFollowScroll<HTMLDivElement>> | null = null
const scrollIntoView = vi.fn()

const ChatHarness: React.FC<{ items: number[] }> = ({ items }) => {
  const api = useChatScroll(items)
  scrollApi = api
  return (
    <div ref={api.chatContainerRef}>
      <div data-testid="end" ref={api.messagesEndRef} />
    </div>
  )
}

const FollowHarness: React.FC<{ show: boolean }> = ({ show }) => {
  const api = useAutoFollowScroll<HTMLDivElement>()
  followApi = api
  return show
    ? <div data-testid="follow" ref={api.containerRef}><span>a</span></div>
    : <div data-testid="placeholder" />
}

let container: HTMLDivElement
let root: ReturnType<typeof createRoot>

beforeEach(() => {
  scrollIntoView.mockClear()
  ;(Element.prototype as any).scrollIntoView = scrollIntoView
  scrollApi = null
  followApi = null
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => { root.unmount() })
  container.remove()
})

describe('useChatScroll', () => {
  it('消息变化时自动滚到底部（behavior: auto）', async () => {
    await act(async () => { root.render(<ChatHarness items={[1]} />) })
    await flush()
    expect(scrollIntoView).toHaveBeenCalledWith({ behavior: 'auto' })
  })

  it('用户上滚到距底 >= 50px 后，消息变化不再自动滚动', async () => {
    await act(async () => { root.render(<ChatHarness items={[1]} />) })
    await flush()
    const el = scrollApi!.chatContainerRef.current!
    setMetrics(el, { scrollHeight: 1000, clientHeight: 500, scrollTop: 400 }) // 距底 100
    act(() => { scrollApi!.handleScroll() })
    scrollIntoView.mockClear()

    await act(async () => { root.render(<ChatHarness items={[1, 2]} />) })
    await flush()
    expect(scrollIntoView).not.toHaveBeenCalled()
  })

  it('阈值边界：距底恰好 50px 视为不在底部，49px 视为在底部', async () => {
    await act(async () => { root.render(<ChatHarness items={[1]} />) })
    const el = scrollApi!.chatContainerRef.current!

    setMetrics(el, { scrollHeight: 1000, clientHeight: 500, scrollTop: 450 })
    act(() => { scrollApi!.handleScroll() })
    scrollIntoView.mockClear()
    await act(async () => { root.render(<ChatHarness items={[1, 2]} />) })
    await flush()
    expect(scrollIntoView).not.toHaveBeenCalled()

    setMetrics(el, { scrollHeight: 1000, clientHeight: 500, scrollTop: 451 })
    act(() => { scrollApi!.handleScroll() })
    await act(async () => { root.render(<ChatHarness items={[1, 2, 3]} />) })
    await flush()
    expect(scrollIntoView).toHaveBeenCalled()
  })

  it('forceScrollToBottom 强制平滑滚动并重置为跟随状态', async () => {
    await act(async () => { root.render(<ChatHarness items={[1]} />) })
    await flush()
    const el = scrollApi!.chatContainerRef.current!
    setMetrics(el, { scrollHeight: 1000, clientHeight: 500, scrollTop: 0 })
    act(() => { scrollApi!.handleScroll() })
    scrollIntoView.mockClear()

    act(() => { scrollApi!.forceScrollToBottom() })
    expect(scrollIntoView).toHaveBeenCalledWith({ behavior: 'smooth' })

    // 已恢复跟随：后续消息变化再次自动滚动
    await act(async () => { root.render(<ChatHarness items={[1, 2]} />) })
    await flush()
    expect(scrollIntoView).toHaveBeenCalledTimes(2)
  })

  it('卸载后 handleScroll 不抛错（容器 ref 已清空）', async () => {
    await act(async () => { root.render(<ChatHarness items={[1]} />) })
    const api = scrollApi!
    await act(async () => { root.unmount() })
    expect(() => api.handleScroll()).not.toThrow()
  })

  it('连续多次消息变化由 rAF 合并为一次滚动', async () => {
    await act(async () => { root.render(<ChatHarness items={[1]} />) })
    await flush()
    scrollIntoView.mockClear()
    await act(async () => {
      root.render(<ChatHarness items={[1, 2]} />)
      root.render(<ChatHarness items={[1, 2, 3]} />)
      root.render(<ChatHarness items={[1, 2, 3, 4]} />)
    })
    await flush()
    expect(scrollIntoView).toHaveBeenCalledTimes(1)
  })
})

describe('useAutoFollowScroll', () => {
  const followEl = () => document.querySelector('[data-testid="follow"]') as HTMLDivElement

  it('内容变化且位于底部时自动滚到底', async () => {
    await act(async () => { root.render(<FollowHarness show />) })
    const el = followEl()
    setMetrics(el, { scrollHeight: 800, clientHeight: 200, scrollTop: 600 })
    await act(async () => { el.appendChild(document.createElement('span')) })
    await flush()
    expect(el.scrollTop).toBe(800)
  })

  it('onScroll 判定距底 >= 20px 后暂停自动跟随，回到阈值内恢复', async () => {
    await act(async () => { root.render(<FollowHarness show />) })
    const el = followEl()
    setMetrics(el, { scrollHeight: 800, clientHeight: 200, scrollTop: 500 }) // 距底 100
    act(() => { followApi!.onScroll() })
    await act(async () => { el.appendChild(document.createElement('span')) })
    await flush()
    expect(el.scrollTop).toBe(500) // 未被自动拉到底

    setMetrics(el, { scrollHeight: 800, clientHeight: 200, scrollTop: 601 }) // 距底 19
    act(() => { followApi!.onScroll() })
    await act(async () => { el.appendChild(document.createElement('span')) })
    await flush()
    expect(el.scrollTop).toBe(800)
  })

  it('onScroll 在容器未挂载时不抛错', async () => {
    await act(async () => { root.render(<FollowHarness show={false} />) })
    const api = followApi!
    expect(() => api.onScroll()).not.toThrow()
  })

  it('容器条件渲染切换后仍能跟随（observer 重建）', async () => {
    await act(async () => { root.render(<FollowHarness show={false} />) })
    await act(async () => { root.render(<FollowHarness show />) })
    const el = followEl()
    setMetrics(el, { scrollHeight: 500, clientHeight: 100, scrollTop: 400 })
    await act(async () => { el.appendChild(document.createElement('span')) })
    await flush()
    expect(el.scrollTop).toBe(500)
  })

  it('同一 rAF 帧内多次 DOM 变化只滚动一次', async () => {
    await act(async () => { root.render(<FollowHarness show />) })
    const el = followEl()
    let top = 600
    let writes = 0
    Object.defineProperty(el, 'scrollHeight', { value: 800, configurable: true })
    Object.defineProperty(el, 'clientHeight', { value: 200, configurable: true })
    Object.defineProperty(el, 'scrollTop', {
      configurable: true,
      get: () => top,
      set: (v: number) => { top = v; writes++ },
    })
    await act(async () => {
      el.appendChild(document.createElement('span'))
      el.appendChild(document.createElement('span'))
      el.appendChild(document.createElement('span'))
    })
    await flush()
    expect(top).toBe(800)
    expect(writes).toBe(1)
  })
})
