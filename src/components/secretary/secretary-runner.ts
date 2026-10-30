import type { Employee } from '../../types'
import { generateId } from '../../utils/format'
import { getSceneDefaultModel } from '../../utils/default-model'
import { getToolDisplayName } from '../../utils/tool-display'
import { useSecretaryStore, type SecretaryTask } from './secretary.store'
import { postSecretaryMessage } from './secretary-bus'

/**
 * 小秘书任务执行器：
 * - 与任务页走同一条链路（conversation.create → llm.employeeChatStream → 消息落库），
 *   因此任务会出现在主窗口任务列表，工具、技能、权限确认全部生效；
 * - 每个任务独立 session，可并发；
 * - 权限 / ask_user 弹窗由面板窗口的 UnifiedInteractionModal 承接（IPC 会话绑定发起窗口）。
 */

interface SessionEntry {
  taskId: string
  text: string
}

const sessions = new Map<string, SessionEntry>()
const taskBySession = new Map<string, string>()
const sessionByTask = new Map<string, string>()

let installed = false

const store = () => useSecretaryStore.getState()

function broadcast(): void {
  const tasks = store().tasks
  const running = tasks.filter((t) => t.status === 'running' || t.status === 'waiting')
  const unread = tasks.filter((t) => (t.status === 'done' || t.status === 'failed') && !t.viewed)
  const latest = running[0]
  let status: 'idle' | 'running' | 'waiting' | 'done' | 'failed' = 'idle'
  if (latest?.status === 'waiting') status = 'waiting'
  else if (latest) status = 'running'
  else if (unread.length > 0) status = unread[0].status === 'failed' ? 'failed' : 'done'
  postSecretaryMessage({
    type: 'state',
    payload: {
      status,
      bubble: latest ? (latest.step || '正在处理…') : '',
      runningCount: running.length,
      unreadCount: unread.length,
      petColor: (latest || unread[0])?.employee.avatarColor || undefined,
      petImage: (latest || unread[0])?.employee.avatarImage || null,
    },
  })
}

export function installSecretaryRunner(): void {
  if (installed) return
  installed = true

  window.electronAPI.llm.onChunk(({ sessionId, chunk, chunks }) => {
    const entry = sessions.get(sessionId)
    if (!entry) return
    const text = chunk ?? (chunks ? chunks.join('') : '')
    if (text) entry.text += text
  })

  window.electronAPI.llm.onToolCall(({ sessionId, name }) => {
    const entry = sessions.get(sessionId)
    if (!entry) return
    store().patchTask(entry.taskId, { step: getToolDisplayName(name) })
  })

  window.electronAPI.llm.onDone(({ sessionId }) => {
    const entry = sessions.get(sessionId)
    if (!entry) return
    sessions.delete(sessionId)
    void finishTask(entry, 'done')
  })

  window.electronAPI.llm.onError(({ sessionId, error }) => {
    const entry = sessions.get(sessionId)
    if (!entry) return
    sessions.delete(sessionId)
    store().patchTask(entry.taskId, { error })
    void finishTask(entry, 'failed')
  })

  useSecretaryStore.subscribe(() => broadcast())
  broadcast()
}

function findTask(taskId: string): SecretaryTask | undefined {
  return store().tasks.find((t) => t.id === taskId)
}

async function persistMessages(conversationId: string, messages: unknown[]): Promise<void> {
  try {
    await window.electronAPI.conversation.update({
      id: conversationId,
      messages_json: JSON.stringify(messages),
      message_count: messages.length,
      last_message_at: Math.floor(Date.now() / 1000),
    })
  } catch { /* 落库失败不影响任务本身 */ }
}

async function notifyDone(task: SecretaryTask, ok: boolean): Promise<void> {
  try {
    const state = await window.electronAPI.secretary.getState()
    if (state.settings.dnd) return
    if (state.panelOpen) return
    await window.electronAPI.notification.sendNotification({
      title: ok ? `${task.employee.name} 完成了任务` : `${task.employee.name} 任务失败`,
      body: task.title,
      clickTarget: 'tasks',
      clickId: task.conversationId,
      source: 'secretary',
    })
  } catch { /* 通知失败静默 */ }
}

