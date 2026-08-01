import { contextBridge, ipcRenderer, webUtils } from 'electron'
import { IPC_CHANNELS } from '../shared/ipc-channels'
import type {
  WorkspaceOpenInExplorerParams,
  EmployeeListParams,
  EmployeeCreateParams,
  EmployeeUpdateParams,
  EmployeeDeleteParams,
  ConversationListParams,
  ConversationListWithEmployeeParams,
  ConversationCreateParams,
  ConversationSearchParams,
  AppShowOpenDialogParams,
  AppShowSaveDialogParams,
  LLMProviderCreateParams,
  LLMProviderUpdateParams,
  LLMTestConnectionParams,
  LLMChatParams,
  EmployeeChatStreamParams,
  SettingsGetParams,
  SettingsSetParams,
  EmployeeProfileAnalyzeParams,
  EmployeeProfileRefineParams,
  ToolAssignParams,
  ToolCategoryAssignParams,
  ToolCategoryInfo,
  EmployeeExportConfigParams,
  EmployeeImportConfigParams,
  EmployeeExportPackageParams,
  EmployeeImportPackageParams,
  EmployeeMemoryListParams,
  EmployeeMemoryCreateParams,
  EmployeeMemoryUpdateParams,
  EmployeeMemorySearchParams,
  EmployeeMemoryExtractParams,
  EmployeeMemoryConsolidateParams,
  EmployeeMemoryStatsParams,
  EmployeeMemoryExtractConversationParams,
  KMSAddDirParams,
  KMSUpdateDirParams,
  KMSSearchParams,
  KMSAgentSearchParams,
  KMSGetFileContentParams,
  KMSMCPSetConfigParams,
  KMSGetFileSummariesParams,
  KMSSetSettingsParams,
  KMSRecordSearchHistoryParams,
  KMSGetSearchHistoryParams,
  KMSCreateCollectionParams,
  KMSUpdateCollectionParams,
  KMSAddFileToCollectionParams,
  KMSAddFilesToCollectionParams,
  KMSRemoveFileFromCollectionParams,
  KMSSetCollectionSummaryParams,
  KMSSearchFilesParams,
  KMSGetKnowledgeCardsParams,
  KMSUpdateKnowledgeCardParams,
  KMSSearchKnowledgeCardsParams,
  KMSMCPToolCategoryInfo,
  KMSMCPExposedTool,
  RuntimeEnvInstallParams,
  RuntimeEnvInstallProgress,
  McpSaveParams,
  McpTestParams,
  ListEventsParams,
  ListTodosParams,
  CreateEventInput,
  UpdateEventInput,
  CreateTodoInput,
  UpdateTodoInput,
  CalendarSettings,
  NotifyPayload,
  ListAutomationTasksParams,
  ListAutomationRunsParams,
  CreateAutomationTaskInput,
  UpdateAutomationTaskInput,
  PreviewRunsParams,
  NoteWriteParams,
  NoteCreateParams,
  NoteRenameParams,
  NoteMoveParams,
  NoteCopyParams,
  NoteImportExternalParams,
  NoteSearchParams,
  NoteSaveImageParams,
  NotesSettings,
  NotesDataChangedPayload,
} from '../shared/ipc-channels'
import type {
  VoiceCreateTaskParams,
  VoiceUpdateTaskParams,
  VoiceSaveAudioParams,
  VoiceTranscribeParams,
  VoiceGenerateMinutesParams,
  VoiceSettings,
  VoiceSubtitleConfig,
} from '../shared/ipc-channels'
export type {
  VoiceCreateTaskParams,
  VoiceUpdateTaskParams,
  VoiceSaveAudioParams,
  VoiceTranscribeParams,
  VoiceGenerateMinutesParams,
  VoiceSettings,
  VoiceSubtitleConfig,
} from '../shared/ipc-channels'
export type {
  EventColor,
  TodoPriority,
  TodoStatus,
  RecurrenceRule,
  CalendarEvent,
  CalendarEventInstance,
  CalendarTodo,
  CalendarTodoStats,
  CalendarSettings as CalendarSettingsType,
  ListEventsParams as ListEventsParamsType,
  ListTodosParams as ListTodosParamsType,
  CreateEventInput as CreateEventInputType,
  UpdateEventInput as UpdateEventInputType,
  CreateTodoInput as CreateTodoInputType,
  UpdateTodoInput as UpdateTodoInputType,
  NotifyPayload as NotifyPayloadType,
} from '../shared/ipc-channels'
export type {
  AutomationTask,
  AutomationRun,
  AutomationTaskStatus,
  AutomationRunStatus,
  AutomationTriggeredBy,
  AutomationRecurrenceRule,
  CreateAutomationTaskInput as CreateAutomationTaskInputType,
  UpdateAutomationTaskInput as UpdateAutomationTaskInputType,
  ListAutomationTasksParams as ListAutomationTasksParamsType,
  ListAutomationRunsParams as ListAutomationRunsParamsType,
  PreviewRunsParams as PreviewRunsParamsType,
} from '../shared/ipc-channels'
export type {
  NoteNodeType,
  NoteNode,
  NoteContent,
  NoteSearchSnippet,
  NoteSearchHit,
  NotesSettings as NotesSettingsType,
  NotesDataChangedPayload as NotesDataChangedPayloadType,
} from '../shared/ipc-channels'

