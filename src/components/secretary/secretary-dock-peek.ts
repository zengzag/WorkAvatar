/** 贴边条自动弹出的原因 */
export type DockPeekReason = 'running' | 'waiting' | 'terminal'

/**
 * 由总线任务状态的变化推导是否需要弹出灵动岛。
 * done / failed 只认 running / waiting 之后的第一次变化：
 * 面板轮询会重复广播同一个 done，不能每次都弹；本地展示态回 idle 也不参与这里。
 */
export function dockPeekForStatus(prev: string, next: string): DockPeekReason | null {
  if (next === prev) return null
  if (next === 'running') return 'running'
  if (next === 'waiting') return 'waiting'
  if ((next === 'done' || next === 'failed') && (prev === 'running' || prev === 'waiting')) return 'terminal'
  return null
}
