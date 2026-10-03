// 跨页面"定位任务"跳转：GlobalSearchBox/App 通知等发起方写入，任务页（Tasks.tsx）消费。
// 需要事件分发（发起时可能已在任务页，无重挂载）+ 持久化兜底（写入先于监听注册的导航竞态）。
export interface PendingTaskJump {
  employeeId: string
  conversationId: string
}

const STORAGE_KEY = 'tasks:pendingTaskJump'

type Listener = (jump: PendingTaskJump) => void
const listeners = new Set<Listener>()

function readPersisted(): PendingTaskJump | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return null
    const v = JSON.parse(raw)
    if (v && typeof v.employeeId === 'string' && typeof v.conversationId === 'string') {
      return v as PendingTaskJump
    }
  } catch { /* ignore */ }
  return null
}

function clearPersisted() {
  try { localStorage.removeItem(STORAGE_KEY) } catch { /* ignore */ }
}

export function requestPendingTaskJump(employeeId: string, conversationId: string) {
  const jump = { employeeId, conversationId }
  // 有在线消费者（Tasks 已挂载）：直接分发并清残留，
  // 否则落盘兜底，等 Tasks 挂载时消费——避免残留导致 Tasks 重挂载后重复跳转
  if (listeners.size > 0) {
    clearPersisted()
    for (const l of Array.from(listeners)) {
      try { l(jump) } catch { /* ignore */ }
    }
    return
  }
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(jump)) } catch { /* ignore */ }
}

// 注册任务页消费者，返回取消函数；注册时立即消费持久化残留（上一次导航的兜底）
export function subscribePendingTaskJump(handleJump: (jump: PendingTaskJump) => void): () => void {
  const listener: Listener = handleJump
  listeners.add(listener)
  const stale = readPersisted()
  if (stale) {
    clearPersisted()
    try { handleJump(stale) } catch { /* ignore */ }
  }
  return () => { listeners.delete(listener) }
}
