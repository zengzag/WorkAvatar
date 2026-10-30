import type { SecretaryTaskStatus } from './secretary.store'

/** 挂件窗与面板窗之间的状态同步（同一 partition 下的两个渲染进程） */
export interface SecretaryBusState {
  status: SecretaryTaskStatus | 'idle'
  /** 挂件气泡文案（空 = 不显示） */
  bubble: string
  runningCount: number
  unreadCount: number
  /** 挂件配色跟随当前任务所属员工的头像颜色 */
  petColor?: string
  /** 员工上传的头像图片：挂在挂件胸前作为身份标识 */
  petImage?: string | null
}

export type SecretaryBusMessage =
  | { type: 'state'; payload: SecretaryBusState }
  | { type: 'request-state' }
  | { type: 'toggle-panel' }
  /** 挂件窗拖入文件：受跨窗口限制只传路径，面板窗按路径生成附件 */
  | { type: 'files'; paths: string[] }

const CHANNEL = 'wa-secretary'

/** 面板窗首次创建时还没订阅广播，拖入的文件先落在这里（同源 localStorage 两个窗口共享） */
export const SECRETARY_PENDING_FILES_KEY = 'wa.secretary.pendingFiles'

let channel: BroadcastChannel | null = null

function getChannel(): BroadcastChannel | null {
  if (typeof BroadcastChannel === 'undefined') return null
  if (!channel) channel = new BroadcastChannel(CHANNEL)
  return channel
}

export function postSecretaryMessage(message: SecretaryBusMessage): void {
  try {
    getChannel()?.postMessage(message)
  } catch { /* ignore */ }
}

export function subscribeSecretaryBus(handler: (message: SecretaryBusMessage) => void): () => void {
  const ch = getChannel()
  if (!ch) return () => {}
  const listener = (event: MessageEvent) => {
    const data = event.data as SecretaryBusMessage
    if (data && typeof data.type === 'string') handler(data)
  }
  ch.addEventListener('message', listener)
  return () => ch.removeEventListener('message', listener)
}
