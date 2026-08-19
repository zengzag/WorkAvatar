// 数据模型渲染端状态（zustand）

import { create } from 'zustand'
import {
  createTable, createField, createRelationship, createDataModel,
  type DataModel, type Table, type Field, type Relationship
} from '../shared/domain'
import { dm, type ProjectRecord } from './store'

export interface ChatMessage {
  id: string
  role: 'user' | 'assistant'
  content: string
  reasoning?: string
  toolCalls?: Array<{ id?: string; name?: string; arguments?: string; status?: 'running' | 'done' | 'error'; output?: string }>
  streaming?: boolean
}

interface DataModelState {
  model: DataModel | null
  projects: ProjectRecord[]
  selectedTableId: string | null
  selectedRelationshipId: string | null
  focusRequest: { tableId: string; nonce: number } | null
  layoutRequest: number
  employees: any[]
  providers: any[]
  selectedEmployeeId: string | null
  selectedProviderId: string | null
  selectedModelId: string | null
  settings: { defaultEmployeeId?: string; defaultProviderId?: string; defaultModelId?: string }
  dataDir: string
  // chat
  messages: ChatMessage[]
  isStreaming: boolean
  conversationId: string | null
  chatError: string | null
  chats: Array<{ conversationId: string; employeeId: string; title: string; updatedAt: number }>

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

  // employees/providers
  loadEmployees: () => Promise<void>
  loadProviders: () => Promise<void>
  setSelectedEmployee: (id: string | null) => void
  setSelectedProvider: (id: string | null) => void
  setSelectedModel: (id: string | null) => void

  // settings
  loadSettings: () => Promise<void>
  saveSettings: (patch: Partial<{ defaultEmployeeId: string; defaultProviderId: string; defaultModelId: string }>) => Promise<void>
  loadDataDir: () => Promise<void>
  openDataDir: () => Promise<void>

  // project file export/import
  exportProjectFile: () => Promise<void>
  importProjectFile: () => Promise<void>

  // chat
  sendMessage: (text: string) => Promise<void>
  cancelChat: () => void
  newChat: () => void
  loadChatHistory: (conversationId: string) => Promise<void>
  loadChats: () => Promise<void>
  deleteChat: (conversationId: string) => Promise<void>
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
  employees: [],
  providers: [],
  selectedEmployeeId: null,
  selectedProviderId: null,
  selectedModelId: null,
  settings: {},
  dataDir: '',
  messages: [],
  isStreaming: false,
  conversationId: null,
  chatError: null,
  chats: [],

  setModel: (model) => set({ model: model ? cloneModel(model) : null }),

  applyRemoteModel: (model) => {
    const prev = get().model
    const topologyChanged = !prev || prev.tables.length !== model.tables.length || prev.relationships.length !== model.relationships.length
    set({ model: cloneModel(model) })
    if (topologyChanged) set((s) => ({ layoutRequest: s.layoutRequest + 1 }))
  },

  addTable: (table) => {
    const model = get().model
    if (!model) return
    const next = cloneModel(model)
    next.tables.push(table)
    next.updatedAt = Date.now()
    set({ model: next })
    set((s) => ({ layoutRequest: s.layoutRequest + 1 }))
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
    set((s) => ({ layoutRequest: s.layoutRequest + 1 }))
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
    set((s) => ({ layoutRequest: s.layoutRequest + 1 }))
    void dm.syncModel(next)
  },

