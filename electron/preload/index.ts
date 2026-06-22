import { contextBridge, ipcRenderer } from 'electron'
import { IPC_CHANNELS } from '../shared/ipc-channels'
import type {
  WorkspaceInfoParams,
  WorkspaceListFilesParams,
  WorkspaceReadFileParams,
  WorkspaceWriteFileParams,
  WorkspaceCreateFolderParams,
  WorkspaceDeleteItemParams,
  WorkspaceRenameItemParams,
  WorkspaceImportParams,
  WorkspaceOpenInExplorerParams,
  EmployeeListParams,
  EmployeeCreateParams,
  EmployeeUpdateParams,
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
  KBCreateParams,
  KBUpdateParams,
  KBDocParseParams,
  KBExportFullParams,
  KBExportSummaryParams,
  KBExportDocumentsParams,
  KBImportFullParams,
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
  KBMCPSetConfigParams,
  KMSAddDirParams,
  KMSUpdateDirParams,
  KMSSearchParams,
  KMSGetFileContentParams,
} from '../shared/ipc-channels'

const electronAPI = {
  workspace: {
    info: (params: WorkspaceInfoParams) => ipcRenderer.invoke(IPC_CHANNELS.WORKSPACE_INFO, params),
    listFiles: (params: WorkspaceListFilesParams) => ipcRenderer.invoke(IPC_CHANNELS.WORKSPACE_LIST_FILES, params),
    readFile: (params: WorkspaceReadFileParams) => ipcRenderer.invoke(IPC_CHANNELS.WORKSPACE_READ_FILE, params),
    writeFile: (params: WorkspaceWriteFileParams) => ipcRenderer.invoke(IPC_CHANNELS.WORKSPACE_WRITE_FILE, params),
    createFolder: (params: WorkspaceCreateFolderParams) => ipcRenderer.invoke(IPC_CHANNELS.WORKSPACE_CREATE_FOLDER, params),
    deleteItem: (params: WorkspaceDeleteItemParams) => ipcRenderer.invoke(IPC_CHANNELS.WORKSPACE_DELETE_ITEM, params),
    renameItem: (params: WorkspaceRenameItemParams) => ipcRenderer.invoke(IPC_CHANNELS.WORKSPACE_RENAME_ITEM, params),
    importFiles: (params: WorkspaceImportParams) => ipcRenderer.invoke(IPC_CHANNELS.WORKSPACE_IMPORT, params),
    openInExplorer: (params: WorkspaceOpenInExplorerParams) => ipcRenderer.invoke(IPC_CHANNELS.WORKSPACE_OPEN_IN_EXPLORER, params),
  },

  employee: {
    list: (params?: EmployeeListParams) => ipcRenderer.invoke(IPC_CHANNELS.EMPLOYEE_LIST, params),
    get: (id: string) => ipcRenderer.invoke(IPC_CHANNELS.EMPLOYEE_GET, id),
    create: (params: EmployeeCreateParams) => ipcRenderer.invoke(IPC_CHANNELS.EMPLOYEE_CREATE, params),
    update: (params: EmployeeUpdateParams) => ipcRenderer.invoke(IPC_CHANNELS.EMPLOYEE_UPDATE, params),
    delete: (params: string | { id: string; delete_workspace?: boolean }) => ipcRenderer.invoke(IPC_CHANNELS.EMPLOYEE_DELETE, params),
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
    onChunk: (callback: (data: { sessionId: string; chunk: string }) => void) => {
      const handler = (_event: any, data: { sessionId: string; chunk: string }) => callback(data)
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

  kb: {
    list: () => ipcRenderer.invoke(IPC_CHANNELS.KB_LIST),
    get: (id: string) => ipcRenderer.invoke(IPC_CHANNELS.KB_GET, id),
    create: (params: KBCreateParams) => ipcRenderer.invoke(IPC_CHANNELS.KB_CREATE, params),
    update: (params: KBUpdateParams) => ipcRenderer.invoke(IPC_CHANNELS.KB_UPDATE, params),
    delete: (id: string) => ipcRenderer.invoke(IPC_CHANNELS.KB_DELETE, id),
    uploadDocuments: (params: { kb_id: string; paths: string[] }) => ipcRenderer.invoke(IPC_CHANNELS.KB_DOC_UPLOAD, params),
    onUploadProgress: (callback: (progress: { current: number; total: number; fileName: string }) => void) => {
      const handler = (_event: any, progress: { current: number; total: number; fileName: string }) => callback(progress)
      ipcRenderer.on(IPC_CHANNELS.KB_UPLOAD_PROGRESS, handler)
      return () => ipcRenderer.removeListener(IPC_CHANNELS.KB_UPLOAD_PROGRESS, handler)
    },
    parseDocument: (params: KBDocParseParams) => ipcRenderer.invoke(IPC_CHANNELS.KB_DOC_PARSE, params),
    deleteDocument: (id: string) => ipcRenderer.invoke(IPC_CHANNELS.KB_DOC_DELETE, id),
    getDocumentList: (params: { kb_id: string; status?: string }) => ipcRenderer.invoke(IPC_CHANNELS.KB_DOC_LIST, params),
    parseAll: (params: { kb_id: string }) => ipcRenderer.invoke(IPC_CHANNELS.KB_PARSE_ALL, params),
    onParseAllProgress: (callback: (progress: { current: number; total: number; docName: string }) => void) => {
      const handler = (_event: any, progress: { current: number; total: number; docName: string }) => callback(progress)
      ipcRenderer.on(IPC_CHANNELS.KB_PARSE_ALL_PROGRESS, handler)
      return () => ipcRenderer.removeListener(IPC_CHANNELS.KB_PARSE_ALL_PROGRESS, handler)
    },
    processDocument: (params: { doc_id: string; provider_id?: string; model_id?: string; enable_thinking?: boolean }) => ipcRenderer.invoke(IPC_CHANNELS.KB_PROCESS_DOCUMENT, params),
    processAll: (params: { kb_id: string; provider_id?: string; model_id?: string; enable_thinking?: boolean }) => ipcRenderer.invoke(IPC_CHANNELS.KB_PROCESS_ALL, params),
    buildGlobal: (params: { kb_id: string; provider_id?: string; model_id?: string; enable_thinking?: boolean }) => ipcRenderer.invoke(IPC_CHANNELS.KB_BUILD_GLOBAL, params),
    getStats: (kbId: string) => ipcRenderer.invoke(IPC_CHANNELS.KB_GET_STATS, kbId),
    getParagraphs: (docId: string) => ipcRenderer.invoke(IPC_CHANNELS.KB_GET_PARAGRAPHS, docId),
    getDocSummary: (docId: string) => ipcRenderer.invoke(IPC_CHANNELS.KB_GET_DOC_SUMMARY, docId),
    getGlobalSummary: (kbId: string) => ipcRenderer.invoke(IPC_CHANNELS.KB_GET_GLOBAL_SUMMARY, kbId),
    searchParagraphs: (params: { kb_id: string; query: string; top_k?: number }) => ipcRenderer.invoke(IPC_CHANNELS.KB_SEARCH_PARAGRAPHS, params),
    getDocContent: (docId: string) => ipcRenderer.invoke(IPC_CHANNELS.KB_GET_DOC_CONTENT, docId),
    pauseParse: (docId: string) => ipcRenderer.invoke(IPC_CHANNELS.KB_PAUSE_PARSE, docId),
    resumeParse: (docId: string) => ipcRenderer.invoke(IPC_CHANNELS.KB_RESUME_PARSE, docId),
    retryParse: (docId: string) => ipcRenderer.invoke(IPC_CHANNELS.KB_RETRY_PARSE, docId),
    pauseAllParses: () => ipcRenderer.invoke(IPC_CHANNELS.KB_PAUSE_ALL_PARSES),
    resumeAllParses: () => ipcRenderer.invoke(IPC_CHANNELS.KB_RESUME_ALL_PARSES),
    cancelAllParses: () => ipcRenderer.invoke(IPC_CHANNELS.KB_CANCEL_ALL_PARSES),
    exportFull: (params: KBExportFullParams) => ipcRenderer.invoke(IPC_CHANNELS.KB_EXPORT_FULL, params),
    exportSummary: (params: KBExportSummaryParams) => ipcRenderer.invoke(IPC_CHANNELS.KB_EXPORT_SUMMARY, params),
    exportDocuments: (params: KBExportDocumentsParams) => ipcRenderer.invoke(IPC_CHANNELS.KB_EXPORT_DOCUMENTS, params),
    importFull: (params: KBImportFullParams) => ipcRenderer.invoke(IPC_CHANNELS.KB_IMPORT_FULL, params),
    scanFolder: (params: { folder_path: string }) => ipcRenderer.invoke(IPC_CHANNELS.KB_SCAN_FOLDER, params),
    onExportProgress: (callback: (progress: { kb_id: string; stage: string; detail: string }) => void) => {
      const handler = (_event: any, progress: { kb_id: string; stage: string; detail: string }) => callback(progress)
      ipcRenderer.on(IPC_CHANNELS.KB_EXPORT_PROGRESS, handler)
      return () => ipcRenderer.removeListener(IPC_CHANNELS.KB_EXPORT_PROGRESS, handler)
    },
    onImportProgress: (callback: (progress: { kb_id?: string; stage: string; detail: string }) => void) => {
      const handler = (_event: any, progress: { kb_id?: string; stage: string; detail: string }) => callback(progress)
      ipcRenderer.on(IPC_CHANNELS.KB_IMPORT_PROGRESS, handler)
      return () => ipcRenderer.removeListener(IPC_CHANNELS.KB_IMPORT_PROGRESS, handler)
    },
    search: (params: { kb_id: string; query: string; top_k?: number; document_ids?: string[]; source_types?: string[] }) => ipcRenderer.invoke(IPC_CHANNELS.KB_SEARCH, params),
    searchWithEmbedding: (params: { kb_id: string; query: string; top_k?: number; document_ids?: string[]; provider_id?: string }) => ipcRenderer.invoke(IPC_CHANNELS.KB_SEARCH_WITH_EMBEDDING, params),
    searchIndexStats: (kbId: string) => ipcRenderer.invoke(IPC_CHANNELS.KB_SEARCH_INDEX_STATS, kbId),
    rebuildSearchIndex: (kbId: string) => ipcRenderer.invoke(IPC_CHANNELS.KB_REBUILD_SEARCH_INDEX, kbId),
    updateParagraph: (params: { paragraph_id: string; updates: { summary?: string; keywords_json?: string; content?: string; title?: string } }) => ipcRenderer.invoke(IPC_CHANNELS.KB_UPDATE_PARAGRAPH, params),
    updateDocSummary: (params: { document_id: string; updates: { summary?: string; keywords_json?: string; main_topics_json?: string } }) => ipcRenderer.invoke(IPC_CHANNELS.KB_UPDATE_DOC_SUMMARY, params),
    getParagraphsByKb: (kbId: string) => ipcRenderer.invoke(IPC_CHANNELS.KB_GET_PARAGRAPHS_BY_KB, kbId),
  },

  kbMcp: {
    start: () => ipcRenderer.invoke(IPC_CHANNELS.KB_MCP_START),
    stop: () => ipcRenderer.invoke(IPC_CHANNELS.KB_MCP_STOP),
    getStatus: () => ipcRenderer.invoke(IPC_CHANNELS.KB_MCP_GET_STATUS),
    getConfig: () => ipcRenderer.invoke(IPC_CHANNELS.KB_MCP_GET_CONFIG),
    setConfig: (params: KBMCPSetConfigParams) => ipcRenderer.invoke(IPC_CHANNELS.KB_MCP_SET_CONFIG, params),
  },

  kms: {
    listDirs: () => ipcRenderer.invoke(IPC_CHANNELS.KMS_LIST_DIRS),
    addDir: (params: KMSAddDirParams) => ipcRenderer.invoke(IPC_CHANNELS.KMS_ADD_DIR, params),
    updateDir: (params: KMSUpdateDirParams) => ipcRenderer.invoke(IPC_CHANNELS.KMS_UPDATE_DIR, params),
    deleteDir: (id: string) => ipcRenderer.invoke(IPC_CHANNELS.KMS_DELETE_DIR, id),
    search: (params: KMSSearchParams) => ipcRenderer.invoke(IPC_CHANNELS.KMS_SEARCH, params),
    getFileContent: (params: KMSGetFileContentParams) => ipcRenderer.invoke(IPC_CHANNELS.KMS_GET_FILE_CONTENT, params),
    getFileSummary: (fileId: string) => ipcRenderer.invoke(IPC_CHANNELS.KMS_GET_FILE_SUMMARY, fileId),
    buildIndex: (providerId?: string) => ipcRenderer.invoke(IPC_CHANNELS.KMS_BUILD_INDEX, providerId),
    incrementalIndex: (providerId?: string) => ipcRenderer.invoke(IPC_CHANNELS.KMS_INCREMENTAL_INDEX, providerId),
    rebuildDirIndex: (dirId: string, providerId?: string) => ipcRenderer.invoke(IPC_CHANNELS.KMS_REBUILD_DIR_INDEX, dirId, providerId),
    cancelIndex: () => ipcRenderer.invoke(IPC_CHANNELS.KMS_CANCEL_INDEX),
    getStats: () => ipcRenderer.invoke(IPC_CHANNELS.KMS_GET_STATS),
    onIndexProgress: (callback: (progress: { phase: string; current: number; total: number; message: string }) => void) => {
      const handler = (_event: any, progress: { phase: string; current: number; total: number; message: string }) => callback(progress)
      ipcRenderer.on(IPC_CHANNELS.KMS_INDEX_PROGRESS, handler)
      return () => ipcRenderer.removeListener(IPC_CHANNELS.KMS_INDEX_PROGRESS, handler)
    },
  },

  interaction: {
    onRequest: (callback: (request: any) => void) => {
      const handler = (_event: any, request: any) => callback(request)
      ipcRenderer.on(IPC_CHANNELS.INTERACTION_REQUEST, handler)
      return () => ipcRenderer.removeListener(IPC_CHANNELS.INTERACTION_REQUEST, handler)
    },
    respond: (response: { id: string; confirmed?: boolean; selectedValue?: string; inputValue?: string; cancelled: boolean }) =>
      ipcRenderer.invoke(IPC_CHANNELS.INTERACTION_RESPONSE, response),
  },
}

contextBridge.exposeInMainWorld('electronAPI', {
  ...electronAPI,
  tasks: {
    getAll: () => ipcRenderer.invoke(IPC_CHANNELS.TASK_GET_ALL),
    clearCompleted: () => ipcRenderer.invoke(IPC_CHANNELS.TASK_CLEAR_COMPLETED),
    cancel: (taskId: string) => ipcRenderer.invoke(IPC_CHANNELS.TASK_CANCEL, taskId),
    pause: (taskId: string) => ipcRenderer.invoke(IPC_CHANNELS.TASK_PAUSE, taskId),
    resume: (taskId: string) => ipcRenderer.invoke(IPC_CHANNELS.TASK_RESUME, taskId),
    onTasksUpdated: (callback: (tasks: any[]) => void) => {
      const handler = (_event: any, tasks: any[]) => callback(tasks)
      ipcRenderer.on(IPC_CHANNELS.TASK_UPDATED, handler)
      return () => ipcRenderer.removeListener(IPC_CHANNELS.TASK_UPDATED, handler)
    },
  },
})

export type ElectronAPI = typeof electronAPI & {
  tasks: {
    getAll: () => Promise<any[]>
    clearCompleted: () => Promise<boolean>
    cancel: (taskId: string) => Promise<boolean>
    pause: (taskId: string) => Promise<boolean>
    resume: (taskId: string) => Promise<boolean>
    onTasksUpdated: (callback: (tasks: any[]) => void) => () => void
  }
  interaction: {
    onRequest: (callback: (request: any) => void) => () => void
    respond: (response: { id: string; confirmed?: boolean; selectedValue?: string; inputValue?: string; cancelled: boolean }) => Promise<{ success: boolean }>
  }
  kbMcp: {
    start: () => Promise<{ success: boolean; error?: string }>
    stop: () => Promise<{ success: boolean }>
    getStatus: () => Promise<{ running: boolean; port: number; url: string }>
    getConfig: () => Promise<{ enabled: boolean; port: number; allowedKbIds: string[]; apiKey: string }>
    setConfig: (params: KBMCPSetConfigParams) => Promise<{ success: boolean }>
  }
}

declare global {
  interface Window {
    electronAPI: ElectronAPI
  }
}