async function finishTask(entry: SessionEntry, status: 'done' | 'failed'): Promise<void> {
  const task = findTask(entry.taskId)
  if (!task) return
  const endedAt = Date.now()
  const content = entry.text || (status === 'done' ? '' : (task.error || '任务失败'))
  if (task.conversationId) {
    const messages = [
      {
        id: generateId(),
        role: 'user',
        content: task.prompt || task.title,
        timestamp: task.startedAt,
      },
      {
        id: generateId(),
        role: 'assistant',
        content,
        timestamp: endedAt,
      },
    ]
    await persistMessages(task.conversationId, messages)
  }
  store().patchTask(entry.taskId, {
    status,
    step: '',
    endedAt,
    viewed: false,
  })
  sessionByTask.delete(entry.taskId)
  taskBySession.delete(task.id)
  void notifyDone(task, status === 'done')
}

/** 发起任务：返回任务 id（创建失败抛错，由调用方提示） */
export async function startSecretaryTask(params: {
  employee: Employee
  prompt: string
  /** 附件真实路径（面板本地拖入或从挂件窗转交） */
  attachmentPaths?: string[]
}): Promise<string> {
  installSecretaryRunner()

  const { employee, prompt } = params
  const paths = params.attachmentPaths || []
  const content = paths.length
    ? `${prompt}\n\n参考附件：\n${paths.map((p) => `- ${p}`).join('\n')}`
    : prompt
  const firstFileName = paths[0]?.split(/[\\/]/).pop() || ''
  const title = prompt.trim().slice(0, 30) || firstFileName || '新任务'

  const conversation = await window.electronAPI.conversation.create({
    employee_id: employee.id,
    title,
  })

  const taskId = generateId()
  const task: SecretaryTask = {
    id: taskId,
    title,
    prompt: content,
    employee: {
      id: employee.id,
      name: employee.name,
      avatarIcon: employee.avatar_icon,
      avatarColor: employee.avatar_color,
      avatarImage: employee.avatar_image,
    },
    status: 'running',
    step: '正在理解任务…',
    startedAt: Date.now(),
    viewed: true,
    conversationId: conversation.id,
  }
  store().addTask(task)

  await persistMessages(conversation.id, [
    { id: generateId(), role: 'user', content, timestamp: task.startedAt },
  ])

  // employees 表存了 provider_id / model_id，Employee 类型未暴露，这里按需读取
  const empRow = employee as Employee & { provider_id?: string | null; model_id?: string | null }
  let providerId = empRow.provider_id || ''
  let modelId = empRow.model_id || ''
  if (!providerId) {
    const fallback = await getSceneDefaultModel('workbench')
    providerId = fallback?.provider_id || ''
    modelId = fallback?.model_id || modelId
  }
  if (!providerId) {
    store().patchTask(taskId, {
      status: 'failed', error: 'no-provider', step: '', endedAt: Date.now(), viewed: false,
    })
    throw new Error('NO_PROVIDER')
  }

  // 会话绑定本次使用的模型：主窗口打开该任务时沿用同一模型
  await window.electronAPI.conversation.update({
    id: conversation.id,
    default_model_json: JSON.stringify({ providerId, modelId }),
  }).catch(() => {})

  let result: { success?: boolean; sessionId?: string } | undefined
  try {
    result = await window.electronAPI.llm.employeeChatStream({
      employee_id: employee.id,
      provider_id: providerId,
      model_id: modelId,
      messages: [{ role: 'user', content }],
      use_skills: true,
      collection_ids: [],
      conversation_id: conversation.id,
      minimal_mode: false,
      high_permission: false,
    })
  } catch (err) {
    // IPC 抛错时任务不能停在“执行中”，否则面板会一直转圈
    store().patchTask(taskId, {
      status: 'failed', error: 'start-failed', step: '', endedAt: Date.now(), viewed: false,
    })
    throw err
  }
  if (!result?.success || !result.sessionId) {
    store().patchTask(taskId, {
      status: 'failed', error: 'start-failed', step: '', endedAt: Date.now(), viewed: false,
    })
    throw new Error('START_FAILED')
  }

  sessions.set(result.sessionId, { taskId, text: '' })
  taskBySession.set(result.sessionId, taskId)
  sessionByTask.set(taskId, result.sessionId)
  return taskId
}

/** 中止任务（面板上的“停止”） */
export async function abortSecretaryTask(taskId: string): Promise<void> {
  const sessionId = sessionByTask.get(taskId)
  if (!sessionId) return
  await window.electronAPI.llm.abortChat(sessionId).catch(() => {})
  sessions.delete(sessionId)
  sessionByTask.delete(taskId)
  store().patchTask(taskId, {
    status: 'failed',
    error: 'aborted',
    step: '',
    endedAt: Date.now(),
    viewed: false,
  })
}
