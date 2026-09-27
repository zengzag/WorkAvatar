import { useEffect, useRef, useCallback } from 'react'

/**
 * 发送新消息后的强制跟随窗口（毫秒）
 *
 * 发送时新消息/助手占位是异步渲染的：forceScrollToBottom 先把视口滚到「当时已有内容」的底部，
 * 随后新内容渲染使 scrollHeight 增大，这次程序化滚动触发的 scroll 事件会把 isAtBottom
 * 误判为 false，导致新消息与后续 LLM 回复不再被滚动展示（只停在旧消息底部）。
 * 窗口期内忽略该复位并持续滚底，窗口结束后恢复常规的「用户上滚即暂停跟随」。
 */
const FORCE_FOLLOW_MS = 800

/** 强制跟随窗口内判定为"用户主动上滚"的最小 scrollTop 上移量（px），低于该值视为程序化滚动噪声 */
const USER_SCROLL_UP_THRESHOLD = 10

/**
 * 聊天滚动控制 hook
 *
 * 职责：
 * - 维护滚动相关 ref（messagesEndRef / chatContainerRef / isUserAtBottomRef）
 * - 监听 messages 变化，通过 requestAnimationFrame 节流滚动到底部，
 *   合并多个 token chunk 为单次滚动，避免流式输出触发大量同步 reflow
 * - handleScroll：用户滚动时根据阈值更新 isUserAtBottomRef（强制跟随窗口内忽略）
 * - forceScrollToBottom：强制滚动到底部（默认平滑，发送新消息等需要立即定位时传 'auto'），
 *   并开启强制跟随窗口，保证随后渲染的新消息/回复也被展示
 */
export function useChatScroll<T>(messages: T[]) {
  const messagesEndRef = useRef<HTMLDivElement>(null)
  const chatContainerRef = useRef<HTMLDivElement>(null)
  const isUserAtBottomRef = useRef(true)
  /** 强制跟随截止时间戳（0 表示未开启） */
  const forceFollowUntilRef = useRef(0)
  /** 上一次 scrollTop：用于强制跟随窗口内识别用户上滚 */
  const lastScrollTopRef = useRef(0)

  // scrollIntoView 节流：用 requestAnimationFrame 合并多个 token chunk 为单次滚动
  // 避免 2000 token 流式输出触发 2000 次同步 reflow
  const scrollRafRef = useRef<number | null>(null)
  useEffect(() => {
    const forceFollowing = Date.now() < forceFollowUntilRef.current
    if (!isUserAtBottomRef.current && !forceFollowing) return
    if (scrollRafRef.current !== null) return // 已有 pending 帧，跳过
    scrollRafRef.current = requestAnimationFrame(() => {
      scrollRafRef.current = null
      // RAF 回调执行时再次复查：既避免用户在调度与执行之间上滚被强制拉回底部（M5 修复），
      // 也兼容发送后新消息刚渲染（强制跟随窗口内仍需滚到底）
      if (!isUserAtBottomRef.current && Date.now() >= forceFollowUntilRef.current) return
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
    // 强制跟随窗口内保持跟随状态：新消息渲染使 scrollHeight 增大，
    // 此刻程序化滚动触发的 scroll 事件会把 isAtBottom 误判为 false，从而漏滚新消息。
    // 但用户明显上滚（超过阈值）时立即终止窗口并同步状态，避免窗口结束后仍被拉回底部。
    if (Date.now() < forceFollowUntilRef.current) {
      if (lastScrollTopRef.current - el.scrollTop > USER_SCROLL_UP_THRESHOLD) {
        forceFollowUntilRef.current = 0
        isUserAtBottomRef.current = false
      }
      lastScrollTopRef.current = el.scrollTop
      return
    }
    lastScrollTopRef.current = el.scrollTop
    const threshold = 50
    isUserAtBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < threshold
  }, [])

  const forceScrollToBottom = (behavior: ScrollBehavior = 'smooth') => {
    isUserAtBottomRef.current = true
    forceFollowUntilRef.current = Date.now() + FORCE_FOLLOW_MS
    messagesEndRef.current?.scrollIntoView({ behavior })
  }

  return {
    messagesEndRef,
    chatContainerRef,
    handleScroll,
    forceScrollToBottom,
  }
}

export default useChatScroll
