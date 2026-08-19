import { useRef, useEffect, useCallback } from 'react'

/**
 * 内部可滚动容器的"自动跟随到底部"能力
 *
 * 职责：
 * - 内容高度变化时，若用户停留在底部附近则自动滚到底（MutationObserver + rAF 节流，
 *   合并流式输出的多次 DOM 变更，避免同步 reflow）
 * - onScroll：用户滚动时按阈值更新 isAtBottom，手动上滚即暂停自动跟随，
 *   滚回底部附近后恢复（与 useChatScroll 一致的用户操作区分）
 */
export function useAutoFollowScroll<T extends HTMLElement>() {
  const containerRef = useRef<T>(null)
  const isAtBottomRef = useRef(true)
  const lastHeightRef = useRef(-1)

  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    let rafId: number | null = null
    const observer = new MutationObserver(() => {
      if (!isAtBottomRef.current) return
      if (rafId !== null) return
      rafId = requestAnimationFrame(() => {
        rafId = null
        const h = el.scrollHeight
        if (h !== lastHeightRef.current) {
          lastHeightRef.current = h
          if (isAtBottomRef.current) el.scrollTop = el.scrollHeight
        }
      })
    })
    observer.observe(el, { childList: true, subtree: true, characterData: true })
    lastHeightRef.current = el.scrollHeight
    return () => {
      if (rafId !== null) cancelAnimationFrame(rafId)
      observer.disconnect()
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