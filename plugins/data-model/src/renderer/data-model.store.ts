// 数据模型渲染端状态（zustand）

import { create } from 'zustand'
import {
  createTable, createField, createRelationship, createDataModel,
  type DataModel, type Table, type Field, type Relationship
} from '../shared/domain'
import { dm, hostT, type ProjectRecord } from './store'
import type { GenericChatViewMessage, GenericChatViewSegment } from '../../../plugin-sdk/src/renderer'

/** 对话消息：复用宿主任务对话 UI 的消息结构（segments 驱动工具调用/思考/回答渲染） */
export type ChatMessage = GenericChatViewMessage

interface DataModelState {
  model: DataModel | null
  projects: ProjectRecord[]
  selectedTableId: string | null
  selectedRelationshipId: string | null
  focusRequest: { tableId: string; nonce: number } | null
  layoutRequest: number
  providers: any[]
  selectedProviderId: string | null
  selectedModelId: string | null
  settings: { defaultProviderId?: string; defaultModelId?: string }
  dataDir: string
  // chat
  messages: ChatMessage[]
  isStreaming: boolean
  conversationId: string | null
  chatError: string | null
  chats: Array<{ conversationId: string; title: string; updatedAt: number; workspacePath?: string | null }>
  /** 当前会话的任务工作区目录（用于"打开任务文件夹"等） */
  workspacePath: string | null
  /** 当前会话上下文用量统计（done 事件 metadata.contextStats） */
  contextStats: any

  // model
  setModel: (model: DataModel | null) => void
  applyRemoteModel: (model: DataModel) => void
  addTable: (table: Table) => void
  updateTable: (id: string, patch: Partial<Table>) => void
  removeTable: (id: string) => void
  addField: (tableId: string, field: Field) => void
  updateField: (tableId: string, fieldId: string, patch: Partial<Field>) => void
  removeField: (tableId: string, fieldId: string) => void
  addRelationship: (rel: Relationship) => void
  removeRelationship: (id: string) => void
  selectTable: (id: string | null) => void
  selectRelationship: (id: string | null) => void
  focusTable: (id: string) => void
  requestLayout: () => void

  // projects
  loadProjects: () => Promise<void>
  createProject: (name?: string) => Promise<void>
  loadSample: () => void
  openProject: (id: string) => Promise<void>
  deleteProject: (id: string) => Promise<void>
  saveProject: () => Promise<void>
  renameProject: (id: string, name: string) => Promise<void>

  // employees/providers
  loadProviders: () => Promise<void>
  setSelectedProvider: (id: string | null) => void
  setSelectedModel: (id: string | null) => void

  // settings
  loadSettings: () => Promise<void>
  saveSettings: (patch: Partial<{ defaultProviderId: string; defaultModelId: string }>) => Promise<void>
  loadDataDir: () => Promise<void>
  openDataDir: () => Promise<void>

  // project file export/import
  exportProjectFile: () => Promise<void>
  importProjectFile: () => Promise<void>

  // chat
  sendMessage: (text: string, images?: string[]) => Promise<void>
  cancelChat: () => void
  newChat: () => void
  loadChatHistory: (conversationId: string) => Promise<void>
  loadChats: () => Promise<void>
  deleteChat: (conversationId: string) => Promise<{ ok: boolean; taskDir?: string; taskDirNonEmpty?: boolean } | { error: string }>
  openChatDir: (conversationId: string) => Promise<void>
  deleteMessage: (msgId: string) => Promise<void>
  toggleSegment: (msgId: string, segId: string) => void
}

function cloneModel(model: DataModel): DataModel {
  return JSON.parse(JSON.stringify(model)) as DataModel
}

