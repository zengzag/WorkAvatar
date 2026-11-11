import { describe, it, expect } from 'vitest'
import { forEachChunked, yieldToMain } from '../../../src/utils/schedule'

describe('utils/schedule', () => {
  it('yieldToMain 返回可 await 的 Promise', async () => {
    await expect(yieldToMain()).resolves.toBeUndefined()
  })

  it('forEachChunked 按序访问全部元素', async () => {
    const seen: number[] = []
    const ok = await forEachChunked([1, 2, 3, 4], (n) => seen.push(n))
    expect(ok).toBe(true)
    expect(seen).toEqual([1, 2, 3, 4])
  })

  it('超预算时让出主线程，仍完成全部遍历', async () => {
    const seen: number[] = []
    const ok = await forEachChunked(Array.from({ length: 50 }, (_, i) => i), (n) => {
      const end = performance.now() + 2
      while (performance.now() < end) { /* 模拟耗时工作 */ }
      seen.push(n)
    }, { budgetMs: 1 })
    expect(ok).toBe(true)
    expect(seen).toHaveLength(50)
  })

  it('aborted 返回 true 时中止并返回 false', async () => {
    let count = 0
    const ok = await forEachChunked([1, 2, 3, 4, 5], () => { count++ }, { aborted: () => count >= 2 })
    expect(ok).toBe(false)
    expect(count).toBe(2)
  })
})
