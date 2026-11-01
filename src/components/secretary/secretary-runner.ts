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

/** 后台任务自己维护的段结构（与任务页 MessageSegment 对齐，打开任务时可直接渲染） */
interface SecretarySegment {
  type: 'thinking' | 'answer' | 'tool_call'
  id: string
  content?: string
  isStreaming?: boolean
  collapsed?: boolean
  timestamp?: number
  completedAt?: number
  toolName?: string
  toolArgs?: any
  toolResult?: any
  toolCallId?: string
  isToolComplete?: boolean
  isToolArgsStreaming?: boolean
}

/** 任务执行期间累计的助手消息要素（后台运行没有消息渲染器，需自己收集后落库） */
interface SessionEntry {
  taskId: string
  sessionId: string
  userMessageId: string
  assistantMessageId: string
  text: string
  thought: string
  segments: SecretarySegment[]
  segSeq: number
  toolSeq: number
  /** 本次任务实际使用的模型：主窗口消息底部据此显示模型标签（与模型对比/重生成共用字段） */
  providerId: string
  modelId: string
  tokenUsage?: {
    promptTokens?: number
    completionTokens?: number
    totalTokens?: number
    cachedTokens?: number
    totalChars?: number
    generationMs?: number
  }
  /** 任务页已接入该运行中会话：收尾由接入方落库（它的段更完整，含委托等） */
  attachedElsewhere: boolean
  finished: boolean
  persistTimer: ReturnType<typeof setTimeout> | null
  /** 落库串行链：保证收尾写入一定晚于在途的进度写入 */
  writeChain: Promise<void>
}

/** 后台任务进度落库节流：任务页打开时从会话里读到完整过程 */
const PERSIST_THROTTLE_MS = 500

const sessions = new Map<string, SessionEntry>()
const sessionByTask = new Map<string, string>()

let installed = false

const store = () => useSecretaryStore.getState()

