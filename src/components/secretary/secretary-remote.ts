import type { Conversation, Employee } from '../../types'
import { defaultConversationTitle } from '../../utils/conversation-title'
import { resolveEmployeeAvatarIcon } from '../common/EmployeeAvatar'
import { useSecretaryStore, type SecretaryTask } from './secretary.store'

/**
 * 主窗口发起的任务镜像：
 * 小秘书任务与会话同源，但主窗口发起的任务没有本地任务记录，
 * 这里从会话列表 + 主进程活跃会话推导出「执行中 / 已结束」，只读展示到面板。
 */

/** 一次拉取的最大会话数：运行中任务一定在最近活跃范围内 */
const LIST_LIMIT = 60
/** 已结束的主窗口任务只展示最近 24 小时内有活动的，避免历史任务把浮窗撑满 */
const FINISHED_WINDOW_SEC = 24 * 60 * 60
const DISMISSED_KEY = 'wa.secretary.dismissedRemote'
const DISMISSED_MAX = 200
/** 小秘书自己创建的会话（永久记录）：即使本地任务已被「完成」移除，也不再镜像成主窗口任务 */
const OWNED_KEY = 'wa.secretary.ownedConversations'
const OWNED_MAX = 200

type ConversationRow = Conversation & { employee_name?: string | null }

/**
 * 自动化插件的运行会话标题固定为「自动化-<标题>-<YYYYMMDDHHmm>」（英文为 Automation-…）。
 * 它的执行走插件宿主进程内调用、不注册 IPC 会话，面板拿不到真实运行态，
 * 纳入镜像会误报「已结束」，因此直接排除（自动化自身页面已有运行状态）。
 */
const AUTOMATION_TITLE_RE = /^(?:自动化|Automation)-.*-\d{12}$/

function readMap(key: string): Record<string, number> {
  try {
    const parsed = JSON.parse(localStorage.getItem(key) || 'null')
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
  } catch {
    return {}
  }
}

function writeMap(key: string, map: Record<string, number>, max: number): void {
  try {
    const entries = Object.entries(map).sort((a, b) => b[1] - a[1]).slice(0, max)
    localStorage.setItem(key, JSON.stringify(Object.fromEntries(entries)))
  } catch { /* ignore */ }
}

function readOwned(): Set<string> {
  return new Set(Object.keys(readMap(OWNED_KEY)))
}

/** 记录小秘书创建的会话，避免「完成」后又被当成主窗口任务重新出现 */
export function markSecretaryOwned(conversationId: string): void {
  const owned = readMap(OWNED_KEY)
  owned[conversationId] = Date.now()
  writeMap(OWNED_KEY, owned, OWNED_MAX)
}

/** 会话最后一条助手消息是否失败/中止（主窗口任务没有本地状态，只能从落库结果判断） */
function readFailure(conversation: { messages_json?: string } | null): 'failed' | 'aborted' | null {
  if (!conversation?.messages_json) return null
  try {
    const messages = JSON.parse(conversation.messages_json)
    if (!Array.isArray(messages)) return null
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i]
      if (msg?.role !== 'assistant') continue
      if (msg.isAborted === true) return 'aborted'
      if (msg.isError === true) return 'failed'
      return null
    }
  } catch { /* 历史解析失败按正常结束处理 */ }
  return null
}

function snapshot(employee: Employee | undefined, id: string, name: string): SecretaryTask['employee'] {
  return {
    id,
    name: employee?.name || name || '',
    avatarIcon: employee
      ? resolveEmployeeAvatarIcon(employee.avatar_icon, employee.avatar_type, employee.source)
      : undefined,
    avatarColor: employee?.avatar_color,
    avatarImage: employee?.avatar_image,
  }
}

let syncSeq = 0

