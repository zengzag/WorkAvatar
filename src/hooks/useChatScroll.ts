import { useEffect, useRef, useCallback } from 'react'

/**
 * 聊天滚动控制 hook
 *
 * 职责：
 * - 维护滚动相关 ref（messagesEndRef / chatContainerRef / isUserAtBottomRef）
 * - 监听 messages 变化，通过 requestAnimationFrame 节流滚动到底部，
 *   合并多个 token chunk 为单次滚动，避免流式输出触发大量同步 reflow
 * - handleScroll：用户滚动时根据阈值更新 isUserAtBottomRef
 * - forceScrollToBottom：强制平滑滚动到底部
 */
export function useChatScroll<T>(messages: T[]) {
  const messagesEndRef = useRef<HTMLDivElement>(null)
  const chatContainerRef = useRef<HTMLDivElement>(null)
  const isUserAtBottomRef = useRef(true)

  // scrollIntoView 节流：用 requestAnimationFrame 合并多个 token chunk 为单次滚动
  // 避免 2000 token 流式输出触发 2000 次同步 reflow
  const scrollRafRef = useRef<number | null>(null)
  useEffect(() => {
    if (!isUserAtBottomRef.current) return
    if (scrollRafRef.current !== null) return // 已有 pending 帧，跳过
    scrollRafRef.current = requestAnimationFrame(() => {
      scrollRafRef.current = null
      // RAF 回调执行时再次复查 isUserAtBottomRef，
      // 避免用户在调度与执行之间上滚被强制拉回底部（M5 修复）
      if (!isUserAtBottomRef.current) return
      messagesEndRef.current?.scrollIntoView({ behavior: 'auto' })
    })
    return () => {
      if (scrollRafRef.current !== null) {
        cancelAnimationFrame(scrollRafRef.current)
        scrollRafRef.current = null
      }
    }
  }, [messages])

  const handleScroll = useCallback(() => {
    const el = chatContainerRef.current
    if (!el) return
    const threshold = 50
    isUserAtBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < threshold
  }, [])

  const forceScrollToBottom = () => {
    isUserAtBottomRef.current = true
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }

  return {
    messagesEndRef,
    chatContainerRef,
    handleScroll,
    forceScrollToBottom,
  }
}

export default useChatScroll
