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
  EmployeeGenerateDescriptionParams,
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
  NotifyPayload,
  PluginInfo,
  PluginRendererInfo,
  PluginEventPayload,
  PluginImportResult,
  PluginMessageActionInfo,
} from '../shared/ipc-channels'

const electronAPI = {
  workspace: {
    openInExplorer: (params: WorkspaceOpenInExplorerParams) => ipcRenderer.invoke(IPC_CHANNELS.WORKSPACE_OPEN_IN_EXPLORER, params),
    deleteTaskDir: (path: string) => ipcRenderer.invoke(IPC_CHANNELS.WORKSPACE_DELETE_TASK_DIR, path),
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
    generateDescription: (params: EmployeeGenerateDescriptionParams) => ipcRenderer.invoke(IPC_CHANNELS.EMPLOYEE_GENERATE_DESCRIPTION, params),
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
    update: (params: { id: string; title?: string; messages_json?: string; message_count?: number; status?: string; minimal_mode?: boolean; last_message_at?: number; employee_id?: string; context_stats_json?: string; default_model_json?: string }) =>
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
    compactConversation: (params: any) => ipcRenderer.invoke(IPC_CHANNELS.EMPLOYEE_COMPACT_CONVERSATION, params),
    getContextStats: (params: any) => ipcRenderer.invoke(IPC_CHANNELS.EMPLOYEE_GET_CONTEXT_STATS, params),
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
    onToolResult: (callback: (data: { sessionId: string; name: string; result: any; rawResult?: any; generatedFiles?: any; success?: boolean }) => void) => {
      const handler = (_event: any, data: { sessionId: string; name: string; result: any; rawResult?: any; generatedFiles?: any; success?: boolean }) => callback(data)
      ipcRenderer.on(IPC_CHANNELS.AGENT_TOOL_RESULT, handler)
      return () => ipcRenderer.removeListener(IPC_CHANNELS.AGENT_TOOL_RESULT, handler)
    },
    onToolProgress: (callback: (data: { sessionId: string; toolCallId: string; name: string; progress: any }) => void) => {
      const handler = (_event: any, data: { sessionId: string; toolCallId: string; name: string; progress: any }) => callback(data)
      ipcRenderer.on(IPC_CHANNELS.AGENT_TOOL_PROGRESS, handler)
      return () => ipcRenderer.removeListener(IPC_CHANNELS.AGENT_TOOL_PROGRESS, handler)
    },
    onDelegationEvent: (callback: (data: { parentSessionId: string; delegationId: string; eventType: string; data: any }) => void) => {
      const handler = (_event: any, data: { parentSessionId: string; delegationId: string; eventType: string; data: any }) => callback(data)
      ipcRenderer.on(IPC_CHANNELS.AGENT_DELEGATION_EVENT, handler)
      return () => ipcRenderer.removeListener(IPC_CHANNELS.AGENT_DELEGATION_EVENT, handler)
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
    restart: () => ipcRenderer.invoke(IPC_CHANNELS.APP_RESTART),
    // 渲染进程日志转发（fire-and-forget），把 console 输出写入主进程日志文件
    log: (level: 'debug' | 'info' | 'warn' | 'error', message: string) =>
      ipcRenderer.send(IPC_CHANNELS.APP_RENDERER_LOG, { level, message }),
    // 系统右键"打开方式"或启动时传入 .md 文件参数时，主进程推送文件路径
    onOpenExternalFile: (callback: (absPath: string) => void) => {
      const handler = (_event: any, absPath: string) => callback(absPath)
      ipcRenderer.on(IPC_CHANNELS.APP_OPEN_EXTERNAL_FILE, handler)
      return () => ipcRenderer.removeListener(IPC_CHANNELS.APP_OPEN_EXTERNAL_FILE, handler)
    },
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

  tabWindow: {
    // 分离 tab 为独立窗口（已存在则聚焦）
    open: (tabKey: string) => ipcRenderer.invoke(IPC_CHANNELS.TAB_WINDOW_OPEN, tabKey),
    // 关闭 tab 独立窗口（回归主窗口）
    returnToMain: (tabKey: string) => ipcRenderer.invoke(IPC_CHANNELS.TAB_WINDOW_RETURN, tabKey),
    // 查询当前已分离的 tab 列表
    list: () => ipcRenderer.invoke(IPC_CHANNELS.TAB_WINDOW_LIST),
    // 聚焦已存在的 tab 独立窗口，返回是否成功
    focus: (tabKey: string) => ipcRenderer.invoke(IPC_CHANNELS.TAB_WINDOW_FOCUS, tabKey),
    // 独立窗口渲染进程查询自己所属的 tabKey（主窗口渲染进程调用返回 null）
    getOwnTab: () => ipcRenderer.invoke(IPC_CHANNELS.TAB_WINDOW_GET_OWN_TAB),
    // 主进程 → 主窗口渲染进程：detached tabs 列表变化通知
    onDetachedChanged: (callback: (tabs: string[]) => void) => {
      const handler = (_event: any, tabs: string[]) => callback(tabs || [])
      ipcRenderer.on(IPC_CHANNELS.TAB_WINDOW_DETACHED_CHANGED, handler)
      return () => ipcRenderer.removeListener(IPC_CHANNELS.TAB_WINDOW_DETACHED_CHANGED, handler)
    },
  },

  tool: {
    listBuiltin: () => ipcRenderer.invoke(IPC_CHANNELS.TOOL_LIST_BUILTIN),
    getCategories: () => ipcRenderer.invoke(IPC_CHANNELS.TOOL_GET_CATEGORIES),
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

  kms: {
    listDirs: () => ipcRenderer.invoke(IPC_CHANNELS.KMS_LIST_DIRS),
    addDir: (params: KMSAddDirParams) => ipcRenderer.invoke(IPC_CHANNELS.KMS_ADD_DIR, params),
    updateDir: (params: KMSUpdateDirParams) => ipcRenderer.invoke(IPC_CHANNELS.KMS_UPDATE_DIR, params),
    deleteDir: (id: string) => ipcRenderer.invoke(IPC_CHANNELS.KMS_DELETE_DIR, id),
    search: (params: KMSSearchParams) => ipcRenderer.invoke(IPC_CHANNELS.KMS_SEARCH, params),
    searchFiles: (params: KMSSearchFilesParams) => ipcRenderer.invoke(IPC_CHANNELS.KMS_SEARCH_FILES, params),
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

  interaction: {
    onRequest: (callback: (request: any) => void) => {
      const handler = (_event: any, request: any) => callback(request)
      ipcRenderer.on(IPC_CHANNELS.INTERACTION_REQUEST, handler)
      return () => ipcRenderer.removeListener(IPC_CHANNELS.INTERACTION_REQUEST, handler)
    },
    respond: (response: { id: string; confirmed?: boolean; selectedValue?: string; inputValue?: string; cancelled: boolean; allowAlways?: boolean }) =>
      ipcRenderer.invoke(IPC_CHANNELS.INTERACTION_RESPONSE, response),
  },

  // 宿主通用通知（自动化完成 / ask_user 交互等）：插件通知（日历提醒）经插件桥广播，不占宿主通道
  notification: {
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
    // 渲染进程主动请求系统通知
    sendNotification: (payload: NotifyPayload) => ipcRenderer.invoke(IPC_CHANNELS.NOTIFY_SEND, payload),
  },

  // 插件通用桥：preload 不随插件膨胀，所有插件调用经 invoke(pluginId, channel) 路由
  plugin: {
    list: () => ipcRenderer.invoke(IPC_CHANNELS.PLUGIN_LIST) as Promise<{
      plugins: PluginInfo[]
      rendererPlugins: PluginRendererInfo[]
    }>,
    invoke: <T = unknown,>(pluginId: string, channel: string, payload?: unknown) =>
      ipcRenderer.invoke(IPC_CHANNELS.PLUGIN_INVOKE, { pluginId, channel, payload }) as Promise<T>,
    // 主进程插件事件推送（ctx.ipc.broadcast）：按 pluginId 过滤，回调收到 { event, payload }
    onEvent: (pluginId: string, callback: (message: { event: string; payload: unknown }) => void) => {
      const handler = (_event: any, message: PluginEventPayload) => {
        if (message?.pluginId === pluginId) callback({ event: message.event, payload: message.payload })
      }
      ipcRenderer.on(IPC_CHANNELS.PLUGIN_EVENT, handler)
      return () => ipcRenderer.removeListener(IPC_CHANNELS.PLUGIN_EVENT, handler)
    },
    setEnabled: (pluginId: string, enabled: boolean) =>
      ipcRenderer.invoke(IPC_CHANNELS.PLUGIN_SET_ENABLED, { pluginId, enabled }),
    remove: (pluginId: string) => ipcRenderer.invoke(IPC_CHANNELS.PLUGIN_DELETE, { pluginId }),
    import: (overwrite?: boolean) =>
      ipcRenderer.invoke(IPC_CHANNELS.PLUGIN_IMPORT, { overwrite: !!overwrite }) as Promise<PluginImportResult>,
    listMessageActions: () =>
      ipcRenderer.invoke(IPC_CHANNELS.PLUGIN_LIST_MESSAGE_ACTIONS) as Promise<PluginMessageActionInfo[]>,
    listViews: () =>
      ipcRenderer.invoke(IPC_CHANNELS.PLUGIN_LIST_VIEWS) as Promise<Array<{ pluginId: string; view: string; component: unknown }>>,
    listCommands: () =>
      ipcRenderer.invoke(IPC_CHANNELS.PLUGIN_LIST_COMMANDS) as Promise<Array<{ pluginId: string; id: string; title: string }>>,
    resolveFileOwner: (extension: string) =>
      ipcRenderer.invoke(IPC_CHANNELS.PLUGIN_RESOLVE_FILE_OWNER, { extension }) as Promise<string | null>,
    openPluginsDir: () => ipcRenderer.invoke(IPC_CHANNELS.PLUGIN_OPEN_DIR),
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
