import { useRef, useLayoutEffect, useEffect, useCallback } from 'react'

/**
 * 内部可滚动容器的"自动跟随到底部"能力
 *
 * 职责：
 * - 内容变化时，若用户停留在底部附近则自动滚到底（MutationObserver + rAF 节流，
 *   合并流式输出的多次 DOM 变更，避免同步 reflow）
 * - onScroll：用户滚动时按阈值更新 isAtBottom，手动上滚即暂停自动跟随，
 *   滚回底部附近后恢复
 *
 * 实现要点：
 * - 通过无依赖的 useLayoutEffect 在元素挂载/切换时重建 observer，避免容器为条件
 *   渲染（如折叠的工具调用段）时 observer 未建立导致不触发
 * - 不依赖高度比较，只要用户位于底部就跟随，避免高度判断陈旧导致漏滚
 */
export function useAutoFollowScroll<T extends HTMLElement>() {
  const containerRef = useRef<T | null>(null)
  const isAtBottomRef = useRef(true)
  const rafIdRef = useRef<number | null>(null)
  const elRef = useRef<T | null>(null)
  const observerRef = useRef<MutationObserver | null>(null)

  // 元素挂载/切换时重建 observer（容器可能为条件渲染，如折叠的工具调用段）
  useLayoutEffect(() => {
    const el = containerRef.current
    if (el === elRef.current) return
    elRef.current = el
    observerRef.current?.disconnect()
    observerRef.current = null
    if (!el) return
    const observer = new MutationObserver(() => {
      if (!isAtBottomRef.current) return
      if (rafIdRef.current !== null) return
      rafIdRef.current = requestAnimationFrame(() => {
        rafIdRef.current = null
        if (isAtBottomRef.current && containerRef.current) {
          containerRef.current.scrollTop = containerRef.current.scrollHeight
        }
      })
    })
    observer.observe(el, { childList: true, subtree: true, characterData: true })
    observerRef.current = observer
  })

  // 卸载时清理（重置 elRef 以便 StrictMode 重挂载时重建 observer）
  useEffect(() => {
    return () => {
      observerRef.current?.disconnect()
      observerRef.current = null
      elRef.current = null
      if (rafIdRef.current !== null) cancelAnimationFrame(rafIdRef.current)
    }
  }, [])

  const onScroll = useCallback(() => {
    const el = containerRef.current
    if (!el) return
    const threshold = 20
    isAtBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < threshold
  }, [])

  return { containerRef, onScroll }
}