export const useDataModelStore = create<DataModelState>((set, get) => ({
  model: null,
  projects: [],
  selectedTableId: null,
  selectedRelationshipId: null,
  focusRequest: null,
  layoutRequest: 0,
  providers: [],
  selectedProviderId: null,
  selectedModelId: null,
  settings: {},
  dataDir: '',
  messages: [],
  isStreaming: false,
  conversationId: null,
  chatError: null,
  chats: [],
  workspacePath: null,
  contextStats: null,

  setModel: (model) => set({ model: model ? cloneModel(model) : null }),

  applyRemoteModel: (model) => {
    const prev = get().model
    const topologyChanged = !prev || topologyChangedFn(prev, model)
    set({ model: cloneModel(model) })
    // AI 工具增删表时触发自动排版；纯字段/属性编辑不打扰用户已排好的位置
    if (topologyChanged) set((s) => ({ layoutRequest: s.layoutRequest + 1 }))
  },

  addTable: (table) => {
    const model = get().model
    if (!model) return
    const next = cloneModel(model)
    next.tables.push(table)
    next.updatedAt = Date.now()
    set({ model: next })
    void dm.syncModel(next)
  },

  updateTable: (id, patch) => {
    const model = get().model
    if (!model) return
    const next = cloneModel(model)
    next.tables = next.tables.map((t) => (t.id === id ? { ...t, ...patch } : t))
    next.updatedAt = Date.now()
    set({ model: next })
    void dm.syncModel(next)
  },

  removeTable: (id) => {
    const model = get().model
    if (!model) return
    const next = cloneModel(model)
    next.tables = next.tables.filter((t) => t.id !== id)
    next.relationships = next.relationships.filter((r) => r.sourceTableId !== id && r.targetTableId !== id)
    next.updatedAt = Date.now()
    set({ model: next, selectedTableId: null })
    void dm.syncModel(next)
  },

  addField: (tableId, field) => {
    const model = get().model
    if (!model) return
    const next = cloneModel(model)
    next.tables = next.tables.map((t) => (t.id === tableId ? { ...t, fields: [...t.fields, field] } : t))
    next.updatedAt = Date.now()
    set({ model: next })
    void dm.syncModel(next)
  },

  updateField: (tableId, fieldId, patch) => {
    const model = get().model
    if (!model) return
    const next = cloneModel(model)
    next.tables = next.tables.map((t) =>
      t.id === tableId ? { ...t, fields: t.fields.map((f) => (f.id === fieldId ? { ...f, ...patch } : f)) } : t
    )
    next.updatedAt = Date.now()
    set({ model: next })
    void dm.syncModel(next)
  },

  removeField: (tableId, fieldId) => {
    const model = get().model
    if (!model) return
    const next = cloneModel(model)
    next.tables = next.tables.map((t) =>
      t.id === tableId ? { ...t, fields: t.fields.filter((f) => f.id !== fieldId) } : t
    )
    next.relationships = next.relationships.filter((r) => r.sourceFieldId !== fieldId && r.targetFieldId !== fieldId)
    next.updatedAt = Date.now()
    set({ model: next })
    void dm.syncModel(next)
  },

  addRelationship: (rel) => {
    const model = get().model
    if (!model) return
    const next = cloneModel(model)
    next.relationships.push(rel)
    next.updatedAt = Date.now()
    set({ model: next })
    void dm.syncModel(next)
  },

  removeRelationship: (id) => {
    const model = get().model
    if (!model) return
    const next = cloneModel(model)
    next.relationships = next.relationships.filter((r) => r.id !== id)
    next.updatedAt = Date.now()
    set({ model: next, selectedRelationshipId: null })
    void dm.syncModel(next)
  },

  selectTable: (id) => set({ selectedTableId: id, selectedRelationshipId: null }),
  selectRelationship: (id) => set({ selectedRelationshipId: id, selectedTableId: null }),
  focusTable: (id) => set((s) => ({ focusRequest: { tableId: id, nonce: (s.focusRequest?.nonce ?? 0) + 1 } })),
  requestLayout: () => set((s) => ({ layoutRequest: s.layoutRequest + 1 })),

  loadProjects: async () => {
    const projects = await dm.listProjects()
    set({ projects })
  },

  createProject: async (name) => {
    const res = await dm.createProject(name)
    if ('model' in res) {
      set({ model: cloneModel(res.model), selectedTableId: null, selectedRelationshipId: null })
      await get().loadProjects()
    }
  },

  loadSample: () => {
    const sample = createSampleModel()
    set({ model: cloneModel(sample), selectedTableId: null, selectedRelationshipId: null })
    void dm.syncModel(sample)
  },

  openProject: async (id) => {
    const res = await dm.openProject(id)
    if ('model' in res) {
      set({ model: cloneModel(res.model), selectedTableId: null, selectedRelationshipId: null })
    }
  },

  deleteProject: async (id) => {
    await dm.deleteProject(id)
    await get().loadProjects()
  },

  saveProject: async () => {
    await dm.saveProject()
    await get().loadProjects()
  },

  renameProject: async (id, name) => {
    await dm.renameProject(id, name)
    const model = get().model
    if (model && model.id === id) {
      set({ model: cloneModel({ ...model, name, updatedAt: Date.now() }) })
    }
    await get().loadProjects()
  },

  loadProviders: async () => {
    const providers = await dm.listProviders()
    set({ providers })
    const settings = get().settings
    const preferred = settings.defaultProviderId
    const current = get().selectedProviderId
    if (preferred && providers.some((p) => p.id === preferred)) {
      set({ selectedProviderId: preferred, selectedModelId: settings.defaultModelId ?? null })
    } else if (current && providers.some((p) => p.id === current)) {
      // 当前选择仍有效，保持不变
    } else if (providers.length > 0) {
      const def = providers.find((p) => p.is_default) ?? providers[0]
      set({ selectedProviderId: def?.id ?? null, selectedModelId: def?.model ?? null })
    } else {
      set({ selectedProviderId: null, selectedModelId: null })
    }
  },

  setSelectedProvider: (id) => set({ selectedProviderId: id, selectedModelId: null }),
  setSelectedModel: (id) => set({ selectedModelId: id }),

  loadSettings: async () => {
    const { settings } = await dm.getSettings()
    set({ settings: settings ?? {} })
  },

  saveSettings: async (patch) => {
    const next = { ...get().settings, ...patch }
    set({ settings: next })
    await dm.setSettings(next)
  },

  loadDataDir: async () => {
    const { dataDir } = await dm.getDataDir()
    set({ dataDir })
  },

  openDataDir: async () => {
    await dm.openDataDir()
  },

  exportProjectFile: async () => {
    const model = get().model
    if (!model) return
    await dm.exportProjectFile(model)
  },

  importProjectFile: async () => {
    const res = await dm.importProjectFile()
    if (res.model) {
      set({ model: cloneModel(res.model), selectedTableId: null, selectedRelationshipId: null })
      await get().loadProjects()
    }
  },

  sendMessage: async (text, images) => {
    if (get().isStreaming) return
    const { selectedProviderId, selectedModelId, conversationId, messages } = get()
    if (!selectedProviderId) {
      set({ chatError: 'chat.error.noProvider' })
      return
    }

    const now = Date.now()
    const userMsg: ChatMessage = { id: `msg_${now}_u`, role: 'user', content: text, timestamp: now, images }
    const assistantMsg: ChatMessage = { id: `msg_${now}_a`, role: 'assistant', content: '', timestamp: now, isStreaming: true, segments: [] }
    set({ messages: [...messages, userMsg, assistantMsg], isStreaming: true, chatError: null })

    ensureChatEventListener()

    const history = messages
      .filter((m) => m.role === 'user' || (m.role === 'assistant' && m.content))
      .map((m) => ({ id: m.id, role: m.role, content: m.content, images: m.images }))

    const res = await dm.sendChat({
      providerId: selectedProviderId,
      modelId: selectedModelId ?? undefined,
      messages: [...history, { id: userMsg.id, role: 'user', content: text, images }],
      assistantId: assistantMsg.id,
      conversationId: conversationId ?? undefined
    })

    if ('error' in res) {
      set((state) => {
        const msgs = [...state.messages]
        const last = msgs[msgs.length - 1]
        if (last && last.role === 'assistant') {
          msgs[msgs.length - 1] = { ...last, isStreaming: false, isError: true }
        }
        return { messages: msgs, isStreaming: false, chatError: res.error }
      })
      return
    }
    set({ conversationId: res.conversationId, workspacePath: res.workspacePath ?? null })
  },

  cancelChat: () => {
    void dm.cancelChat()
    set({ isStreaming: false })
  },

  newChat: () => {
    void dm.cancelChat()
    set({ messages: [], conversationId: null, workspacePath: null, isStreaming: false, chatError: null, contextStats: null })
  },

  loadChatHistory: async (conversationId) => {
    ensureChatEventListener()
    const raw = await dm.chatHistory(conversationId)
    const msgs: ChatMessage[] = (raw as any[]).map((m) => ({
      id: m.id ?? `m-${Date.now()}-${Math.random()}`,
      role: m.role === 'user' ? 'user' : 'assistant',
      content: typeof m.content === 'string' ? m.content : (m.content?.text ?? ''),
      thought: m.reasoning_content,
      images: Array.isArray(m.images) ? m.images : undefined,
      segments: Array.isArray(m.segments) ? m.segments : undefined,
      isStreaming: false
    }))
    const ws = get().chats.find((c) => c.conversationId === conversationId)?.workspacePath ?? null
    set({ messages: msgs, conversationId, workspacePath: ws, contextStats: null })
  },

  loadChats: async () => {
    const chats = await dm.listChats()
    set({ chats })
    // 同步当前会话的工作区目录（切换到历史对话后据此显示"打开任务文件夹"）
    const current = get().conversationId
    if (current) {
      const ws = chats.find((c) => c.conversationId === current)?.workspacePath ?? null
      if (get().workspacePath !== ws) set({ workspacePath: ws })
    }
  },

  deleteChat: async (conversationId) => {
    if (get().conversationId === conversationId) void dm.cancelChat()
    const res = await dm.deleteChat(conversationId)
    if ('error' in res && res.error) return res
    if (get().conversationId === conversationId) {
      set({ messages: [], conversationId: null, workspacePath: null })
    }
    await get().loadChats()
    return res
  },

  openChatDir: async (conversationId) => {
    await dm.openChatDir(conversationId)
  },

  deleteMessage: async (msgId) => {
    const convId = get().conversationId
    if (!convId || get().isStreaming) return
    const msgs = get().messages
    const idx = msgs.findIndex((m) => m.id === msgId)
    if (idx === -1) return
    const target = msgs[idx]
    const next = [...msgs]
    next.splice(idx, 1)
    // 删除用户消息时同步删除紧随其后的助手回复（与宿主任务对话语义一致）
    if (target.role === 'user' && next[idx] && next[idx].role === 'assistant') {
      next.splice(idx, 1)
    }
    set({ messages: next })
    await dm.deleteMessage(convId, msgId, target.role, target.content)
  },

  toggleSegment: (msgId, segId) => {
    set((state) => ({
      messages: state.messages.map((m) => {
        if (m.id !== msgId || !m.segments) return m
        return {
          ...m,
          segments: m.segments.map((s) =>
            s.id === segId ? { ...s, collapsed: !s.collapsed } : s
          ),
        }
      }),
    }))
  }
}))

