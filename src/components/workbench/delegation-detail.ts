import type { MessageSegment } from './types'

/**
 * 委托子过程的按需加载与缓存。
 *
 * 大任务会话返回给渲染进程的是裁剪视图（已完成委托的 subSegments 被外置），
 * 展开某个委托卡片时再通过 IPC 拉取该段完整子过程。缓存带容量上限，避免浏览
 * 多个大任务后内存持续增长；并发展开同一段时复用同一个请求。
 */
const CACHE_LIMIT = 40
const cache = new Map<string, MessageSegment[]>()
const inflight = new Map<string, Promise<MessageSegment[]>>()

const cacheKey = (conversationId: string, messageId: string, segmentId: string): string =>
  `${conversationId}|${messageId}|${segmentId}`

const remember = (key: string, subSegments: MessageSegment[]): void => {
  cache.delete(key)
  cache.set(key, subSegments)
  if (cache.size > CACHE_LIMIT) {
    const oldest = cache.keys().next().value
    if (oldest !== undefined) cache.delete(oldest)
  }
}

export function getCachedDelegationSubSegments(
  conversationId: string,
  messageId: string,
  segmentId: string,
): MessageSegment[] | undefined {
  return cache.get(cacheKey(conversationId, messageId, segmentId))
}

export function loadDelegationSubSegments(
  conversationId: string,
  messageId: string,
  segmentId: string,
): Promise<MessageSegment[]> {
  const key = cacheKey(conversationId, messageId, segmentId)
  const cached = cache.get(key)
  if (cached) return Promise.resolve(cached)
  const running = inflight.get(key)
  if (running) return running

  const request = window.electronAPI.conversation
    .getDelegationDetail({
      conversation_id: conversationId,
      message_id: messageId,
      segment_id: segmentId,
    })
    .then((result: { subSegments?: MessageSegment[] } | null) => {
      const subSegments = Array.isArray(result?.subSegments) ? result!.subSegments! : []
      remember(key, subSegments)
      return subSegments
    })
    .catch(() => [] as MessageSegment[])
    .finally(() => {
      inflight.delete(key)
    })

  inflight.set(key, request)
  return request
}
