/**
 * 主线程让出工具：把长循环切成小片，每片之间把控制权交还浏览器，
 * 让输入事件（鼠标/键盘）先被处理，避免一次性同步计算造成整段冻结。
 */

type SchedulerLike = { yield?: () => Promise<void> }

/** 让出一次主线程（优先 scheduler.yield，其次 MessageChannel，最后 setTimeout） */
export function yieldToMain(): Promise<void> {
  const scheduler = (globalThis as unknown as { scheduler?: SchedulerLike }).scheduler
  if (scheduler?.yield) return scheduler.yield()
  return new Promise<void>((resolve) => {
    if (typeof MessageChannel === 'undefined') {
      setTimeout(resolve, 0)
      return
    }
    const channel = new MessageChannel()
    channel.port1.onmessage = () => {
      channel.port1.close()
      resolve()
    }
    channel.port2.postMessage(null)
  })
}

/**
 * 分片执行数组遍历：单次连续执行超过 budgetMs 就主动让出主线程。
 * 返回 false 表示中途被 abort 取消。
 */
export async function forEachChunked<T>(
  items: readonly T[],
  visit: (item: T, index: number) => void,
  options: { budgetMs?: number; aborted?: () => boolean } = {},
): Promise<boolean> {
  const budget = options.budgetMs ?? 8
  let sliceStart = performance.now()
  for (let i = 0; i < items.length; i++) {
    if (options.aborted?.()) return false
    visit(items[i], i)
    if (performance.now() - sliceStart >= budget) {
      await yieldToMain()
      sliceStart = performance.now()
      if (options.aborted?.()) return false
    }
  }
  return true
}
