/**
 * LRU 字节受限缓存
 *
 * 基于 Map 插入顺序的 LRU 淘汰（get/set 时移到末尾 = 最近使用）。
 * 总字节数超限时从最旧条目开始淘汰；单条目超过上限时拒绝缓存。
 * 支持 update 原地修改并重算字节（用于增量写入场景）。
 */
export class LRUBoundedCache<V> {
  private cache: Map<string, V> = new Map()
  private bytesMap: Map<string, number> = new Map()
  private totalBytes = 0
  private readonly maxBytes: number
  private readonly computeSize: (value: V) => number

  constructor(maxBytes: number, computeSize: (value: V) => number) {
    this.maxBytes = maxBytes
    this.computeSize = computeSize
  }

  get(key: string): V | undefined {
    if (!this.cache.has(key)) return undefined
    const value = this.cache.get(key)!
    this.cache.delete(key)
    this.cache.set(key, value)
    return value
  }

  has(key: string): boolean {
    return this.cache.has(key)
  }

  set(key: string, value: V): void {
    if (this.cache.has(key)) {
      this.totalBytes -= this.bytesMap.get(key) || 0
      this.cache.delete(key)
      this.bytesMap.delete(key)
    }

    const size = this.computeSize(value)
    if (size > this.maxBytes) return

    while (this.totalBytes + size > this.maxBytes && this.cache.size > 0) {
      const oldestKey = this.cache.keys().next().value as string
      this.totalBytes -= this.bytesMap.get(oldestKey) || 0
      this.cache.delete(oldestKey)
      this.bytesMap.delete(oldestKey)
    }

    this.cache.set(key, value)
    this.bytesMap.set(key, size)
    this.totalBytes += size
  }

  delete(key: string): void {
    if (this.cache.delete(key)) {
      this.totalBytes -= this.bytesMap.get(key) || 0
      this.bytesMap.delete(key)
    }
  }

  clear(): void {
    this.cache.clear()
    this.bytesMap.clear()
    this.totalBytes = 0
  }

  update(key: string, mutator: (value: V) => void): void {
    const value = this.cache.get(key)
    if (!value) return

    const oldSize = this.bytesMap.get(key) || 0
    mutator(value)
    const newSize = this.computeSize(value)

    this.totalBytes = this.totalBytes - oldSize + newSize
    this.bytesMap.set(key, newSize)

    if (newSize > this.maxBytes) {
      this.totalBytes -= newSize
      this.cache.delete(key)
      this.bytesMap.delete(key)
    }
  }

  getBytes(): number {
    return this.totalBytes
  }
}