// ====== 对话流式事件 → 消息段更新（与宿主任务对话的 segments 结构一致） ======

/** 关闭流式中的 thinking/answer 段（keepType 指定时仅关闭该类型，其余保持流式） */
function finalizeStreamingSegs(segs: GenericChatViewSegment[], keepType?: 'thinking' | 'answer'): GenericChatViewSegment[] {
  const result = [...segs]
  for (let i = 0; i < result.length; i++) {
    const s = result[i]
    if (!s.isStreaming) continue
    if (keepType === 'thinking' && s.type !== 'thinking') continue
    if (keepType === 'answer' && s.type !== 'answer') continue
    result[i] = { ...s, isStreaming: false, completedAt: s.completedAt || Date.now(), ...(s.type === 'thinking' ? { collapsed: true } : {}) }
  }
  return result
}

function safeParseJson(text: string): any {
  try { return JSON.parse(text) } catch { return undefined }
}

/** 未完成的 tool_call 段收尾：解析流式参数，标记完成（中断/失败） */
function finalizeToolSegments(segs: GenericChatViewSegment[], error?: string): GenericChatViewSegment[] {
  return segs.map((s) => {
    if (s.type !== 'tool_call' || s.isToolComplete) return s
    return {
      ...s,
      toolArgs: s.toolArgs ?? (s.toolArgsRaw ? safeParseJson(s.toolArgsRaw) : undefined),
      toolArgsRaw: undefined,
      isToolArgsStreaming: false,
      isToolComplete: true,
      toolError: error,
      collapsed: true,
      completedAt: s.completedAt || Date.now(),
    }
  })
}