/** 从会话列表重建主窗口任务镜像（并发调用时只采纳最后一次结果） */
export async function syncRemoteTasks(employees: Employee[]): Promise<void> {
  const seq = ++syncSeq
  const [list, active] = await Promise.all([
    window.electronAPI.conversation.listAll({ limit: LIST_LIMIT }).catch(() => []),
    window.electronAPI.llm.listActiveSessions().catch(() => []),
  ])
  const conversations: ConversationRow[] = Array.isArray(list) ? list : []
  const sessions = Array.isArray(active) ? active : []

  const activeByConversation = new Map<string, string>()
  for (const session of sessions) {
    if (session?.conversationId) activeByConversation.set(session.conversationId, session.sessionId)
  }

  // 会话刚创建、首条消息还没落库时不会出现在列表里：按活跃会话补查
  const knownIds = new Set(conversations.map((c) => c.id))
  const missing = Array.from(activeByConversation.keys()).filter((id) => !knownIds.has(id)).slice(0, 20)
  for (const id of missing) {
    const conversation = await window.electronAPI.conversation.get(id).catch(() => null)
    if (conversation) conversations.push(conversation as ConversationRow)
  }

  const state = useSecretaryStore.getState()
  const localIds = new Set(state.tasks.map((t) => t.conversationId).filter(Boolean) as string[])
  const prevByConversation = new Map(state.remoteTasks.map((t) => [t.conversationId, t]))
  const dismissed = readMap(DISMISSED_KEY)
  const owned = readOwned()
  const employeesById = new Map(employees.map((e) => [e.id, e]))

  const remote: SecretaryTask[] = []
  for (const conversation of conversations) {
    if (!conversation?.id || conversation.parent_conversation_id) continue
    if (AUTOMATION_TITLE_RE.test(conversation.title || '')) continue
    if (localIds.has(conversation.id) || owned.has(conversation.id)) continue

    const lastActiveSec = conversation.last_message_at ?? conversation.created_at ?? 0
    // 用户点过「完成」：会话没有新消息前不再出现
    if (dismissed[conversation.id] && lastActiveSec <= dismissed[conversation.id]) continue

    const sessionId = activeByConversation.get(conversation.id)
    const prev = prevByConversation.get(conversation.id)
    // 已结束且超过 24 小时没有新活动：不再展示（运行中任务不受时间限制）
    if (!sessionId && Math.floor(Date.now() / 1000) - lastActiveSec > FINISHED_WINDOW_SEC) continue

    let status: SecretaryTask['status'] = sessionId ? 'running' : 'done'
    let error: string | undefined

    if (!sessionId) {
      if (prev?.status === 'failed') {
        // 保留已判定的失败，避免被下一次同步覆盖成「已完成」
        status = 'failed'
        error = prev.error
      } else if (prev?.status === 'running' || prev?.status === 'waiting') {
        // 刚结束：回读会话最后一条助手消息，区分正常结束 / 失败 / 中止
        const full = await window.electronAPI.conversation.get(conversation.id).catch(() => null)
        const failure = readFailure(full)
        if (failure) {
          status = 'failed'
          error = failure
        }
      }
    }

    const time = lastActiveSec * 1000
    remote.push({
      id: `remote:${conversation.id}`,
      title: conversation.title || defaultConversationTitle(),
      employee: snapshot(employeesById.get(conversation.employee_id), conversation.employee_id, conversation.employee_name || ''),
      status,
      // 执行细节由 runner 的流事件写入；轮询重建时保留同一次运行里已拿到的阶段文案
      step: status === 'running' && prev?.status === 'running' && prev.sessionId === sessionId ? prev.step : '',
      startedAt: time,
      endedAt: status === 'running' ? undefined : time,
      viewed: true,
      conversationId: conversation.id,
      sessionId,
      origin: 'main',
      ...(error ? { error } : {}),
    })
  }

  if (seq !== syncSeq) return
  const running = remote
    .filter((t) => t.status === 'running')
    .sort((a, b) => b.startedAt - a.startedAt)
  const finished = remote
    .filter((t) => t.status !== 'running')
    .sort((a, b) => b.startedAt - a.startedAt)
  useSecretaryStore.getState().setRemoteTasks([...running, ...finished])
}

/** 面板内停止主窗口发起的任务（沿用主进程的会话中止） */
export async function abortRemoteTask(task: SecretaryTask): Promise<void> {
  let sessionId = task.sessionId
  if (!sessionId && task.conversationId) {
    const active = await window.electronAPI.llm.listActiveSessions().catch(() => [])
    sessionId = (Array.isArray(active) ? active : [])
      .find((s) => s.conversationId === task.conversationId)?.sessionId
  }
  if (sessionId) void window.electronAPI.llm.abortChat(sessionId).catch(() => {})
  useSecretaryStore.getState().patchRemoteTask(task.id, {
    status: 'failed',
    error: 'aborted',
    step: '',
    endedAt: Date.now(),
    sessionId: undefined,
  })
}

/** 「完成」主窗口任务：只在面板隐藏，主窗口任务列表不受影响 */
export function dismissRemoteTask(task: SecretaryTask): void {
  if (task.conversationId) {
    const dismissed = readMap(DISMISSED_KEY)
    dismissed[task.conversationId] = Math.floor(Date.now() / 1000)
    writeMap(DISMISSED_KEY, dismissed, DISMISSED_MAX)
  }
  useSecretaryStore.getState().removeRemoteTask(task.id)
}
