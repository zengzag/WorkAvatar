/**
 * 简单的 LRU（最近最少使用）缓存。
 * 用于在切换对话时缓存已解析的消息列表，避免重复 IPC + JSON.parse。
 * 设置 maxSize 后，超过上限时会自动淘汰最久未访问的条目，防止内存泄漏。
 */
export class LRUCache<K, V> {
  private readonly cache = new Map<K, V>()

  constructor(private readonly maxSize: number) {
    if (maxSize <= 0) {
      throw new Error('LRUCache maxSize must be greater than 0')
    }
  }

  get(key: K): V | undefined {
    const value = this.cache.get(key)
    if (value === undefined) return undefined
    // 命中后提升到队尾（最近使用）
    this.cache.delete(key)
    this.cache.set(key, value)
    return value
  }

  has(key: K): boolean {
    return this.cache.has(key)
  }

  set(key: K, value: V): void {
    if (this.cache.has(key)) {
      this.cache.delete(key)
    } else if (this.cache.size >= this.maxSize) {
      // 淘汰最久未使用的条目（Map 按插入顺序，第一个即为最久未使用）
      const oldestKey = this.cache.keys().next().value
      if (oldestKey !== undefined) {
        this.cache.delete(oldestKey)
      }
    }
    this.cache.set(key, value)
  }

  delete(key: K): boolean {
    return this.cache.delete(key)
  }

  clear(): void {
    this.cache.clear()
  }

  get size(): number {
    return this.cache.size
  }

  // 让 LRUCache 可以像原生 Map 一样被 for...of 遍历 / 解构
  [Symbol.iterator](): MapIterator<[K, V]> {
    return this.cache[Symbol.iterator]()
  }

  entries(): MapIterator<[K, V]> {
    return this.cache.entries()
  }

  keys(): MapIterator<K> {
    return this.cache.keys()
  }

  values(): MapIterator<V> {
    return this.cache.values()
  }
}