  removeRelationship: (id) => {
    const model = get().model
    if (!model) return
    const next = cloneModel(model)
    next.relationships = next.relationships.filter((r) => r.id !== id)
    next.updatedAt = Date.now()
    set({ model: next, selectedRelationshipId: null })
    set((s) => ({ layoutRequest: s.layoutRequest + 1 }))
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
      set((s) => ({ layoutRequest: s.layoutRequest + 1 }))
      await get().loadProjects()
    }
  },

  loadSample: () => {
    const sample = createSampleModel()
    set({ model: cloneModel(sample), selectedTableId: null, selectedRelationshipId: null })
    set((s) => ({ layoutRequest: s.layoutRequest + 1 }))
    void dm.syncModel(sample)
  },

  openProject: async (id) => {
    const res = await dm.openProject(id)
    if ('model' in res) {
      set({ model: cloneModel(res.model), selectedTableId: null, selectedRelationshipId: null })
      set((s) => ({ layoutRequest: s.layoutRequest + 1 }))
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

  loadEmployees: async () => {
    const employees = await dm.listEmployees()
    set({ employees })
    const settings = get().settings
    const preferred = settings.defaultEmployeeId
    if (preferred && employees.some((e) => e.id === preferred)) {
      set({ selectedEmployeeId: preferred })
    } else if (!get().selectedEmployeeId && employees.length > 0) {
      set({ selectedEmployeeId: employees[0].id })
    }
  },

  loadProviders: async () => {
    const providers = await dm.listProviders()
    set({ providers })
    const settings = get().settings
    const preferred = settings.defaultProviderId
    if (preferred && providers.some((p) => p.id === preferred)) {
      set({ selectedProviderId: preferred, selectedModelId: settings.defaultModelId ?? null })
    } else if (!get().selectedProviderId && providers.length > 0) {
      const def = providers.find((p) => p.is_default) ?? providers[0]
      set({ selectedProviderId: def?.id ?? null, selectedModelId: def?.model ?? null })
    }
  },

  setSelectedEmployee: (id) => set({ selectedEmployeeId: id }),
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
      set((s) => ({ layoutRequest: s.layoutRequest + 1 }))
      await get().loadProjects()
    }
  },

  sendMessage: async (text) => {
    const { selectedEmployeeId, employees, selectedProviderId, selectedModelId, conversationId, messages } = get()
    if (!selectedEmployeeId) {
      set({ chatError: 'chat.error.noEmployee' })
      return
    }
    // 模型解析：显式选择 > 员工配置；provider 由主进程兜底（默认 provider）
    const employee = employees.find((e) => e.id === selectedEmployeeId)
    const providerId = selectedProviderId ?? employee?.provider_id
    const modelId = selectedModelId ?? employee?.model_id

    const userMsg: ChatMessage = { id: `u-${Date.now()}`, role: 'user', content: text }
    const assistantMsg: ChatMessage = { id: `a-${Date.now()}`, role: 'assistant', content: '', streaming: true }
    set({ messages: [...messages, userMsg, assistantMsg], isStreaming: true, chatError: null })

    const history = messages
      .filter((m) => m.role === 'user' || (m.role === 'assistant' && m.content))
      .map((m) => ({ role: m.role, content: m.content }))

    const res = await dm.sendChat({
      employeeId: selectedEmployeeId,
      providerId,
      modelId,
      messages: [...history, { role: 'user', content: text }],
      conversationId: conversationId ?? undefined
    })

    if ('error' in res) {
      set({ isStreaming: false, chatError: res.error })
      return
    }
    set({ conversationId: res.conversationId })
  },

  cancelChat: () => {
    void dm.cancelChat()
    set({ isStreaming: false })
  },

  newChat: () => set({ messages: [], conversationId: null, isStreaming: false, chatError: null }),

  loadChatHistory: async (conversationId) => {
    const raw = await dm.chatHistory(conversationId)
    const msgs: ChatMessage[] = (raw as any[]).map((m) => ({
      id: m.id ?? `m-${Date.now()}-${Math.random()}`,
      role: m.role === 'user' ? 'user' : 'assistant',
      content: typeof m.content === 'string' ? m.content : (m.content?.text ?? ''),
      reasoning: m.reasoning_content
    }))
    set({ messages: msgs, conversationId })
  },

  loadChats: async () => {
    const chats = await dm.listChats(get().selectedEmployeeId ?? undefined)
    set({ chats })
  },

  deleteChat: async (conversationId) => {
    await dm.deleteChat(conversationId)
    if (get().conversationId === conversationId) {
      set({ messages: [], conversationId: null })
    }
    await get().loadChats()
  }
}))

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
