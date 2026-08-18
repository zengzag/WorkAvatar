/**
 * 插件事件总线实现（services.events）。
 * - 订阅：插件订阅宿主事件或其他插件发布的事件（白名单校验由宿主在入口做）
 * - 发布：插件发布事件，事件名强制 plugin:<id>: 前缀
 * 依赖注入设计，便于单元测试 mock。
 */

/** 事件监听器集合：event → Set<callback> */
export type EventListenerMap = Map<string, Set<(payload: unknown) => void>>

/** 创建事件总线（宿主持有全局 listenerMap，插件间共享） */
export function createEventBus(
  listenerMap: EventListenerMap,
  pluginId: string,
  logger: { warn(message: string, ...args: unknown[]): void }
) {
  return {
    /** 订阅事件，返回取消订阅函数 */
    subscribe(event: string, callback: (payload: unknown) => void): () => void {
      let set = listenerMap.get(event)
      if (!set) {
        set = new Set()
        listenerMap.set(event, set)
      }
      set.add(callback)
      return () => { set.delete(callback) }
    },

    /** 发布事件（事件名强制 plugin:<id>: 前缀，避免跨插件冲突） */
    publish(event: string, payload?: unknown): void {
      const fullEvent = event.startsWith('plugin:') ? event : `plugin:${pluginId}:${event}`
      const set = listenerMap.get(fullEvent)
      if (!set) return
      for (const cb of set) {
        try { cb(payload) } catch (err: any) {
          logger.warn(`插件事件 ${fullEvent} 回调失败:`, err?.message || err)
        }
      }
    },
  }
}

/** 宿主向所有订阅插件广播事件（内核事件转发） */
export function notifyEvent(listenerMap: EventListenerMap, event: string, payload: unknown): void {
  const set = listenerMap.get(event)
  if (!set) return
  for (const cb of set) {
    try { cb(payload) } catch { /* 忽略单个回调异常 */ }
  }
}
