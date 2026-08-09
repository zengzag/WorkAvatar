/**
 * 主进程推送的待打开外部 .md 文件路径队列。
 *
 * 当系统右键"打开方式"或启动参数传入 .md 文件时，主进程通过 IPC 推送给渲染进程。
 * App.tsx 接收后入队并导航到笔记页；Notes.tsx 通过订阅消费队列，
 * 笔记页未挂载时路径暂存于队列，挂载后消费。
 */
const pendingExternalFiles: string[] = []
const subscribers = new Set<(absPath: string) => void>()

export function enqueuePendingExternalFile(absPath: string): void {
  pendingExternalFiles.push(absPath)
  for (const fn of subscribers) fn(absPath)
}

/** 消费所有暂存的待打开文件路径（清空队列） */
export function drainPendingExternalFiles(): string[] {
  return pendingExternalFiles.splice(0, pendingExternalFiles.length)
}

/** 订阅新入队的外部文件路径，返回取消订阅函数 */
export function subscribePendingExternalFiles(callback: (absPath: string) => void): () => void {
  subscribers.add(callback)
  return () => { subscribers.delete(callback) }
}
