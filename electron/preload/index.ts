import { contextBridge, ipcRenderer, webUtils } from 'electron'
import { IPC_CHANNELS } from '../shared/ipc-channels'
import type {
  WorkspaceOpenInExplorerParams,
  EmployeeListParams,
  EmployeeCreateParams,
  EmployeeUpdateParams,
  EmployeeDeleteParams,
  ConversationListParams,
  ConversationCreateParams,
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
  },

  conversation: {
    list: (params: ConversationListParams) => ipcRenderer.invoke(IPC_CHANNELS.CONVERSATION_LIST, params),
    get: (id: string) => ipcRenderer.invoke(IPC_CHANNELS.CONVERSATION_GET, id),
    create: (params: ConversationCreateParams) => ipcRenderer.invoke(IPC_CHANNELS.CONVERSATION_CREATE, params),
    update: (params: { id: string; title?: string; messages_json?: string; message_count?: number; status?: string; minimal_mode?: boolean; last_message_at?: number }) =>
      ipcRenderer.invoke(IPC_CHANNELS.CONVERSATION_UPDATE, params),
    delete: (id: string) => ipcRenderer.invoke(IPC_CHANNELS.CONVERSATION_DELETE, id),
    deleteAll: (employeeId: string) => ipcRenderer.invoke(IPC_CHANNELS.CONVERSATION_DELETE_ALL, employeeId),
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
    onToolResult: (callback: (data: { sessionId: string; name: string; result: any }) => void) => {
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
  },

  tool: {
    listBuiltin: () => ipcRenderer.invoke(IPC_CHANNELS.TOOL_LIST_BUILTIN),
    getEmployeeTools: (params: { employee_id: string }) => ipcRenderer.invoke(IPC_CHANNELS.TOOL_GET_EMPLOYEE_TOOLS, params),
    assignToEmployee: (params: ToolAssignParams) => ipcRenderer.invoke(IPC_CHANNELS.TOOL_ASSIGN_TO_EMPLOYEE, params),
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
    buildIndex: (providerId?: string, withEmbedding: boolean = true) => { ipcRenderer.send(IPC_CHANNELS.KMS_BUILD_INDEX, providerId, withEmbedding); return Promise.resolve({ success: true }) },
    incrementalIndex: (providerId?: string, withEmbedding: boolean = true) => { ipcRenderer.send(IPC_CHANNELS.KMS_INCREMENTAL_INDEX, providerId, withEmbedding); return Promise.resolve({ success: true }) },
    rebuildDirIndex: (dirId: string, providerId?: string, withEmbedding: boolean = true) => { ipcRenderer.send(IPC_CHANNELS.KMS_REBUILD_DIR_INDEX, dirId, providerId, withEmbedding); return Promise.resolve({ success: true }) },
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
    processCollectionDeep: (collectionId: string) => ipcRenderer.send(IPC_CHANNELS.KMS_PROCESS_COLLECTION_DEEP, collectionId),
    cancelCollectionDeepProcess: () => ipcRenderer.send(IPC_CHANNELS.KMS_CANCEL_COLLECTION_DEEP),
    generateDirSummary: (dirId: string) => ipcRenderer.invoke(IPC_CHANNELS.KMS_GENERATE_DIR_SUMMARY, dirId),
    generateFileSummary: (fileId: string) => ipcRenderer.invoke(IPC_CHANNELS.KMS_GENERATE_FILE_SUMMARY, fileId),
    rebuildFileIndex: (fileId: string) => ipcRenderer.invoke(IPC_CHANNELS.KMS_REBUILD_FILE_INDEX, fileId),
  },

  kmsMcp: {
    start: () => ipcRenderer.invoke(IPC_CHANNELS.KMS_MCP_START),
    stop: () => ipcRenderer.invoke(IPC_CHANNELS.KMS_MCP_STOP),
    getStatus: () => ipcRenderer.invoke(IPC_CHANNELS.KMS_MCP_GET_STATUS),
    getConfig: () => ipcRenderer.invoke(IPC_CHANNELS.KMS_MCP_GET_CONFIG),
    setConfig: (params: KMSMCPSetConfigParams) => ipcRenderer.invoke(IPC_CHANNELS.KMS_MCP_SET_CONFIG, params),
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