function applyChatEvent(msgs: ChatMessage[], payload: any): ChatMessage[] {
  const last = msgs[msgs.length - 1]
  if (!last || last.role !== 'assistant' || !last.isStreaming) return msgs
  const segs = [...(last.segments || [])]

  switch (payload?.type) {
    case 'chunk': {
      const text = payload.text ?? ''
      if (!text) return msgs
      const updated = finalizeStreamingSegs(segs, 'thinking')
      const lastSeg = updated[updated.length - 1]
      if (lastSeg && lastSeg.type === 'answer' && lastSeg.isStreaming) {
        updated[updated.length - 1] = { ...lastSeg, content: (lastSeg.content || '') + text }
      } else {
        updated.push({ type: 'answer', id: `${last.id}_seg_${updated.length}`, content: text, isStreaming: true, timestamp: Date.now() })
      }
      return [...msgs.slice(0, -1), { ...last, segments: updated, content: (last.content || '') + text }]
    }
    case 'thought': {
      const thought = payload.thought ?? ''
      if (!thought) return msgs
      const updated = finalizeStreamingSegs(segs, 'answer')
      const lastSeg = updated[updated.length - 1]
      if (lastSeg && lastSeg.type === 'thinking' && lastSeg.isStreaming) {
        updated[updated.length - 1] = { ...lastSeg, content: (lastSeg.content || '') + thought }
      } else {
        updated.push({ type: 'thinking', id: `${last.id}_seg_${updated.length}`, content: thought, isStreaming: true, collapsed: false, timestamp: Date.now() })
      }
      return [...msgs.slice(0, -1), { ...last, segments: updated, thought: (last.thought || '') + thought }]
    }
    case 'tool-call-delta': {
      const delta = payload.delta ?? {}
      const argsText = delta.arguments ?? ''
      const updated = finalizeStreamingSegs(segs)
      let targetIndex = -1
      if (delta.id) {
        targetIndex = updated.findIndex((s) => s.type === 'tool_call' && s.toolCallId === delta.id)
      }
      if (targetIndex === -1) {
        targetIndex = updated.findIndex((s) => s.type === 'tool_call' && s.isToolComplete === false && s.toolName === delta.name)
      }
      if (targetIndex !== -1) {
        updated[targetIndex] = {
          ...updated[targetIndex],
          toolName: delta.name || updated[targetIndex].toolName,
          toolCallId: delta.id || updated[targetIndex].toolCallId,
          toolArgsRaw: (updated[targetIndex].toolArgsRaw || '') + argsText,
        }
      } else {
        updated.push({
          type: 'tool_call', id: `${last.id}_tool_${updated.length}`,
          toolName: delta.name || '', toolCallId: delta.id || `delta_${delta.index}`,
          toolArgsRaw: argsText, isToolArgsStreaming: true, isToolComplete: false,
          collapsed: false, timestamp: Date.now(),
        })
      }
      return [...msgs.slice(0, -1), { ...last, segments: updated }]
    }
    case 'tool-call': {
      const tc = payload.toolCall ?? {}
      const updated = finalizeStreamingSegs(segs)
      // 优先复用 delta 阶段创建的参数流式段，避免产生重复的 tool_call 段
      let targetIndex = updated.findIndex((s) =>
        s.type === 'tool_call' && s.isToolArgsStreaming === true &&
        (s.toolCallId === tc.id || (s.toolName === tc.name && !s.isToolComplete))
      )
      if (targetIndex !== -1) {
        updated[targetIndex] = {
          ...updated[targetIndex],
          toolName: tc.name,
          toolArgs: tc.arguments,
          toolArgsRaw: undefined,
          isToolArgsStreaming: false,
          toolCallId: tc.id,
          isToolComplete: false,
          collapsed: true,
        }
      } else {
        updated.push({
          type: 'tool_call', id: `${last.id}_tool_${updated.length}`,
          toolName: tc.name, toolCallId: tc.id, toolArgs: tc.arguments,
          isToolComplete: false, collapsed: true, timestamp: Date.now(),
        })
      }
      return [...msgs.slice(0, -1), { ...last, segments: updated }]
    }
    case 'tool-result': {
      const { name, result, success } = payload
      let targetIndex = -1
      for (let i = segs.length - 1; i >= 0; i--) {
        if (segs[i].type === 'tool_call' && segs[i].toolName === name && !segs[i].isToolComplete) {
          targetIndex = i
          break
        }
      }
      if (targetIndex === -1) return msgs
      const prev = segs[targetIndex]
      const rawArgs = prev.toolArgsRaw
      segs[targetIndex] = {
        ...prev,
        toolArgs: prev.toolArgs ?? (rawArgs ? safeParseJson(rawArgs) : undefined),
        toolArgsRaw: undefined,
        isToolArgsStreaming: false,
        toolResult: result,
        isToolComplete: true,
        toolError: success === false ? (typeof result === 'string' ? result : undefined) : undefined,
        collapsed: true,
        completedAt: Date.now(),
      }
      return [...msgs.slice(0, -1), { ...last, segments: segs }]
    }
    case 'tool-progress': {
      const { toolCallId, name, progress } = payload
      let targetIndex = -1
      if (toolCallId) {
        targetIndex = segs.findIndex((s) => s.type === 'tool_call' && s.toolCallId === toolCallId && !s.isToolComplete)
      }
      if (targetIndex === -1) {
        for (let i = segs.length - 1; i >= 0; i--) {
          if (segs[i].type === 'tool_call' && segs[i].toolName === name && !segs[i].isToolComplete) {
            targetIndex = i
            break
          }
        }
      }
      if (targetIndex === -1) return msgs
      segs[targetIndex] = {
        ...segs[targetIndex],
        toolProgress: [...(segs[targetIndex].toolProgress || []), progress],
      }
      return [...msgs.slice(0, -1), { ...last, segments: segs }]
    }
    case 'done': {
      const metadata = payload.metadata ?? {}
      const finalized = finalizeToolSegments(segs, hostT('chat.toolCancelled')).map((s) => ({
        ...s,
        isStreaming: false,
        completedAt: s.completedAt || Date.now(),
        ...(s.type === 'thinking' ? { collapsed: true } : {}),
      }))
      const usage = metadata.tokenUsage ?? metadata.usage
      const tokenUsage = usage
        ? {
            promptTokens: usage.promptTokens ?? usage.prompt_tokens,
            completionTokens: usage.completionTokens ?? usage.completion_tokens,
            totalTokens: usage.totalTokens ?? usage.total_tokens,
            cachedTokens: usage.cachedTokens ?? usage.cached_tokens,
          }
        : undefined
      return [...msgs.slice(0, -1), { ...last, segments: finalized, isStreaming: false, tokenUsage }]
    }
    case 'error': {
      const error = payload.error ?? hostT('chat.toolFailed')
      const finalized = finalizeToolSegments(segs, error).map((s) => ({
        ...s,
        isStreaming: false,
        completedAt: s.completedAt || Date.now(),
        ...(s.type === 'thinking' ? { collapsed: true } : {}),
      }))
      return [...msgs.slice(0, -1), { ...last, segments: finalized, isStreaming: false, isError: true, content: last.content || error }]
    }
    default:
      return msgs
  }
}