/** 阶段文案去重后再写 store：思考/正文增量很密，避免每帧触发重渲染与 localStorage 落盘 */
function setStep(taskId: string, step: string): void {
  const task = findTask(taskId)
  if (!task || task.step === step) return
  store().patchTask(taskId, { step })
}

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
    if (text) {
      entry.text += text
      appendTextSegment(entry, 'answer', text)
      setStep(entry.taskId, String(i18n.t('secretary.responding')))
      schedulePersist(entry)
    }
  })

  window.electronAPI.llm.onThought(({ sessionId, thought }) => {
    const entry = sessions.get(sessionId)
    if (!entry || !thought) return
    entry.thought += thought
    appendTextSegment(entry, 'thinking', thought)
    setStep(entry.taskId, String(i18n.t('secretary.thinkingProcess')))
    schedulePersist(entry)
  })

  window.electronAPI.llm.onToolCall(({ sessionId, id, name, args }) => {
    const entry = sessions.get(sessionId)
    if (!entry) return
    closeStreamingSegments(entry)
    entry.segments.push({
      type: 'tool_call',
      id: `${entry.assistantMessageId}_tool_${entry.toolSeq++}`,
      toolName: name,
      toolArgs: args,
      toolCallId: id,
      isToolComplete: false,
      isToolArgsStreaming: false,
      collapsed: true,
      timestamp: Date.now(),
    })
    setStep(entry.taskId, getToolDisplayName(name))
    schedulePersist(entry)
  })

  window.electronAPI.llm.onToolResult(({ sessionId, name, result }) => {
    const entry = sessions.get(sessionId)
    if (!entry) return
    // 工具结果事件不带调用 id，按「同名且未完成」的最后一次调用回填
    for (let i = entry.segments.length - 1; i >= 0; i--) {
      const seg = entry.segments[i]
      if (seg.type === 'tool_call' && seg.toolName === name && !seg.isToolComplete) {
        seg.toolResult = result
        seg.isToolComplete = true
        seg.completedAt = Date.now()
        break
      }
    }
    // 工具结束回到模型生成阶段，文案先回落到「正在处理」，后续正文/思考增量会继续刷新
    setStep(entry.taskId, String(i18n.t('secretary.working')))
    schedulePersist(entry)
  })

  window.electronAPI.llm.onDone(({ sessionId, metadata, attachedElsewhere }) => {
    const entry = sessions.get(sessionId)
    if (!entry) return
    entry.attachedElsewhere = attachedElsewhere === true
    // 后台任务没有渲染端统计用量，这里从 done 元数据补齐（含子会话合并值）
    const usage = metadata?.tokenUsage || metadata?.usage
    if (usage) {
      const normalized = {
        promptTokens: usage.promptTokens ?? usage.prompt_tokens,
        completionTokens: usage.completionTokens ?? usage.completion_tokens,
        totalTokens: usage.totalTokens ?? usage.total_tokens,
        cachedTokens: usage.cachedTokens ?? usage.cached_tokens ?? usage.prompt_tokens_details?.cached_tokens ?? usage.prompt_cache_hit_tokens,
        generationMs: usage.generationMs ?? usage.generation_ms,
      }
      if (Object.values(normalized).some((v) => typeof v === 'number')) entry.tokenUsage = normalized
    }
    if (!entry.tokenUsage && (entry.text.trim() || entry.thought.trim())) {
      entry.tokenUsage = { totalChars: entry.text.trim().length + entry.thought.trim().length }
    }
    sessions.delete(sessionId)
    void finishTask(entry, 'done')
  })

  window.electronAPI.llm.onError(({ sessionId, error, attachedElsewhere }) => {
    const entry = sessions.get(sessionId)
    if (!entry) return
    entry.attachedElsewhere = attachedElsewhere === true
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

/** 关闭所有仍在流式中的段（思考结束才出正文、工具调用前先收口正文） */
function closeStreamingSegments(entry: SessionEntry): void {
  const ts = Date.now()
  for (const seg of entry.segments) {
    if (seg.isStreaming) {
      seg.isStreaming = false
      seg.completedAt = seg.completedAt ?? ts
    }
  }
}

/** 追加思考/正文增量：同类段仍在流式时合并，否则新开一段（保证打开任务时的段顺序） */
function appendTextSegment(entry: SessionEntry, type: 'thinking' | 'answer', text: string): void {
  const last = entry.segments[entry.segments.length - 1]
  if (last && last.type === type && last.isStreaming) {
    last.content = (last.content || '') + text
    return
  }
  closeStreamingSegments(entry)
  entry.segments.push({
    type,
    id: `${entry.assistantMessageId}_seg_${entry.segSeq++}`,
    content: text,
    isStreaming: true,
    timestamp: Date.now(),
    ...(type === 'thinking' ? { collapsed: false } : {}),
  })
}

async function persistMessages(conversationId: string, messages: unknown[], touch = true): Promise<void> {
  try {
    await window.electronAPI.conversation.update({
      id: conversationId,
      messages_json: JSON.stringify(messages),
      message_count: messages.length,
      ...(touch ? { last_message_at: Math.floor(Date.now() / 1000) } : {}),
    })
  } catch { /* 落库失败不影响任务本身 */ }
}

/**
 * 运行中把已发生的思考/正文/工具调用落库（节流）：
 * 主窗口中途打开任务时能直接读到「打开之前」的完整过程，而不是从接入那一刻才开始。
 */
function schedulePersist(entry: SessionEntry): void {
  if (entry.finished || entry.persistTimer) return
  entry.persistTimer = setTimeout(() => {
    entry.persistTimer = null
    const task = findTask(entry.taskId)
    if (!task?.conversationId || entry.finished) return
    closeStreamingSegments(entry)
    const messages = buildMessages(task, entry, entry.text, Date.now())
    entry.writeChain = entry.writeChain.then(() => persistMessages(task.conversationId!, messages, false))
  }, PERSIST_THROTTLE_MS)
}

/** 会话消息：用户原始任务 + 助手输出（含思考 / 工具调用 / 用量，主窗口按普通消息渲染） */
function buildMessages(task: SecretaryTask, entry: SessionEntry | undefined, content: string, endedAt: number): unknown[] {
  const user = {
    id: entry?.userMessageId || generateId(),
    role: 'user',
    content: task.prompt || task.title,
    timestamp: task.startedAt,
  }
  const assistant: Record<string, unknown> = {
    id: entry?.assistantMessageId || generateId(),
    role: 'assistant',
    content,
    timestamp: endedAt,
  }
  if (entry) {
    const thought = entry.thought.trim()
    if (thought) assistant.thought = thought
    if (entry.segments.length > 0) assistant.segments = entry.segments
    if (entry.tokenUsage) assistant.tokenUsage = entry.tokenUsage
    if (entry.providerId && entry.modelId) {
      assistant.comparisonProviderId = entry.providerId
      assistant.comparisonModelId = entry.modelId
    }
  }
  return [user, assistant]
}

async function finishTask(entry: SessionEntry, status: 'done' | 'failed'): Promise<void> {
  const task = findTask(entry.taskId)
  if (!task) return
  entry.finished = true
  if (entry.persistTimer) {
    clearTimeout(entry.persistTimer)
    entry.persistTimer = null
  }
  const endedAt = Date.now()
  closeStreamingSegments(entry)
  // 历史消息里思考默认折叠，与任务页其他历史消息保持一致
  for (const seg of entry.segments) {
    if (seg.type === 'thinking') seg.collapsed = true
  }
  const text = entry.text.trim()
  const content = text || (status === 'done'
    ? String(i18n.t('secretary.noTextResult'))
    : (task.error || String(i18n.t('secretary.failed'))))
  // 任务页已接入时由它写回（段更完整，含委托子任务），避免两边互相覆盖
  if (task.conversationId && !entry.attachedElsewhere) {
    const messages = buildMessages(task, entry, content, endedAt)
    entry.writeChain = entry.writeChain.then(() => persistMessages(task.conversationId!, messages))
    await entry.writeChain
  }
  store().patchTask(entry.taskId, {
    status,
    step: '',
    endedAt,
    viewed: false,
  })
  sessionByTask.delete(entry.taskId)
  // 完成提醒只走挂件（气泡 + 未读角标），不再重复发系统通知
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

  const userMessageId = generateId()
  await persistMessages(conversation.id, [
    { id: userMessageId, role: 'user', content, timestamp: task.startedAt },
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

  sessions.set(result.sessionId, {
    taskId,
    sessionId: result.sessionId,
    userMessageId,
    assistantMessageId: generateId(),
    text: '',
    thought: '',
    segments: [],
    segSeq: 0,
    toolSeq: 0,
    providerId,
    modelId,
    attachedElsewhere: false,
    finished: false,
    persistTimer: null,
    writeChain: Promise.resolve(),
  })
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

  // 中止前查询是否有任务页接入：有则让它写回（含完整过程），避免两边互相覆盖
  const attachedElsewhere = await window.electronAPI.llm.isSessionAttached(sessionId).catch(() => false)

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

  if (entry) {
    entry.finished = true
    if (entry.persistTimer) {
      clearTimeout(entry.persistTimer)
      entry.persistTimer = null
    }
    closeStreamingSegments(entry)
  }
  if (task?.conversationId && !attachedElsewhere) {
    const content = (entry?.text || '').trim() || String(i18n.t('secretary.stopped'))
    const messages = buildMessages(task, entry, content, endedAt)
    const conversationId = task.conversationId
    if (entry) {
      entry.writeChain = entry.writeChain.then(() => persistMessages(conversationId, messages))
      await entry.writeChain
    } else {
      await persistMessages(conversationId, messages)
    }
  }
}

/** 中止所有在跑任务（停用小秘书前调用） */
export function abortAllSecretaryTasks(): void {
  for (const taskId of Array.from(sessionByTask.keys())) void abortSecretaryTask(taskId)
}
