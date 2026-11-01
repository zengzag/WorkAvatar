import type { Employee, ThinkingLevel } from '../../types'
import i18n from '../../i18n'
import { generateId } from '../../utils/format'
import { getSceneDefaultModel } from '../../utils/default-model'
import { getToolDisplayName } from '../../utils/tool-display'
import { resolveEmployeeAvatarIcon } from '../common/EmployeeAvatar'
import { useSecretaryStore, selectBusSummary, type SecretaryTask } from './secretary.store'
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
const sessionByTask = new Map<string, string>()

let installed = false

const store = () => useSecretaryStore.getState()

/** 把任务汇总成挂件状态（面板窗是唯一数据源，挂件窗只消费） */
export function broadcastSecretaryState(): void {
  const summary = selectBusSummary(store().tasks)
  const focus = summary.waiting || summary.latest || summary.unreadFirst
  postSecretaryMessage({
    type: 'state',
    payload: {
      status: summary.status,
      bubble: summary.waiting
        ? String(i18n.t('secretary.waiting'))
        : summary.latest
          ? (summary.latest.step || String(i18n.t('secretary.working')))
          : '',
      runningCount: summary.runningCount,
      unreadCount: summary.unreadCount,
      petColor: focus?.employee.avatarColor || undefined,
      petImage: focus?.employee.avatarImage || null,
      petIcon: focus?.employee.avatarIcon || undefined,
    },
  })
}

// 任务增删改都要同步给挂件窗；模块加载即广播一次，挂件窗晚于面板创建时也能拿到状态
useSecretaryStore.subscribe(() => broadcastSecretaryState())
broadcastSecretaryState()

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

  // 停用小秘书会销毁面板窗：先把在跑的任务中止并落状态，避免任务留在“执行中”且继续在后台跑工具
  window.electronAPI.secretary.onSettingsChanged((settings) => {
    if (!settings.enabled) abortAllSecretaryTasks()
  })
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

/** 会话消息：用户原始任务 + 助手输出（主窗口打开任务时按普通消息渲染） */
function buildMessages(task: SecretaryTask, content: string, endedAt: number): unknown[] {
  return [
    { id: generateId(), role: 'user', content: task.prompt || task.title, timestamp: task.startedAt },
    { id: generateId(), role: 'assistant', content, timestamp: endedAt },
  ]
}

async function notifyDone(task: SecretaryTask, ok: boolean): Promise<void> {
  try {
    const state = await window.electronAPI.secretary.getState()
    if (state.settings.dnd) return
    if (state.panelOpen) return
    await window.electronAPI.notification.sendNotification({
      title: String(i18n.t(ok ? 'secretary.notifyDoneTitle' : 'secretary.notifyFailedTitle', { name: task.employee.name })),
      body: task.title,
      // 与自动化任务同一跳转约定：clickId 携带 { employeeId, conversationId }
      clickTarget: 'tasks',
      clickId: JSON.stringify({ employeeId: task.employee.id, conversationId: task.conversationId }),
      source: 'secretary',
    })
  } catch { /* 通知失败静默 */ }
}

async function finishTask(entry: SessionEntry, status: 'done' | 'failed'): Promise<void> {
  const task = findTask(entry.taskId)
  if (!task) return
  const endedAt = Date.now()
  const text = entry.text.trim()
  const content = text || (status === 'done'
    ? String(i18n.t('secretary.noTextResult'))
    : (task.error || String(i18n.t('secretary.failed'))))
  if (task.conversationId) {
    await persistMessages(task.conversationId, buildMessages(task, content, endedAt))
  }
  store().patchTask(entry.taskId, {
    status,
    step: '',
    endedAt,
    viewed: false,
  })
  sessionByTask.delete(entry.taskId)
  void notifyDone(task, status === 'done')
}

/** 发起任务：返回任务 id（创建失败抛错，由调用方提示） */
export async function startSecretaryTask(params: {
  employee: Employee
  prompt: string
  /** 附件真实路径（面板本地拖入或从挂件窗转交） */
  attachmentPaths?: string[]
  /** 面板上选中的模型；未选时回落到场景默认模型 */
  providerId?: string
  modelId?: string
  /** 思考强度；面板默认开启 */
  enableThinking?: ThinkingLevel
}): Promise<string> {
  installSecretaryRunner()

  const { employee, prompt } = params
  const paths = params.attachmentPaths || []
  const content = paths.length
    ? `${prompt}\n\n参考附件：\n${paths.map((p) => `- ${p}`).join('\n')}`
    : prompt
  const firstFileName = paths[0]?.split(/[\\/]/).pop() || ''
  const title = prompt.trim().slice(0, 30) || firstFileName || String(i18n.t('secretary.newTask'))

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
      avatarIcon: resolveEmployeeAvatarIcon(employee.avatar_icon, employee.avatar_type, employee.source),
      avatarColor: employee.avatar_color,
      avatarImage: employee.avatar_image,
    },
    status: 'running',
    step: String(i18n.t('secretary.thinking')),
    startedAt: Date.now(),
    viewed: true,
    conversationId: conversation.id,
  }
  store().addTask(task)

  await persistMessages(conversation.id, [
    { id: generateId(), role: 'user', content, timestamp: task.startedAt },
  ])

  // 面板选中的模型优先；未选时用工作台场景默认模型（员工表不存模型绑定）
  let providerId = params.providerId || ''
  let modelId = params.modelId || ''
  if (!providerId) {
    const fallback = await getSceneDefaultModel('workbench')
    providerId = fallback?.provider_id || ''
    modelId = modelId || fallback?.model_id || ''
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
      enable_thinking: params.enableThinking ?? 'high',
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
  sessionByTask.set(taskId, result.sessionId)
  return taskId
}

/** 中止任务（面板上的“停止”）：先落状态，再停主进程运行，最后把已有输出落库 */
export async function abortSecretaryTask(taskId: string): Promise<void> {
  const sessionId = sessionByTask.get(taskId)
  if (!sessionId) return
  const entry = sessions.get(sessionId)
  sessions.delete(sessionId)
  sessionByTask.delete(taskId)

  const task = findTask(taskId)
  const endedAt = Date.now()
  store().patchTask(taskId, {
    status: 'failed',
    error: 'aborted',
    step: '',
    endedAt,
    viewed: false,
  })
  void window.electronAPI.llm.abortChat(sessionId).catch(() => {})

  if (task?.conversationId) {
    const content = (entry?.text || '').trim() || String(i18n.t('secretary.stopped'))
    await persistMessages(task.conversationId, buildMessages(task, content, endedAt))
  }
}

/** 中止所有在跑任务（停用小秘书前调用） */
export function abortAllSecretaryTasks(): void {
  for (const taskId of Array.from(sessionByTask.keys())) void abortSecretaryTask(taskId)
}