// 模块级单例订阅：对话事件流在面板收起/展开期间持续更新 store 消息
let chatEventListenerReady = false

function ensureChatEventListener(): void {
  if (chatEventListenerReady) return
  chatEventListenerReady = true
  dm.onChatEvent((payload: any) => {
    useDataModelStore.setState((state) => {
      const messages = applyChatEvent(state.messages, payload)
      const done = payload?.type === 'done' || payload?.type === 'error'
      return {
        messages,
        isStreaming: done ? false : state.isStreaming,
        chatError: payload?.type === 'error' ? (payload.error ?? null) : state.chatError,
        contextStats: done ? (payload?.metadata?.contextStats ?? state.contextStats) : state.contextStats,
      }
    })
  })
}

/** 示例博客模型（users / posts / comments） */
function createSampleModel(): DataModel {
  const users = createTable({
    name: 'users', color: '#3b82f6',
    fields: [
      createField({ name: 'id', type: 'bigint', primaryKey: true, nullable: false, autoIncrement: true }),
      createField({ name: 'email', type: 'varchar', typeLength: '255', unique: true, nullable: false }),
      createField({ name: 'name', type: 'varchar', typeLength: '100', nullable: false }),
      createField({ name: 'created_at', type: 'timestamp', nullable: false, defaultValue: 'now()' })
    ]
  })
  const posts = createTable({
    name: 'posts', color: '#10b981',
    fields: [
      createField({ name: 'id', type: 'bigint', primaryKey: true, nullable: false, autoIncrement: true }),
      createField({ name: 'user_id', type: 'bigint', nullable: false }),
      createField({ name: 'title', type: 'varchar', typeLength: '200', nullable: false }),
      createField({ name: 'content', type: 'text' }),
      createField({ name: 'published_at', type: 'timestamp' })
    ]
  })
  const comments = createTable({
    name: 'comments', color: '#f59e0b',
    fields: [
      createField({ name: 'id', type: 'bigint', primaryKey: true, nullable: false, autoIncrement: true }),
      createField({ name: 'post_id', type: 'bigint', nullable: false }),
      createField({ name: 'user_id', type: 'bigint', nullable: false }),
      createField({ name: 'body', type: 'text', nullable: false }),
      createField({ name: 'created_at', type: 'timestamp', nullable: false, defaultValue: 'now()' })
    ]
  })
  const userId = users.fields.find((f) => f.name === 'id')!.id
  const userFk = posts.fields.find((f) => f.name === 'user_id')!.id
  const postId = posts.fields.find((f) => f.name === 'id')!.id
  const postFk = comments.fields.find((f) => f.name === 'post_id')!.id
  const commentUserFk = comments.fields.find((f) => f.name === 'user_id')!.id
  const model = createDataModel({
    name: '示例博客模型',
    tables: [users, posts, comments],
    relationships: [
      createRelationship({ sourceTableId: users.id, sourceFieldId: userId, targetTableId: posts.id, targetFieldId: userFk, sourceCardinality: 'one', targetCardinality: 'many' }),
      createRelationship({ sourceTableId: posts.id, sourceFieldId: postId, targetTableId: comments.id, targetFieldId: postFk, sourceCardinality: 'one', targetCardinality: 'many' }),
      createRelationship({ sourceTableId: users.id, sourceFieldId: userId, targetTableId: comments.id, targetFieldId: commentUserFk, sourceCardinality: 'one', targetCardinality: 'many' })
    ]
  })
  model.tables.forEach((t, i) => {
    t.x = 80 + (i % 3) * 320
    t.y = 80 + Math.floor(i / 3) * 240
  })
  return model
}

/**
 * 判断两次 model 之间的拓扑结构是否发生变化（增删表或增删关系）。
 * 用于决定 AI 工具操作后是否需要自动排版——
 * 纯字段编辑、属性修改不打扰用户已排好的位置。
 */
function topologyChangedFn(a: DataModel, b: DataModel): boolean {
  const aTableIds = new Set(a.tables.map((t) => t.id))
  const bTableIds = new Set(b.tables.map((t) => t.id))
  if (aTableIds.size !== bTableIds.size) return true
  for (const id of aTableIds) {
    if (!bTableIds.has(id)) return true
  }
  const aRelIds = new Set(a.relationships.map((r) => r.id))
  const bRelIds = new Set(b.relationships.map((r) => r.id))
  if (aRelIds.size !== bRelIds.size) return true
  for (const id of aRelIds) {
    if (!bRelIds.has(id)) return true
  }
  return false
}