const electronAPI = {
  workspace: {
    openInExplorer: (params: WorkspaceOpenInExplorerParams) => ipcRenderer.invoke(IPC_CHANNELS.WORKSPACE_OPEN_IN_EXPLORER, params),
  },

  employee: {
    list: (params?: EmployeeListParams) => ipcRenderer.invoke(IPC_CHANNELS.EMPLOYEE_LIST, params),
    get: (id: string) => ipcRenderer.invoke(IPC_CHANNELS.EMPLOYEE_GET, id),
    create: (params: EmployeeCreateParams) => ipcRenderer.invoke(IPC_CHANNELS.EMPLOYEE_CREATE, params),
    update: (params: EmployeeUpdateParams) => ipcRenderer.invoke(IPC_CHANNELS.EMPLOYEE_UPDATE, params),
    delete: (params: EmployeeDeleteParams) => ipcRenderer.invoke(IPC_CHANNELS.EMPLOYEE_DELETE, params),
    onChanged: (callback: (data: { ts: number }) => void) => {
      const handler = (_event: any, data: { ts: number }) => callback(data)
      ipcRenderer.on(IPC_CHANNELS.EMPLOYEE_ON_CHANGED, handler)
      return () => ipcRenderer.removeListener(IPC_CHANNELS.EMPLOYEE_ON_CHANGED, handler)
    },
    analyzeProfile: (params: EmployeeProfileAnalyzeParams) => ipcRenderer.invoke(IPC_CHANNELS.EMPLOYEE_PROFILE_ANALYZE, params),
    refineProfile: (params: EmployeeProfileRefineParams) => ipcRenderer.invoke(IPC_CHANNELS.EMPLOYEE_PROFILE_REFINE, params),
    onProfileProgress: (callback: (data: { stage: string; detail?: string; chunk?: string }) => void) => {
      const handler = (_event: any, data: { stage: string; detail?: string; chunk?: string }) => callback(data)
      ipcRenderer.on(IPC_CHANNELS.EMPLOYEE_PROFILE_PROGRESS, handler)
      return () => ipcRenderer.removeListener(IPC_CHANNELS.EMPLOYEE_PROFILE_PROGRESS, handler)
    },
    exportConfig: (params: EmployeeExportConfigParams) => ipcRenderer.invoke(IPC_CHANNELS.EMPLOYEE_EXPORT_CONFIG, params),
    importConfig: (params: EmployeeImportConfigParams) => ipcRenderer.invoke(IPC_CHANNELS.EMPLOYEE_IMPORT_CONFIG, params),
    exportPackage: (params: EmployeeExportPackageParams) => ipcRenderer.invoke(IPC_CHANNELS.EMPLOYEE_EXPORT_PACKAGE, params),
    importPackage: (params: EmployeeImportPackageParams) => ipcRenderer.invoke(IPC_CHANNELS.EMPLOYEE_IMPORT_PACKAGE, params),
    onExportProgress: (callback: (data: { employee_id: string; stage: string; detail: string }) => void) => {
      const handler = (_event: any, data: { employee_id: string; stage: string; detail: string }) => callback(data)
      ipcRenderer.on(IPC_CHANNELS.EMPLOYEE_EXPORT_PROGRESS, handler)
      return () => ipcRenderer.removeListener(IPC_CHANNELS.EMPLOYEE_EXPORT_PROGRESS, handler)
    },
    onImportProgress: (callback: (data: { stage: string; detail: string }) => void) => {
      const handler = (_event: any, data: { stage: string; detail: string }) => callback(data)
      ipcRenderer.on(IPC_CHANNELS.EMPLOYEE_IMPORT_PROGRESS, handler)
      return () => ipcRenderer.removeListener(IPC_CHANNELS.EMPLOYEE_IMPORT_PROGRESS, handler)
    },
    listMemories: (params: EmployeeMemoryListParams) => ipcRenderer.invoke(IPC_CHANNELS.EMPLOYEE_MEMORY_LIST, params),
    createMemory: (params: EmployeeMemoryCreateParams) => ipcRenderer.invoke(IPC_CHANNELS.EMPLOYEE_MEMORY_CREATE, params),
    updateMemory: (params: EmployeeMemoryUpdateParams) => ipcRenderer.invoke(IPC_CHANNELS.EMPLOYEE_MEMORY_UPDATE, params),
    deleteMemory: (id: string) => ipcRenderer.invoke(IPC_CHANNELS.EMPLOYEE_MEMORY_DELETE, id),
    togglePinMemory: (id: string) => ipcRenderer.invoke(IPC_CHANNELS.EMPLOYEE_MEMORY_TOGGLE_PIN, id),
    searchMemories: (params: EmployeeMemorySearchParams) => ipcRenderer.invoke(IPC_CHANNELS.EMPLOYEE_MEMORY_SEARCH, params),
    extractMemories: (params: EmployeeMemoryExtractParams) => ipcRenderer.invoke(IPC_CHANNELS.EMPLOYEE_MEMORY_EXTRACT, params),
    consolidateMemories: (params: EmployeeMemoryConsolidateParams) => ipcRenderer.invoke(IPC_CHANNELS.EMPLOYEE_MEMORY_CONSOLIDATE, params),
    getMemoryStats: (params: EmployeeMemoryStatsParams) => ipcRenderer.invoke(IPC_CHANNELS.EMPLOYEE_MEMORY_STATS, params),
    extractConversationMemories: (params: EmployeeMemoryExtractConversationParams) => ipcRenderer.invoke(IPC_CHANNELS.EMPLOYEE_MEMORY_EXTRACT_CONVERSATION, params),
    listTrashedMemories: (params: EmployeeMemoryListParams) => ipcRenderer.invoke(IPC_CHANNELS.EMPLOYEE_MEMORY_LIST_TRASH, params),
    restoreMemory: (id: string) => ipcRenderer.invoke(IPC_CHANNELS.EMPLOYEE_MEMORY_RESTORE, id),
    purgeMemory: (id: string) => ipcRenderer.invoke(IPC_CHANNELS.EMPLOYEE_MEMORY_PURGE, id),
    emptyTrash: (params: EmployeeMemoryListParams) => ipcRenderer.invoke(IPC_CHANNELS.EMPLOYEE_MEMORY_EMPTY_TRASH, params),
  },

  conversation: {
    list: (params: ConversationListParams) => ipcRenderer.invoke(IPC_CHANNELS.CONVERSATION_LIST, params),
    listAll: (params?: ConversationListWithEmployeeParams) => ipcRenderer.invoke(IPC_CHANNELS.CONVERSATION_LIST_ALL, params),
    get: (id: string) => ipcRenderer.invoke(IPC_CHANNELS.CONVERSATION_GET, id),
    create: (params: ConversationCreateParams) => ipcRenderer.invoke(IPC_CHANNELS.CONVERSATION_CREATE, params),
    update: (params: { id: string; title?: string; messages_json?: string; message_count?: number; status?: string; minimal_mode?: boolean; last_message_at?: number; employee_id?: string }) =>
      ipcRenderer.invoke(IPC_CHANNELS.CONVERSATION_UPDATE, params),
    delete: (id: string) => ipcRenderer.invoke(IPC_CHANNELS.CONVERSATION_DELETE, id),
    deleteAll: (employeeId: string) => ipcRenderer.invoke(IPC_CHANNELS.CONVERSATION_DELETE_ALL, employeeId),
    searchGlobal: (params: ConversationSearchParams) => ipcRenderer.invoke(IPC_CHANNELS.CONVERSATION_SEARCH_GLOBAL, params),
  },

  llm: {
    getProviders: () => ipcRenderer.invoke(IPC_CHANNELS.LLM_PROVIDER_LIST),
    createProvider: (params: LLMProviderCreateParams) => ipcRenderer.invoke(IPC_CHANNELS.LLM_PROVIDER_CREATE, params),
    updateProvider: (params: LLMProviderUpdateParams) => ipcRenderer.invoke(IPC_CHANNELS.LLM_PROVIDER_UPDATE, params),
    deleteProvider: (id: string) => ipcRenderer.invoke(IPC_CHANNELS.LLM_PROVIDER_DELETE, id),
    testConnection: (params: LLMTestConnectionParams) => ipcRenderer.invoke(IPC_CHANNELS.LLM_TEST_CONNECTION, params),
    chat: (params: LLMChatParams) => ipcRenderer.invoke(IPC_CHANNELS.LLM_CHAT, params),
    employeeChatStream: (params: EmployeeChatStreamParams) => ipcRenderer.invoke(IPC_CHANNELS.EMPLOYEE_CHAT_STREAM, params),
    abortChat: (sessionId?: string) => ipcRenderer.invoke(IPC_CHANNELS.LLM_ABORT_CHAT, sessionId),
    onChunk: (callback: (data: { sessionId: string; chunk?: string; chunks?: string[] }) => void) => {
      const handler = (_event: any, data: { sessionId: string; chunk?: string; chunks?: string[] }) => callback(data)
      ipcRenderer.on(IPC_CHANNELS.LLM_CHAT_CHUNK, handler)
      return () => ipcRenderer.removeListener(IPC_CHANNELS.LLM_CHAT_CHUNK, handler)
    },
    onDone: (callback: (data: { sessionId: string; metadata?: any }) => void) => {
      const handler = (_event: any, data: { sessionId: string; metadata?: any }) => callback(data)
      ipcRenderer.on(IPC_CHANNELS.LLM_CHAT_DONE, handler)
      return () => ipcRenderer.removeListener(IPC_CHANNELS.LLM_CHAT_DONE, handler)
    },
    onError: (callback: (data: { sessionId: string; error: string }) => void) => {
      const handler = (_event: any, data: { sessionId: string; error: string }) => callback(data)
      ipcRenderer.on(IPC_CHANNELS.LLM_CHAT_ERROR, handler)
      return () => ipcRenderer.removeListener(IPC_CHANNELS.LLM_CHAT_ERROR, handler)
    },
    onThought: (callback: (data: { sessionId: string; thought: string }) => void) => {
      const handler = (_event: any, data: { sessionId: string; thought: string }) => callback(data)
      ipcRenderer.on(IPC_CHANNELS.LLM_THOUGHT, handler)
      return () => ipcRenderer.removeListener(IPC_CHANNELS.LLM_THOUGHT, handler)
    },
    onToolCall: (callback: (data: { sessionId: string; id: string; name: string; args: any }) => void) => {
      const handler = (_event: any, data: { sessionId: string; id: string; name: string; args: any }) => callback(data)
      ipcRenderer.on(IPC_CHANNELS.AGENT_TOOL_CALL, handler)
      return () => ipcRenderer.removeListener(IPC_CHANNELS.AGENT_TOOL_CALL, handler)
    },
    onToolCallDelta: (callback: (data: { sessionId: string; deltas: Array<{ index: number; id?: string; name?: string; arguments: string }> }) => void) => {
      const handler = (_event: any, data: { sessionId: string; deltas: Array<{ index: number; id?: string; name?: string; arguments: string }> }) => callback(data)
      ipcRenderer.on(IPC_CHANNELS.AGENT_TOOL_CALL_DELTA, handler)
      return () => ipcRenderer.removeListener(IPC_CHANNELS.AGENT_TOOL_CALL_DELTA, handler)
    },
    onToolResult: (callback: (data: { sessionId: string; name: string; result: any; generatedFiles?: any }) => void) => {
      const handler = (_event: any, data: { sessionId: string; name: string; result: any }) => callback(data)
      ipcRenderer.on(IPC_CHANNELS.AGENT_TOOL_RESULT, handler)
      return () => ipcRenderer.removeListener(IPC_CHANNELS.AGENT_TOOL_RESULT, handler)
    },
    onToolProgress: (callback: (data: { sessionId: string; toolCallId: string; name: string; progress: any }) => void) => {
      const handler = (_event: any, data: { sessionId: string; toolCallId: string; name: string; progress: any }) => callback(data)
      ipcRenderer.on(IPC_CHANNELS.AGENT_TOOL_PROGRESS, handler)
      return () => ipcRenderer.removeListener(IPC_CHANNELS.AGENT_TOOL_PROGRESS, handler)
    },
  },

  settings: {
    get: (params: SettingsGetParams) => ipcRenderer.invoke(IPC_CHANNELS.SETTINGS_GET, params),
    set: (params: SettingsSetParams) => ipcRenderer.invoke(IPC_CHANNELS.SETTINGS_SET, params),
  },

  app: {
    showOpenDialog: (params: AppShowOpenDialogParams) => ipcRenderer.invoke(IPC_CHANNELS.APP_SHOW_OPEN_DIALOG, params),
    showSaveDialog: (params: AppShowSaveDialogParams) => ipcRenderer.invoke(IPC_CHANNELS.APP_SHOW_SAVE_DIALOG, params),
    getDataDir: () => ipcRenderer.invoke(IPC_CHANNELS.PATH_GET_DATA_DIR),
    setDataDir: (newDir: string) => ipcRenderer.invoke(IPC_CHANNELS.PATH_SET_DATA_DIR, newDir),
    getVersion: () => ipcRenderer.invoke(IPC_CHANNELS.APP_GET_VERSION),
    openLogDir: () => ipcRenderer.invoke(IPC_CHANNELS.APP_OPEN_LOG_DIR),
    clearAllData: () => ipcRenderer.invoke(IPC_CHANNELS.APP_CLEAR_ALL_DATA),
    // 渲染进程日志转发（fire-and-forget），把 console 输出写入主进程日志文件
    log: (level: 'debug' | 'info' | 'warn' | 'error', message: string) =>
      ipcRenderer.send(IPC_CHANNELS.APP_RENDERER_LOG, { level, message }),
  },

  window: {
    minimize: () => ipcRenderer.invoke(IPC_CHANNELS.WINDOW_MINIMIZE),
    toggleMaximize: () => ipcRenderer.invoke(IPC_CHANNELS.WINDOW_TOGGLE_MAXIMIZE),
    close: () => ipcRenderer.invoke(IPC_CHANNELS.WINDOW_CLOSE),
    isMaximized: () => ipcRenderer.invoke(IPC_CHANNELS.WINDOW_IS_MAXIMIZED),
    onMaximizedChange: (callback: (isMaximized: boolean) => void) => {
      // 先订阅主进程事件
      ipcRenderer.send(IPC_CHANNELS.WINDOW_ON_MAXIMIZED_CHANGE)
      const handler = (_event: any, isMaximized: boolean) => callback(isMaximized)
      ipcRenderer.on(IPC_CHANNELS.WINDOW_ON_MAXIMIZED_CHANGE, handler)
      return () => ipcRenderer.removeListener(IPC_CHANNELS.WINDOW_ON_MAXIMIZED_CHANGE, handler)
    },
  },

  tool: {
    listBuiltin: () => ipcRenderer.invoke(IPC_CHANNELS.TOOL_LIST_BUILTIN),
    getEmployeeTools: (params: { employee_id: string }) => ipcRenderer.invoke(IPC_CHANNELS.TOOL_GET_EMPLOYEE_TOOLS, params),
    assignToEmployee: (params: ToolAssignParams) => ipcRenderer.invoke(IPC_CHANNELS.TOOL_ASSIGN_TO_EMPLOYEE, params),
    getEmployeeToolCategories: (params: { employee_id: string }) =>
      ipcRenderer.invoke(IPC_CHANNELS.TOOL_GET_EMPLOYEE_TOOL_CATEGORIES, params) as Promise<ToolCategoryInfo[]>,
    assignCategoryToEmployee: (params: ToolCategoryAssignParams) =>
      ipcRenderer.invoke(IPC_CHANNELS.TOOL_ASSIGN_CATEGORY_TO_EMPLOYEE, params),
  },

  searchWindow: {
    getEngines: () => ipcRenderer.invoke(IPC_CHANNELS.SEARCH_GET_ENGINES),
    open: (engine: string) => ipcRenderer.invoke(IPC_CHANNELS.SEARCH_OPEN_WINDOW, { engine }),
    close: (engine: string) => ipcRenderer.invoke(IPC_CHANNELS.SEARCH_CLOSE_WINDOW, { engine }),
  },

  skillRegistry: {
    list: () => ipcRenderer.invoke(IPC_CHANNELS.SKILL_REGISTRY_LIST),
    install: (params: { source: 'directory' | 'zip'; path: string }) => ipcRenderer.invoke(IPC_CHANNELS.SKILL_REGISTRY_INSTALL, params),
    uninstall: (id: string) => ipcRenderer.invoke(IPC_CHANNELS.SKILL_REGISTRY_UNINSTALL, id),
    getEmployeeSkills: (params: { employee_id: string }) => ipcRenderer.invoke(IPC_CHANNELS.SKILL_REGISTRY_GET_EMPLOYEE_SKILLS, params),
    assignToEmployee: (params: { employee_id: string; skill_id: string }) => ipcRenderer.invoke(IPC_CHANNELS.SKILL_REGISTRY_ASSIGN_TO_EMPLOYEE, params),
    removeFromEmployee: (params: { employee_id: string; skill_id: string }) => ipcRenderer.invoke(IPC_CHANNELS.SKILL_REGISTRY_REMOVE_FROM_EMPLOYEE, params),
    toggleForEmployee: (params: { employee_id: string; skill_id: string; enabled: boolean }) => ipcRenderer.invoke(IPC_CHANNELS.SKILL_REGISTRY_TOGGLE_FOR_EMPLOYEE, params),
  },

  runtimeEnv: {
    // 检测所有受支持运行时的安装状态
    list: () => ipcRenderer.invoke(IPC_CHANNELS.RUNTIME_ENV_LIST),
    // 一键安装指定运行时（uv / python / node / pip）
    install: (params: RuntimeEnvInstallParams) => ipcRenderer.invoke(IPC_CHANNELS.RUNTIME_ENV_INSTALL, params),
    // 取消正在进行的安装
    cancelInstall: () => ipcRenderer.invoke(IPC_CHANNELS.RUNTIME_ENV_CANCEL_INSTALL),
    // 订阅安装进度事件（主进程 → 渲染进程），返回取消订阅函数
    onProgress: (callback: (progress: RuntimeEnvInstallProgress) => void) => {
      const handler = (_event: any, progress: RuntimeEnvInstallProgress) => callback(progress)
      ipcRenderer.on(IPC_CHANNELS.RUNTIME_ENV_PROGRESS, handler)
      return () => ipcRenderer.removeListener(IPC_CHANNELS.RUNTIME_ENV_PROGRESS, handler)
    },
  },

  mcp: {
    // 列出指定员工的所有 MCP server（含状态与缓存工具列表）
    list: (employeeId: string) => ipcRenderer.invoke(IPC_CHANNELS.MCP_LIST, { employee_id: employeeId }),
    // 新增 MCP server
    add: (params: McpSaveParams) => ipcRenderer.invoke(IPC_CHANNELS.MCP_ADD, params),
    // 更新 MCP server 配置
    update: (params: McpSaveParams) => ipcRenderer.invoke(IPC_CHANNELS.MCP_UPDATE, params),
    // 删除 MCP server
    delete: (params: { id: string; employee_id: string }) => ipcRenderer.invoke(IPC_CHANNELS.MCP_DELETE, params),
    // 启用 / 禁用 MCP server
    toggle: (params: { id: string; enabled: boolean; employee_id: string }) => ipcRenderer.invoke(IPC_CHANNELS.MCP_TOGGLE, params),
    // 测试连接（不依赖已缓存的 client，每次新建临时 client）
    test: (params: McpTestParams) => ipcRenderer.invoke(IPC_CHANNELS.MCP_TEST, params),
    // 刷新指定 server 的工具缓存（主动重新连接并 listTools）
    refreshTools: (params: { id: string; employee_id: string }) => ipcRenderer.invoke(IPC_CHANNELS.MCP_REFRESH_TOOLS, params),
  },

  calendar: {
    // 事件
    listEvents: (params: ListEventsParams) => ipcRenderer.invoke(IPC_CHANNELS.CALENDAR_LIST_EVENTS, params),
    createEvent: (input: CreateEventInput) => ipcRenderer.invoke(IPC_CHANNELS.CALENDAR_CREATE_EVENT, input),
    updateEvent: (input: UpdateEventInput) => ipcRenderer.invoke(IPC_CHANNELS.CALENDAR_UPDATE_EVENT, input),
    deleteEvent: (id: string) => ipcRenderer.invoke(IPC_CHANNELS.CALENDAR_DELETE_EVENT, { id }),
    // TODO
    listTodos: (params?: ListTodosParams) => ipcRenderer.invoke(IPC_CHANNELS.CALENDAR_LIST_TODOS, params || {}),
    createTodo: (input: CreateTodoInput) => ipcRenderer.invoke(IPC_CHANNELS.CALENDAR_CREATE_TODO, input),
    updateTodo: (input: UpdateTodoInput) => ipcRenderer.invoke(IPC_CHANNELS.CALENDAR_UPDATE_TODO, input),
    deleteTodo: (id: string) => ipcRenderer.invoke(IPC_CHANNELS.CALENDAR_DELETE_TODO, { id }),
    completeTodo: (id: string, completed: boolean) => ipcRenderer.invoke(IPC_CHANNELS.CALENDAR_COMPLETE_TODO, { id, completed }),
    todoStats: () => ipcRenderer.invoke(IPC_CHANNELS.CALENDAR_TODO_STATS),
    // 设置
    getSettings: () => ipcRenderer.invoke(IPC_CHANNELS.CALENDAR_GET_SETTINGS),
    setSettings: (params: Partial<CalendarSettings>) => ipcRenderer.invoke(IPC_CHANNELS.CALENDAR_SET_SETTINGS, params),
    // 通知事件订阅
    onNotify: (callback: (payload: NotifyPayload) => void) => {
      const handler = (_event: any, payload: NotifyPayload) => callback(payload)
      ipcRenderer.on(IPC_CHANNELS.CALENDAR_NOTIFY, handler)
      return () => ipcRenderer.removeListener(IPC_CHANNELS.CALENDAR_NOTIFY, handler)
    },
    onNotifyClick: (callback: (payload: { target?: string; id?: string }) => void) => {
      const handler = (_event: any, payload: { target?: string; id?: string }) => callback(payload)
      ipcRenderer.on(IPC_CHANNELS.CALENDAR_NOTIFY_CLICK, handler)
      return () => ipcRenderer.removeListener(IPC_CHANNELS.CALENDAR_NOTIFY_CLICK, handler)
    },
    onDataChanged: (callback: (payload: { scope: 'event' | 'todo' | 'settings'; ts: number }) => void) => {
      const handler = (_event: any, payload: { scope: 'event' | 'todo' | 'settings'; ts: number }) => callback(payload)
      ipcRenderer.on(IPC_CHANNELS.CALENDAR_DATA_CHANGED, handler)
      return () => ipcRenderer.removeListener(IPC_CHANNELS.CALENDAR_DATA_CHANGED, handler)
    },
    // 渲染进程主动请求系统通知
    sendNotification: (payload: NotifyPayload) => ipcRenderer.invoke(IPC_CHANNELS.NOTIFY_SEND, payload),
  },

  automation: {
    // 任务 CRUD
    listTasks: (params?: ListAutomationTasksParams) => ipcRenderer.invoke(IPC_CHANNELS.AUTOMATION_LIST_TASKS, params),
    getTask: (id: string) => ipcRenderer.invoke(IPC_CHANNELS.AUTOMATION_GET_TASK, id),
    createTask: (input: CreateAutomationTaskInput) => ipcRenderer.invoke(IPC_CHANNELS.AUTOMATION_CREATE_TASK, input),
    updateTask: (input: UpdateAutomationTaskInput) => ipcRenderer.invoke(IPC_CHANNELS.AUTOMATION_UPDATE_TASK, input),
    deleteTask: (id: string) => ipcRenderer.invoke(IPC_CHANNELS.AUTOMATION_DELETE_TASK, { id }),
    toggleTask: (id: string, enabled: boolean) => ipcRenderer.invoke(IPC_CHANNELS.AUTOMATION_TOGGLE_TASK, { id, enabled }),
    // 执行
    runNow: (id: string) => ipcRenderer.invoke(IPC_CHANNELS.AUTOMATION_RUN_NOW, { id }),
    previewRuns: (params: PreviewRunsParams) => ipcRenderer.invoke(IPC_CHANNELS.AUTOMATION_PREVIEW_RUNS, params),
    // 执行历史 CRUD
    listRuns: (params?: ListAutomationRunsParams) => ipcRenderer.invoke(IPC_CHANNELS.AUTOMATION_LIST_RUNS, params),
    deleteRun: (id: string) => ipcRenderer.invoke(IPC_CHANNELS.AUTOMATION_DELETE_RUN, { id }),
    clearRuns: (params?: { task_id?: string }) => ipcRenderer.invoke(IPC_CHANNELS.AUTOMATION_CLEAR_RUNS, params),
    // 数据变更事件订阅
    onDataChanged: (callback: (payload: { scope: 'task' | 'run' | 'settings'; ts: number }) => void) => {
      const handler = (_event: any, payload: { scope: 'task' | 'run' | 'settings'; ts: number }) => callback(payload)
      ipcRenderer.on(IPC_CHANNELS.AUTOMATION_DATA_CHANGED, handler)
      return () => ipcRenderer.removeListener(IPC_CHANNELS.AUTOMATION_DATA_CHANGED, handler)
    },
  },

  notes: {
    listTree: () => ipcRenderer.invoke(IPC_CHANNELS.NOTES_LIST_TREE),
    read: (relPath: string) => ipcRenderer.invoke(IPC_CHANNELS.NOTES_READ, relPath),
    write: (params: NoteWriteParams) => ipcRenderer.invoke(IPC_CHANNELS.NOTES_WRITE, params),
    createNote: (params: NoteCreateParams) => ipcRenderer.invoke(IPC_CHANNELS.NOTES_CREATE_NOTE, params),
    createFolder: (params: NoteCreateParams) => ipcRenderer.invoke(IPC_CHANNELS.NOTES_CREATE_FOLDER, params),
    rename: (params: NoteRenameParams) => ipcRenderer.invoke(IPC_CHANNELS.NOTES_RENAME, params),
    move: (params: NoteMoveParams) => ipcRenderer.invoke(IPC_CHANNELS.NOTES_MOVE, params),
    copy: (params: NoteCopyParams) => ipcRenderer.invoke(IPC_CHANNELS.NOTES_COPY, params),
    delete: (relPath: string) => ipcRenderer.invoke(IPC_CHANNELS.NOTES_DELETE, relPath),
    search: (params: NoteSearchParams) => ipcRenderer.invoke(IPC_CHANNELS.NOTES_SEARCH, params),
    getSettings: () => ipcRenderer.invoke(IPC_CHANNELS.NOTES_GET_SETTINGS),
    setSettings: (params: Partial<NotesSettings>) => ipcRenderer.invoke(IPC_CHANNELS.NOTES_SET_SETTINGS, params),
    getAbsolutePath: (relPath: string) => ipcRenderer.invoke(IPC_CHANNELS.NOTES_GET_ABS_PATH, relPath),
    openInExplorer: (relPath: string) => ipcRenderer.invoke(IPC_CHANNELS.NOTES_OPEN_IN_EXPLORER, relPath),
    importExternal: (params: NoteImportExternalParams) => ipcRenderer.invoke(IPC_CHANNELS.NOTES_IMPORT_EXTERNAL, params),
    saveImage: (params: NoteSaveImageParams) => ipcRenderer.invoke(IPC_CHANNELS.NOTES_SAVE_IMAGE, params),
    openDiary: () => ipcRenderer.invoke(IPC_CHANNELS.NOTES_OPEN_DIARY),
    onDataChanged: (callback: (payload: NotesDataChangedPayload) => void) => {
      const handler = (_event: any, payload: NotesDataChangedPayload) => callback(payload)
      ipcRenderer.on(IPC_CHANNELS.NOTES_DATA_CHANGED, handler)
      return () => ipcRenderer.removeListener(IPC_CHANNELS.NOTES_DATA_CHANGED, handler)
    },
  },

  kms: {
    listDirs: () => ipcRenderer.invoke(IPC_CHANNELS.KMS_LIST_DIRS),
    addDir: (params: KMSAddDirParams) => ipcRenderer.invoke(IPC_CHANNELS.KMS_ADD_DIR, params),
    updateDir: (params: KMSUpdateDirParams) => ipcRenderer.invoke(IPC_CHANNELS.KMS_UPDATE_DIR, params),
    deleteDir: (id: string) => ipcRenderer.invoke(IPC_CHANNELS.KMS_DELETE_DIR, id),
    search: (params: KMSSearchParams) => ipcRenderer.invoke(IPC_CHANNELS.KMS_SEARCH, params),
    searchFiles: (params: KMSSearchFilesParams) => ipcRenderer.invoke(IPC_CHANNELS.KMS_SEARCH_FILES, params),
    agentSearch: (params: KMSAgentSearchParams) => ipcRenderer.invoke(IPC_CHANNELS.KMS_AGENT_SEARCH, params),
    onAgentSearchProgress: (callback: (step: { phase: string; action: string; detail?: string; durationMs?: number; type: 'info' | 'llm' | 'search' | 'read' | 'plan' | 'result' }) => void) => {
      const handler = (_event: any, step: any) => callback(step)
      ipcRenderer.on(IPC_CHANNELS.KMS_AGENT_SEARCH_PROGRESS, handler)
      return () => ipcRenderer.removeListener(IPC_CHANNELS.KMS_AGENT_SEARCH_PROGRESS, handler)
    },
    getFileContent: (params: KMSGetFileContentParams) => ipcRenderer.invoke(IPC_CHANNELS.KMS_GET_FILE_CONTENT, params),
    getFileSummary: (fileId: string) => ipcRenderer.invoke(IPC_CHANNELS.KMS_GET_FILE_SUMMARY, fileId),
    getFileFullContent: (fileId: string) => ipcRenderer.invoke(IPC_CHANNELS.KMS_GET_FILE_FULL_CONTENT, fileId),
    openFile: (filePath: string) => ipcRenderer.invoke(IPC_CHANNELS.KMS_OPEN_FILE, filePath),
    openFileDir: (filePath: string) => ipcRenderer.invoke(IPC_CHANNELS.KMS_OPEN_FILE_DIR, filePath),
    buildIndex: (providerId?: string, withEmbedding: boolean = true, resetHotData: boolean = false) => { ipcRenderer.send(IPC_CHANNELS.KMS_BUILD_INDEX, providerId, withEmbedding, resetHotData); return Promise.resolve({ success: true }) },
    incrementalIndex: (providerId?: string, withEmbedding: boolean = true) => { ipcRenderer.send(IPC_CHANNELS.KMS_INCREMENTAL_INDEX, providerId, withEmbedding); return Promise.resolve({ success: true }) },
    rebuildDirIndex: (dirId: string, providerId?: string, withEmbedding: boolean = true, resetHotData: boolean = false) => { ipcRenderer.send(IPC_CHANNELS.KMS_REBUILD_DIR_INDEX, dirId, providerId, withEmbedding, resetHotData); return Promise.resolve({ success: true }) },
    cancelIndex: () => { ipcRenderer.send(IPC_CHANNELS.KMS_CANCEL_INDEX); return Promise.resolve({ success: true }) },
    getStats: () => ipcRenderer.invoke(IPC_CHANNELS.KMS_GET_STATS),
    onIndexProgress: (callback: (progress: {
      phase: string
      current: number
      total: number
      message: string
      fileId?: string
      fileName?: string
      collectionId?: string
      collectionName?: string
      startedAt?: number
      cancelled?: boolean
    }) => void) => {
      const handler = (_event: any, progress: any) => callback(progress)
      ipcRenderer.on(IPC_CHANNELS.KMS_INDEX_PROGRESS, handler)
      return () => ipcRenderer.removeListener(IPC_CHANNELS.KMS_INDEX_PROGRESS, handler)
    },
    getSettings: () => ipcRenderer.invoke(IPC_CHANNELS.KMS_GET_SETTINGS),
    setSettings: (params: KMSSetSettingsParams) => ipcRenderer.invoke(IPC_CHANNELS.KMS_SET_SETTINGS, params),
    getAutoIndexStatus: () => ipcRenderer.invoke(IPC_CHANNELS.KMS_GET_AUTO_INDEX_STATUS),
    runAutoIndexCheck: () => ipcRenderer.invoke(IPC_CHANNELS.KMS_RUN_AUTO_INDEX_CHECK),
    getDirSummaries: () => ipcRenderer.invoke(IPC_CHANNELS.KMS_GET_DIR_SUMMARIES),
    getFileSummaries: (params: KMSGetFileSummariesParams) => ipcRenderer.invoke(IPC_CHANNELS.KMS_GET_FILE_SUMMARIES, params),
    getFileParagraphs: (fileId: string) => ipcRenderer.invoke(IPC_CHANNELS.KMS_GET_FILE_PARAGRAPHS, fileId),
    getFileToc: (fileId: string) => ipcRenderer.invoke(IPC_CHANNELS.KMS_GET_FILE_TOC, fileId),
    getParagraphContent: (paragraphId: string) => ipcRenderer.invoke(IPC_CHANNELS.KMS_GET_PARAGRAPH_CONTENT, paragraphId),
    recordSearchHistory: (params: KMSRecordSearchHistoryParams) => ipcRenderer.invoke(IPC_CHANNELS.KMS_RECORD_SEARCH_HISTORY, params),
    getSearchHistory: (params?: KMSGetSearchHistoryParams) => ipcRenderer.invoke(IPC_CHANNELS.KMS_GET_SEARCH_HISTORY, params || {}),
    clearSearchHistory: (searchMode?: string) => ipcRenderer.invoke(IPC_CHANNELS.KMS_CLEAR_SEARCH_HISTORY, searchMode),
    deleteSearchHistory: (id: string) => ipcRenderer.invoke(IPC_CHANNELS.KMS_DELETE_SEARCH_HISTORY, id),
    listCollections: () => ipcRenderer.invoke(IPC_CHANNELS.KMS_LIST_COLLECTIONS),
    createCollection: (params: KMSCreateCollectionParams) => ipcRenderer.invoke(IPC_CHANNELS.KMS_CREATE_COLLECTION, params),
    updateCollection: (params: KMSUpdateCollectionParams) => ipcRenderer.invoke(IPC_CHANNELS.KMS_UPDATE_COLLECTION, params),
    deleteCollection: (id: string) => ipcRenderer.invoke(IPC_CHANNELS.KMS_DELETE_COLLECTION, id),
    getCollection: (id: string) => ipcRenderer.invoke(IPC_CHANNELS.KMS_GET_COLLECTION, id),
    addFileToCollection: (params: KMSAddFileToCollectionParams) => ipcRenderer.invoke(IPC_CHANNELS.KMS_ADD_FILE_TO_COLLECTION, params),
    addFilesToCollection: (params: KMSAddFilesToCollectionParams) => ipcRenderer.invoke(IPC_CHANNELS.KMS_ADD_FILES_TO_COLLECTION, params),
    removeFileFromCollection: (params: KMSRemoveFileFromCollectionParams) => ipcRenderer.invoke(IPC_CHANNELS.KMS_REMOVE_FILE_FROM_COLLECTION, params),
    listFilesInCollection: (collectionId: string) => ipcRenderer.invoke(IPC_CHANNELS.KMS_LIST_FILES_IN_COLLECTION, collectionId),
    getCollectionStats: (collectionId: string) => ipcRenderer.invoke(IPC_CHANNELS.KMS_GET_COLLECTION_STATS, collectionId),
    getCollectionSummary: (collectionId: string) => ipcRenderer.invoke(IPC_CHANNELS.KMS_GET_COLLECTION_SUMMARY, collectionId),
    setCollectionSummary: (params: KMSSetCollectionSummaryParams) => ipcRenderer.invoke(IPC_CHANNELS.KMS_SET_COLLECTION_SUMMARY, params),
    deleteCollectionSummary: (collectionId: string) => ipcRenderer.invoke(IPC_CHANNELS.KMS_DELETE_COLLECTION_SUMMARY, collectionId),
    generateCollectionSummary: (collectionId: string) => ipcRenderer.invoke(IPC_CHANNELS.KMS_GENERATE_COLLECTION_SUMMARY, collectionId),
    scanDirFiles: (dirPath: string, extensions?: string[]) => ipcRenderer.invoke(IPC_CHANNELS.KMS_SCAN_DIR_FILES, { dirPath, extensions }),
    processCollectionDeep: (collectionId: string, incremental: boolean = true) => ipcRenderer.send(IPC_CHANNELS.KMS_PROCESS_COLLECTION_DEEP, collectionId, incremental),
    cancelCollectionDeepProcess: () => ipcRenderer.send(IPC_CHANNELS.KMS_CANCEL_COLLECTION_DEEP),
    processFileDeep: (fileId: string, collectionId?: string) => ipcRenderer.send(IPC_CHANNELS.KMS_PROCESS_FILE_DEEP, fileId, collectionId),
    generateDirSummary: (dirId: string) => ipcRenderer.invoke(IPC_CHANNELS.KMS_GENERATE_DIR_SUMMARY, dirId),
    generateFileSummary: (fileId: string) => ipcRenderer.invoke(IPC_CHANNELS.KMS_GENERATE_FILE_SUMMARY, fileId),
    rebuildFileIndex: (fileId: string) => ipcRenderer.invoke(IPC_CHANNELS.KMS_REBUILD_FILE_INDEX, fileId),
    getDatabaseStats: () => ipcRenderer.invoke(IPC_CHANNELS.KMS_GET_DATABASE_STATS),
    cleanupDatabase: () => ipcRenderer.invoke(IPC_CHANNELS.KMS_CLEANUP_DATABASE),
    getKeywordStats: (params?: { limit?: number; minCount?: number; recentDays?: number }) => ipcRenderer.invoke(IPC_CHANNELS.KMS_GET_KEYWORD_STATS, params || {}),
    getKnowledgeCards: (params: KMSGetKnowledgeCardsParams) => ipcRenderer.invoke(IPC_CHANNELS.KMS_GET_KNOWLEDGE_CARDS, params),
    getKnowledgeCard: (id: string) => ipcRenderer.invoke(IPC_CHANNELS.KMS_GET_KNOWLEDGE_CARD, id),
    generateKnowledgeCard: (keyword: string) => ipcRenderer.invoke(IPC_CHANNELS.KMS_GENERATE_KNOWLEDGE_CARD, keyword),
    onKnowledgeCardProgress: (callback: (step: { phase: string; action: string; detail?: string; durationMs?: number; type: 'info' | 'llm' | 'search' | 'read' | 'plan' | 'result' }) => void) => {
      const handler = (_event: any, step: any) => callback(step)
      ipcRenderer.on(IPC_CHANNELS.KMS_KNOWLEDGE_CARD_PROGRESS, handler)
      return () => ipcRenderer.removeListener(IPC_CHANNELS.KMS_KNOWLEDGE_CARD_PROGRESS, handler)
    },
    refreshKnowledgeCard: (id: string) => ipcRenderer.invoke(IPC_CHANNELS.KMS_REFRESH_KNOWLEDGE_CARD, id),
    updateKnowledgeCard: (params: KMSUpdateKnowledgeCardParams) => ipcRenderer.invoke(IPC_CHANNELS.KMS_UPDATE_KNOWLEDGE_CARD, params),
    deleteKnowledgeCard: (id: string) => ipcRenderer.invoke(IPC_CHANNELS.KMS_DELETE_KNOWLEDGE_CARD, id),
    disableKnowledgeCard: (id: string) => ipcRenderer.invoke(IPC_CHANNELS.KMS_DISABLE_KNOWLEDGE_CARD, id),
    enableKnowledgeCard: (id: string) => ipcRenderer.invoke(IPC_CHANNELS.KMS_ENABLE_KNOWLEDGE_CARD, id),
    pinKnowledgeCard: (id: string, pinned: boolean) => ipcRenderer.invoke(IPC_CHANNELS.KMS_PIN_KNOWLEDGE_CARD, { id, pinned }),
    searchKnowledgeCards: (params: KMSSearchKnowledgeCardsParams) => ipcRenderer.invoke(IPC_CHANNELS.KMS_SEARCH_KNOWLEDGE_CARDS, params),
    getStopWords: (params?: { source?: 'manual' | 'auto_idf'; limit?: number; offset?: number }) => ipcRenderer.invoke(IPC_CHANNELS.KMS_GET_STOP_WORDS, params || {}),
    addStopWord: (word: string) => ipcRenderer.invoke(IPC_CHANNELS.KMS_ADD_STOP_WORD, word),
    deleteStopWord: (id: string) => ipcRenderer.invoke(IPC_CHANNELS.KMS_DELETE_STOP_WORD, id),
    clearAutoStopWords: () => ipcRenderer.invoke(IPC_CHANNELS.KMS_CLEAR_AUTO_STOP_WORDS),
  },

  kmsMcp: {
    start: () => ipcRenderer.invoke(IPC_CHANNELS.KMS_MCP_START),
    stop: () => ipcRenderer.invoke(IPC_CHANNELS.KMS_MCP_STOP),
    getStatus: () => ipcRenderer.invoke(IPC_CHANNELS.KMS_MCP_GET_STATUS),
    getConfig: () => ipcRenderer.invoke(IPC_CHANNELS.KMS_MCP_GET_CONFIG),
    setConfig: (params: KMSMCPSetConfigParams) => ipcRenderer.invoke(IPC_CHANNELS.KMS_MCP_SET_CONFIG, params),
    listCategories: () => ipcRenderer.invoke(IPC_CHANNELS.KMS_MCP_LIST_CATEGORIES) as Promise<KMSMCPToolCategoryInfo[]>,
    listExposedTools: (params?: { tool_categories?: string[] }) =>
      ipcRenderer.invoke(IPC_CHANNELS.KMS_MCP_LIST_EXPOSED_TOOLS, params) as Promise<KMSMCPExposedTool[]>,
  },

  voice: {
    listTasks: () => ipcRenderer.invoke(IPC_CHANNELS.VOICE_LIST_TASKS),
    getTask: (id: string) => ipcRenderer.invoke(IPC_CHANNELS.VOICE_GET_TASK, id),
    createTask: (params: VoiceCreateTaskParams) => ipcRenderer.invoke(IPC_CHANNELS.VOICE_CREATE_TASK, params),
    updateTask: (params: VoiceUpdateTaskParams) => ipcRenderer.invoke(IPC_CHANNELS.VOICE_UPDATE_TASK, params),
    deleteTask: (id: string) => ipcRenderer.invoke(IPC_CHANNELS.VOICE_DELETE_TASK, id),
    saveAudio: (params: VoiceSaveAudioParams) => ipcRenderer.invoke(IPC_CHANNELS.VOICE_SAVE_AUDIO, params),
    saveSecondaryAudio: (params: { taskId: string; audioData: string; format: string }) =>
      ipcRenderer.invoke(IPC_CHANNELS.VOICE_SAVE_SECONDARY_AUDIO, params),
    mergeDualSourceTranscript: (params: { mainTaskId: string; micTaskId: string; systemTaskId: string }) =>
      ipcRenderer.invoke(IPC_CHANNELS.VOICE_MERGE_DUAL_TRANSCRIPT, params),
    transcribe: (params: VoiceTranscribeParams) => ipcRenderer.invoke(IPC_CHANNELS.VOICE_TRANSCRIBE, params),
    cancelTranscribe: (taskId: string) => ipcRenderer.invoke(IPC_CHANNELS.VOICE_CANCEL_TRANSCRIBE, taskId),
    generateMinutes: (params: VoiceGenerateMinutesParams) => ipcRenderer.invoke(IPC_CHANNELS.VOICE_GENERATE_MINUTES, params),
    cancelMinutes: (taskId: string) => ipcRenderer.invoke(IPC_CHANNELS.VOICE_CANCEL_MINUTES, taskId),
    getSettings: () => ipcRenderer.invoke(IPC_CHANNELS.VOICE_GET_SETTINGS),
    setSettings: (settings: VoiceSettings) => ipcRenderer.invoke(IPC_CHANNELS.VOICE_SET_SETTINGS, settings),
    getAudioSources: () => ipcRenderer.invoke(IPC_CHANNELS.VOICE_GET_AUDIO_SOURCES),
    checkLocalModel: () => ipcRenderer.invoke(IPC_CHANNELS.VOICE_CHECK_LOCAL_MODEL),
    selectDirectory: () => ipcRenderer.invoke(IPC_CHANNELS.VOICE_SELECT_DIRECTORY),
    // 实时识别
    realtimeStart: (params: { taskId: string; language?: string }) => ipcRenderer.invoke(IPC_CHANNELS.VOICE_REALTIME_START, params),
    realtimeFeed: (params: { taskId: string; samples: ArrayBuffer; sampleRate: number; source?: string }) => ipcRenderer.invoke(IPC_CHANNELS.VOICE_REALTIME_FEED, params),
    realtimeStop: (taskId: string) => ipcRenderer.invoke(IPC_CHANNELS.VOICE_REALTIME_STOP, taskId),
    realtimeCancel: (taskId: string) => ipcRenderer.invoke(IPC_CHANNELS.VOICE_REALTIME_CANCEL, taskId),
    onRealtimeResult: (callback: (data: { taskId: string; text: string; source?: string; segment?: { start: number; end: number; text: string }; isFinal: boolean }) => void) => {
      const handler = (_event: any, data: any) => callback(data)
      ipcRenderer.on(IPC_CHANNELS.VOICE_REALTIME_RESULT, handler)
      return () => ipcRenderer.removeListener(IPC_CHANNELS.VOICE_REALTIME_RESULT, handler)
    },
    onProgress: (callback: (data: { taskId: string; phase: string; message: string; progress?: number; chunk?: string; accumulated?: string }) => void) => {
      const handler = (_event: any, data: any) => callback(data)
      ipcRenderer.on(IPC_CHANNELS.VOICE_PROGRESS, handler)
      return () => ipcRenderer.removeListener(IPC_CHANNELS.VOICE_PROGRESS, handler)
    },
    // 悬浮字幕窗口
    subtitleShow: (config?: VoiceSubtitleConfig) => ipcRenderer.invoke(IPC_CHANNELS.VOICE_SUBTITLE_SHOW, config),
    subtitleHide: () => ipcRenderer.invoke(IPC_CHANNELS.VOICE_SUBTITLE_HIDE),
    subtitleToggle: () => ipcRenderer.invoke(IPC_CHANNELS.VOICE_SUBTITLE_TOGGLE),
    subtitleGetVisible: () => ipcRenderer.invoke(IPC_CHANNELS.VOICE_SUBTITLE_GET_VISIBLE),
    onSubtitleText: (callback: (data: { text: string; source?: string }) => void) => {
      const handler = (_event: any, data: { text: string; source?: string }) => callback(data)
      ipcRenderer.on(IPC_CHANNELS.VOICE_SUBTITLE_UPDATE_TEXT, handler)
      return () => ipcRenderer.removeListener(IPC_CHANNELS.VOICE_SUBTITLE_UPDATE_TEXT, handler)
    },
    onSubtitleSettings: (callback: (config: VoiceSubtitleConfig) => void) => {
      const handler = (_event: any, config: VoiceSubtitleConfig) => callback(config)
      ipcRenderer.on(IPC_CHANNELS.VOICE_SUBTITLE_UPDATE_SETTINGS, handler)
      return () => ipcRenderer.removeListener(IPC_CHANNELS.VOICE_SUBTITLE_UPDATE_SETTINGS, handler)
    },
  },

  interaction: {
    onRequest: (callback: (request: any) => void) => {
      const handler = (_event: any, request: any) => callback(request)
      ipcRenderer.on(IPC_CHANNELS.INTERACTION_REQUEST, handler)
      return () => ipcRenderer.removeListener(IPC_CHANNELS.INTERACTION_REQUEST, handler)
    },
    respond: (response: { id: string; confirmed?: boolean; selectedValue?: string; inputValue?: string; cancelled: boolean; allowAlways?: boolean }) =>
      ipcRenderer.invoke(IPC_CHANNELS.INTERACTION_RESPONSE, response),
  },
}

contextBridge.exposeInMainWorld('electronAPI', {
  ...electronAPI,
  getPathForFile: (file: File) => webUtils.getPathForFile(file),
})

export type ElectronAPI = typeof electronAPI & {
  getPathForFile: (file: File) => string
  interaction: {
    onRequest: (callback: (request: any) => void) => () => void
    respond: (response: { id: string; confirmed?: boolean; selectedValue?: string; inputValue?: string; cancelled: boolean; allowAlways?: boolean }) => Promise<{ success: boolean }>
  }
}

declare global {
  interface Window {
    electronAPI: ElectronAPI
  }
}
