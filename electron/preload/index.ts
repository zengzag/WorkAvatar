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
  EmployeeListParams,
  EmployeeCreateParams,
  EmployeeUpdateParams,
  SkillListParams,
  SkillCreateParams,
  SkillUpdateParams,
  ConversationListParams,
  ConversationCreateParams,
  ConversationRecentParams,
  AppGetPathParams,
  AppShowOpenDialogParams,
  AppShowSaveDialogParams,
  LLMProviderCreateParams,
  LLMProviderUpdateParams,
  LLMTestConnectionParams,
  LLMChatParams,
  LLMChatStreamParams,
  EmployeeChatStreamParams,
  SettingsGetParams,
  SettingsSetParams,
  EmployeeProfileAnalyzeParams,
  EmployeeProfileRefineParams,
  ToolExecuteParams,
  ToolAssignParams,
  MCPServerCreateParams,
  MCPServerUpdateParams,
  KBCreateParams,
  KBUpdateParams,
  KBDocParseParams,
  KBExportFullParams,
  KBExportSummaryParams,
  KBExportDocumentsParams,
  KBImportFullParams,
  KBImportGraphParams,
  EmployeeExportConfigParams,
  EmployeeImportConfigParams,
  EmployeeExportPackageParams,
  EmployeeImportPackageParams,
  EmployeeTaskCreateParams,
  EmployeeTaskUpdateParams,
  EmployeeScheduleCreateParams,
  EmployeeScheduleUpdateParams,
  EmployeeKBListParams,
  EmployeeKBLinkParams,
  EmployeeKBUnlinkParams,
  WorkflowCreateParams,
  WorkflowUpdateParams,
} from '../shared/ipc-channels'

const electronAPI = {
  ping: () => ipcRenderer.invoke(IPC_CHANNELS.PING),

  workspace: {
    info: (params: WorkspaceInfoParams) => ipcRenderer.invoke(IPC_CHANNELS.WORKSPACE_INFO, params),
    listFiles: (params: WorkspaceListFilesParams) => ipcRenderer.invoke(IPC_CHANNELS.WORKSPACE_LIST_FILES, params),
    readFile: (params: WorkspaceReadFileParams) => ipcRenderer.invoke(IPC_CHANNELS.WORKSPACE_READ_FILE, params),
    writeFile: (params: WorkspaceWriteFileParams) => ipcRenderer.invoke(IPC_CHANNELS.WORKSPACE_WRITE_FILE, params),
    createFolder: (params: WorkspaceCreateFolderParams) => ipcRenderer.invoke(IPC_CHANNELS.WORKSPACE_CREATE_FOLDER, params),
    deleteItem: (params: WorkspaceDeleteItemParams) => ipcRenderer.invoke(IPC_CHANNELS.WORKSPACE_DELETE_ITEM, params),
    renameItem: (params: WorkspaceRenameItemParams) => ipcRenderer.invoke(IPC_CHANNELS.WORKSPACE_RENAME_ITEM, params),
    importFiles: (params: WorkspaceImportParams) => ipcRenderer.invoke(IPC_CHANNELS.WORKSPACE_IMPORT, params),
  },

  employee: {
    list: (params?: EmployeeListParams) => ipcRenderer.invoke(IPC_CHANNELS.EMPLOYEE_LIST, params),
    get: (id: string) => ipcRenderer.invoke(IPC_CHANNELS.EMPLOYEE_GET, id),
    create: (params: EmployeeCreateParams) => ipcRenderer.invoke(IPC_CHANNELS.EMPLOYEE_CREATE, params),
    update: (params: EmployeeUpdateParams) => ipcRenderer.invoke(IPC_CHANNELS.EMPLOYEE_UPDATE, params),
    delete: (params: string | { id: string; delete_workspace?: boolean }) => ipcRenderer.invoke(IPC_CHANNELS.EMPLOYEE_DELETE, params),
    deleteWorkspace: (id: string) => ipcRenderer.invoke(IPC_CHANNELS.EMPLOYEE_DELETE_WORKSPACE, id),
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
    listKBs: (params: EmployeeKBListParams) => ipcRenderer.invoke(IPC_CHANNELS.EMPLOYEE_KB_LIST, params),
    linkKB: (params: EmployeeKBLinkParams) => ipcRenderer.invoke(IPC_CHANNELS.EMPLOYEE_KB_LINK, params),
    unlinkKB: (params: EmployeeKBUnlinkParams) => ipcRenderer.invoke(IPC_CHANNELS.EMPLOYEE_KB_UNLINK, params),
  },

  skill: {
    list: (params: SkillListParams) => ipcRenderer.invoke(IPC_CHANNELS.SKILL_LIST, params),
    create: (params: SkillCreateParams) => ipcRenderer.invoke(IPC_CHANNELS.SKILL_CREATE, params),
    update: (params: SkillUpdateParams) => ipcRenderer.invoke(IPC_CHANNELS.SKILL_UPDATE, params),
    delete: (id: string) => ipcRenderer.invoke(IPC_CHANNELS.SKILL_DELETE, id),
  },

  conversation: {
    list: (params: ConversationListParams) => ipcRenderer.invoke(IPC_CHANNELS.CONVERSATION_LIST, params),
    get: (id: string) => ipcRenderer.invoke(IPC_CHANNELS.CONVERSATION_GET, id),
    create: (params: ConversationCreateParams) => ipcRenderer.invoke(IPC_CHANNELS.CONVERSATION_CREATE, params),
    update: (params: { id: string; title?: string; messages_json?: string; message_count?: number; status?: string }) =>
      ipcRenderer.invoke(IPC_CHANNELS.CONVERSATION_UPDATE, params),
    delete: (id: string) => ipcRenderer.invoke(IPC_CHANNELS.CONVERSATION_DELETE, id),
    deleteAll: (employeeId: string) => ipcRenderer.invoke(IPC_CHANNELS.CONVERSATION_DELETE_ALL, employeeId),
    recentList: (params?: ConversationRecentParams) => ipcRenderer.invoke(IPC_CHANNELS.CONVERSATION_RECENT, params),
  },

  llm: {
    getProviders: () => ipcRenderer.invoke(IPC_CHANNELS.LLM_PROVIDER_LIST),
    getProvider: (id: string) => ipcRenderer.invoke(IPC_CHANNELS.LLM_PROVIDER_GET, id),
    createProvider: (params: LLMProviderCreateParams) => ipcRenderer.invoke(IPC_CHANNELS.LLM_PROVIDER_CREATE, params),
    updateProvider: (params: LLMProviderUpdateParams) => ipcRenderer.invoke(IPC_CHANNELS.LLM_PROVIDER_UPDATE, params),
    deleteProvider: (id: string) => ipcRenderer.invoke(IPC_CHANNELS.LLM_PROVIDER_DELETE, id),
    testConnection: (params: LLMTestConnectionParams) => ipcRenderer.invoke(IPC_CHANNELS.LLM_TEST_CONNECTION, params),
    chat: (params: LLMChatParams) => ipcRenderer.invoke(IPC_CHANNELS.LLM_CHAT, params),
    chatStream: (params: LLMChatStreamParams) => ipcRenderer.invoke(IPC_CHANNELS.LLM_CHAT_STREAM, params),
    employeeChatStream: (params: EmployeeChatStreamParams) => ipcRenderer.invoke(IPC_CHANNELS.EMPLOYEE_CHAT_STREAM, params),
    abortChat: () => ipcRenderer.invoke(IPC_CHANNELS.LLM_ABORT_CHAT),
    onChunk: (callback: (chunk: string) => void) => {
      const handler = (_event: any, chunk: string) => callback(chunk)
      ipcRenderer.on(IPC_CHANNELS.LLM_CHAT_CHUNK, handler)
      return () => ipcRenderer.removeListener(IPC_CHANNELS.LLM_CHAT_CHUNK, handler)
    },
    onDone: (callback: () => void) => {
      const handler = () => callback()
      ipcRenderer.on(IPC_CHANNELS.LLM_CHAT_DONE, handler)
      return () => ipcRenderer.removeListener(IPC_CHANNELS.LLM_CHAT_DONE, handler)
    },
    onError: (callback: (error: string) => void) => {
      const handler = (_event: any, error: string) => callback(error)
      ipcRenderer.on(IPC_CHANNELS.LLM_CHAT_ERROR, handler)
      return () => ipcRenderer.removeListener(IPC_CHANNELS.LLM_CHAT_ERROR, handler)
    },
    onThought: (callback: (thought: string) => void) => {
      const handler = (_event: any, thought: string) => callback(thought)
      ipcRenderer.on(IPC_CHANNELS.LLM_THOUGHT, handler)
      return () => ipcRenderer.removeListener(IPC_CHANNELS.LLM_THOUGHT, handler)
    },
    onToolCall: (callback: (toolCall: { name: string; args: any }) => void) => {
      const handler = (_event: any, toolCall: { name: string; args: any }) => callback(toolCall)
      ipcRenderer.on(IPC_CHANNELS.AGENT_TOOL_CALL, handler)
      return () => ipcRenderer.removeListener(IPC_CHANNELS.AGENT_TOOL_CALL, handler)
    },
    onToolResult: (callback: (toolResult: { name: string; result: any }) => void) => {
      const handler = (_event: any, toolResult: { name: string; result: any }) => callback(toolResult)
      ipcRenderer.on(IPC_CHANNELS.AGENT_TOOL_RESULT, handler)
      return () => ipcRenderer.removeListener(IPC_CHANNELS.AGENT_TOOL_RESULT, handler)
    },
  },

  settings: {
    get: (params: SettingsGetParams) => ipcRenderer.invoke(IPC_CHANNELS.SETTINGS_GET, params),
    set: (params: SettingsSetParams) => ipcRenderer.invoke(IPC_CHANNELS.SETTINGS_SET, params),
  },

  app: {
    getPath: (params: AppGetPathParams) => ipcRenderer.invoke(IPC_CHANNELS.APP_GET_PATH, params),
    showOpenDialog: (params: AppShowOpenDialogParams) => ipcRenderer.invoke(IPC_CHANNELS.APP_SHOW_OPEN_DIALOG, params),
    showSaveDialog: (params: AppShowSaveDialogParams) => ipcRenderer.invoke(IPC_CHANNELS.APP_SHOW_SAVE_DIALOG, params),
    showMessageBox: (params: any) => ipcRenderer.invoke(IPC_CHANNELS.APP_SHOW_MESSAGE_BOX, params),
    getDataDir: () => ipcRenderer.invoke(IPC_CHANNELS.PATH_GET_DATA_DIR),
    setDataDir: (newDir: string) => ipcRenderer.invoke(IPC_CHANNELS.PATH_SET_DATA_DIR, newDir),
  },

  ocr: {
    recognize: (params: { image_path: string; language?: string }) => ipcRenderer.invoke(IPC_CHANNELS.OCR_RECOGNIZE, params),
    status: () => ipcRenderer.invoke(IPC_CHANNELS.OCR_STATUS),
  },

  tool: {
    listBuiltin: () => ipcRenderer.invoke(IPC_CHANNELS.TOOL_LIST_BUILTIN),
    execute: (params: ToolExecuteParams) => ipcRenderer.invoke(IPC_CHANNELS.TOOL_EXECUTE, params),
    getEmployeeTools: (params: { employee_id: string }) => ipcRenderer.invoke(IPC_CHANNELS.TOOL_GET_EMPLOYEE_TOOLS, params),
    assignToEmployee: (params: ToolAssignParams) => ipcRenderer.invoke(IPC_CHANNELS.TOOL_ASSIGN_TO_EMPLOYEE, params),
    removeFromEmployee: (params: { employee_id: string; tool_id: string }) => ipcRenderer.invoke(IPC_CHANNELS.TOOL_REMOVE_FROM_EMPLOYEE, params),
  },

  mcp: {
    listServers: () => ipcRenderer.invoke(IPC_CHANNELS.MCP_SERVER_LIST),
    createServer: (params: MCPServerCreateParams) => ipcRenderer.invoke(IPC_CHANNELS.MCP_SERVER_CREATE, params),
    updateServer: (params: MCPServerUpdateParams) => ipcRenderer.invoke(IPC_CHANNELS.MCP_SERVER_UPDATE, params),
    deleteServer: (id: string) => ipcRenderer.invoke(IPC_CHANNELS.MCP_SERVER_DELETE, id),
    connectServer: (id: string) => ipcRenderer.invoke(IPC_CHANNELS.MCP_SERVER_CONNECT, id),
    disconnectServer: (id: string) => ipcRenderer.invoke(IPC_CHANNELS.MCP_SERVER_DISCONNECT, id),
  },

  skillRegistry: {
    list: () => ipcRenderer.invoke(IPC_CHANNELS.SKILL_REGISTRY_LIST),
    get: (id: string) => ipcRenderer.invoke(IPC_CHANNELS.SKILL_REGISTRY_GET, id),
    install: (params: { source: 'directory' | 'zip'; path: string }) => ipcRenderer.invoke(IPC_CHANNELS.SKILL_REGISTRY_INSTALL, params),
    uninstall: (id: string) => ipcRenderer.invoke(IPC_CHANNELS.SKILL_REGISTRY_UNINSTALL, id),
    toggle: (params: { id: string; enabled: boolean }) => ipcRenderer.invoke(IPC_CHANNELS.SKILL_REGISTRY_TOGGLE, params),
    getEmployeeSkills: (params: { employee_id: string }) => ipcRenderer.invoke(IPC_CHANNELS.SKILL_REGISTRY_GET_EMPLOYEE_SKILLS, params),
    assignToEmployee: (params: { employee_id: string; skill_id: string }) => ipcRenderer.invoke(IPC_CHANNELS.SKILL_REGISTRY_ASSIGN_TO_EMPLOYEE, params),
    removeFromEmployee: (params: { employee_id: string; skill_id: string }) => ipcRenderer.invoke(IPC_CHANNELS.SKILL_REGISTRY_REMOVE_FROM_EMPLOYEE, params),
  },

  kb: {
    list: () => ipcRenderer.invoke(IPC_CHANNELS.KB_LIST),
    get: (id: string) => ipcRenderer.invoke(IPC_CHANNELS.KB_GET, id),
    create: (params: KBCreateParams) => ipcRenderer.invoke(IPC_CHANNELS.KB_CREATE, params),
    update: (params: KBUpdateParams) => ipcRenderer.invoke(IPC_CHANNELS.KB_UPDATE, params),
    delete: (id: string) => ipcRenderer.invoke(IPC_CHANNELS.KB_DELETE, id),
    uploadDocuments: (params: { kb_id: string; paths: string[] }) => ipcRenderer.invoke(IPC_CHANNELS.KB_DOC_UPLOAD, params),
    parseDocument: (params: KBDocParseParams) => ipcRenderer.invoke(IPC_CHANNELS.KB_DOC_PARSE, params),
    deleteDocument: (id: string) => ipcRenderer.invoke(IPC_CHANNELS.KB_DOC_DELETE, id),
    getDocumentList: (params: { kb_id: string; status?: string }) => ipcRenderer.invoke(IPC_CHANNELS.KB_DOC_LIST, params),
    parseAll: (params: { kb_id: string }) => ipcRenderer.invoke(IPC_CHANNELS.KB_PARSE_ALL, params),
    getFileByHash: (params: { hash: string }) => ipcRenderer.invoke(IPC_CHANNELS.KB_GET_FILE_BY_HASH, params),
    onUploadProgress: (callback: (progress: { current: number; total: number; fileName: string }) => void) => {
      const handler = (_event: any, progress: { current: number; total: number; fileName: string }) => callback(progress)
      ipcRenderer.on(IPC_CHANNELS.KB_UPLOAD_PROGRESS, handler)
      return () => ipcRenderer.removeListener(IPC_CHANNELS.KB_UPLOAD_PROGRESS, handler)
    },
    onParseProgress: (callback: (progress: { doc_id: string; stage: string; detail: string }) => void) => {
      const handler = (_event: any, progress: { doc_id: string; stage: string; detail: string }) => callback(progress)
      ipcRenderer.on(IPC_CHANNELS.KB_PARSE_PROGRESS, handler)
      return () => ipcRenderer.removeListener(IPC_CHANNELS.KB_PARSE_PROGRESS, handler)
    },
    onParseAllProgress: (callback: (progress: { current: number; total: number; docName: string }) => void) => {
      const handler = (_event: any, progress: { current: number; total: number; docName: string }) => callback(progress)
      ipcRenderer.on(IPC_CHANNELS.KB_PARSE_ALL_PROGRESS, handler)
      return () => ipcRenderer.removeListener(IPC_CHANNELS.KB_PARSE_ALL_PROGRESS, handler)
    },
    processDocument: (params: { doc_id: string; provider_id?: string; model_id?: string; enable_thinking?: boolean }) => ipcRenderer.invoke(IPC_CHANNELS.KB_PROCESS_DOCUMENT, params),
    processAll: (params: { kb_id: string; provider_id?: string; model_id?: string; enable_thinking?: boolean }) => ipcRenderer.invoke(IPC_CHANNELS.KB_PROCESS_ALL, params),
    buildGlobal: (params: { kb_id: string; provider_id?: string; model_id?: string; enable_thinking?: boolean }) => ipcRenderer.invoke(IPC_CHANNELS.KB_BUILD_GLOBAL, params),
    getStats: (kbId: string) => ipcRenderer.invoke(IPC_CHANNELS.KB_GET_STATS, kbId),
    getChapters: (docId: string) => ipcRenderer.invoke(IPC_CHANNELS.KB_GET_CHAPTERS, docId),
    getDocSummary: (docId: string) => ipcRenderer.invoke(IPC_CHANNELS.KB_GET_DOC_SUMMARY, docId),
    getAllDocSummaries: (kbId: string) => ipcRenderer.invoke(IPC_CHANNELS.KB_GET_ALL_DOC_SUMMARIES, kbId),
    getGlobalSummary: (kbId: string) => ipcRenderer.invoke(IPC_CHANNELS.KB_GET_GLOBAL_SUMMARY, kbId),
    getEntities: (params: { kb_id: string; type?: string }) => ipcRenderer.invoke(IPC_CHANNELS.KB_GET_ENTITIES, params),
    getEntity: (params: { kb_id: string; name: string }) => ipcRenderer.invoke(IPC_CHANNELS.KB_GET_ENTITY, params),
    getEntityRelations: (params: { entity_id: string; depth?: number }) => ipcRenderer.invoke(IPC_CHANNELS.KB_GET_ENTITY_RELATIONS, params),
    getEntityMentions: (entityId: string) => ipcRenderer.invoke(IPC_CHANNELS.KB_GET_ENTITY_MENTIONS, entityId),
    searchChapters: (params: { kb_id: string; query: string; top_k?: number }) => ipcRenderer.invoke(IPC_CHANNELS.KB_SEARCH_CHAPTERS, params),
    searchDocSummaries: (params: { kb_id: string; query: string; top_k?: number }) => ipcRenderer.invoke(IPC_CHANNELS.KB_SEARCH_DOC_SUMMARIES, params),
    getProcessingJobs: (params: { kb_id: string; status?: string }) => ipcRenderer.invoke(IPC_CHANNELS.KB_GET_PROCESSING_JOBS, params),
    getDocContent: (docId: string) => ipcRenderer.invoke(IPC_CHANNELS.KB_GET_DOC_CONTENT, docId),
    onProcessProgress: (callback: (progress: { doc_id: string; stage: string; detail: string }) => void) => {
      const handler = (_event: any, progress: { doc_id: string; stage: string; detail: string }) => callback(progress)
      ipcRenderer.on(IPC_CHANNELS.KB_PROCESS_PROGRESS, handler)
      return () => ipcRenderer.removeListener(IPC_CHANNELS.KB_PROCESS_PROGRESS, handler)
    },
    onProcessAllProgress: (callback: (progress: { kb_id: string; stage: string; detail: string }) => void) => {
      const handler = (_event: any, progress: { kb_id: string; stage: string; detail: string }) => callback(progress)
      ipcRenderer.on(IPC_CHANNELS.KB_PROCESS_ALL_PROGRESS, handler)
      return () => ipcRenderer.removeListener(IPC_CHANNELS.KB_PROCESS_ALL_PROGRESS, handler)
    },
    onBuildGlobalProgress: (callback: (progress: { kb_id: string; stage: string; detail: string }) => void) => {
      const handler = (_event: any, progress: { kb_id: string; stage: string; detail: string }) => callback(progress)
      ipcRenderer.on(IPC_CHANNELS.KB_BUILD_GLOBAL_PROGRESS, handler)
      return () => ipcRenderer.removeListener(IPC_CHANNELS.KB_BUILD_GLOBAL_PROGRESS, handler)
    },
    pauseParse: (docId: string) => ipcRenderer.invoke(IPC_CHANNELS.KB_PAUSE_PARSE, docId),
    resumeParse: (docId: string) => ipcRenderer.invoke(IPC_CHANNELS.KB_RESUME_PARSE, docId),
    retryParse: (docId: string) => ipcRenderer.invoke(IPC_CHANNELS.KB_RETRY_PARSE, docId),
    getParseDetail: (docId: string) => ipcRenderer.invoke(IPC_CHANNELS.KB_GET_PARSE_DETAIL, docId),
    pauseAllParses: () => ipcRenderer.invoke(IPC_CHANNELS.KB_PAUSE_ALL_PARSES),
    resumeAllParses: () => ipcRenderer.invoke(IPC_CHANNELS.KB_RESUME_ALL_PARSES),
    cancelAllParses: () => ipcRenderer.invoke(IPC_CHANNELS.KB_CANCEL_ALL_PARSES),
    exportFull: (params: KBExportFullParams) => ipcRenderer.invoke(IPC_CHANNELS.KB_EXPORT_FULL, params),
    exportSummary: (params: KBExportSummaryParams) => ipcRenderer.invoke(IPC_CHANNELS.KB_EXPORT_SUMMARY, params),
    exportDocuments: (params: KBExportDocumentsParams) => ipcRenderer.invoke(IPC_CHANNELS.KB_EXPORT_DOCUMENTS, params),
    importFull: (params: KBImportFullParams) => ipcRenderer.invoke(IPC_CHANNELS.KB_IMPORT_FULL, params),
    importGraph: (params: KBImportGraphParams) => ipcRenderer.invoke(IPC_CHANNELS.KB_IMPORT_GRAPH, params),
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
    search: (params: { kb_id: string; query: string; top_k?: number; document_ids?: string[] }) => ipcRenderer.invoke(IPC_CHANNELS.KB_SEARCH, params),
    advancedSearch: (params: { kb_id: string; query: string; top_k?: number; document_type?: string }) => ipcRenderer.invoke(IPC_CHANNELS.KB_ADVANCED_SEARCH, params),
    searchWithEmbedding: (params: { kb_id: string; query: string; top_k?: number; document_ids?: string[]; provider_id?: string }) => ipcRenderer.invoke(IPC_CHANNELS.KB_SEARCH_WITH_EMBEDDING, params),
    searchIndexStats: (kbId: string) => ipcRenderer.invoke(IPC_CHANNELS.KB_SEARCH_INDEX_STATS, kbId),
    rebuildSearchIndex: (kbId: string) => ipcRenderer.invoke(IPC_CHANNELS.KB_REBUILD_SEARCH_INDEX, kbId),
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

  employeeTask: {
    list: (employeeId: string) => ipcRenderer.invoke(IPC_CHANNELS.EMPLOYEE_TASK_LIST, employeeId),
    get: (taskId: string) => ipcRenderer.invoke(IPC_CHANNELS.EMPLOYEE_TASK_GET, taskId),
    create: (params: EmployeeTaskCreateParams) => ipcRenderer.invoke(IPC_CHANNELS.EMPLOYEE_TASK_CREATE, params),
    update: (params: EmployeeTaskUpdateParams) => ipcRenderer.invoke(IPC_CHANNELS.EMPLOYEE_TASK_UPDATE, params),
    delete: (taskId: string) => ipcRenderer.invoke(IPC_CHANNELS.EMPLOYEE_TASK_DELETE, taskId),
    execute: (taskId: string) => ipcRenderer.invoke(IPC_CHANNELS.EMPLOYEE_TASK_EXECUTE, taskId),
    abortExecution: (executionId: string) => ipcRenderer.invoke(IPC_CHANNELS.EMPLOYEE_TASK_ABORT_EXECUTION, executionId),
    listSchedules: (employeeId: string) => ipcRenderer.invoke(IPC_CHANNELS.EMPLOYEE_SCHEDULE_LIST, employeeId),
    getSchedule: (scheduleId: string) => ipcRenderer.invoke(IPC_CHANNELS.EMPLOYEE_SCHEDULE_GET, scheduleId),
    createSchedule: (params: EmployeeScheduleCreateParams) => ipcRenderer.invoke(IPC_CHANNELS.EMPLOYEE_SCHEDULE_CREATE, params),
    updateSchedule: (params: EmployeeScheduleUpdateParams) => ipcRenderer.invoke(IPC_CHANNELS.EMPLOYEE_SCHEDULE_UPDATE, params),
    deleteSchedule: (scheduleId: string) => ipcRenderer.invoke(IPC_CHANNELS.EMPLOYEE_SCHEDULE_DELETE, scheduleId),
    validateCron: (cronExpr: string) => ipcRenderer.invoke(IPC_CHANNELS.EMPLOYEE_SCHEDULE_VALIDATE_CRON, cronExpr),
    listExecutions: (params: { employee_id: string; limit?: number; offset?: number }) => ipcRenderer.invoke(IPC_CHANNELS.EMPLOYEE_EXECUTION_LIST, params),
    listExecutionsForTask: (params: { task_id: string; limit?: number }) => ipcRenderer.invoke(IPC_CHANNELS.EMPLOYEE_EXECUTION_LIST_FOR_TASK, params),
    getExecution: (executionId: string) => ipcRenderer.invoke(IPC_CHANNELS.EMPLOYEE_EXECUTION_GET, executionId),
    allRecentExecutions: (limit?: number) => ipcRenderer.invoke(IPC_CHANNELS.EMPLOYEE_EXECUTION_ALL_RECENT, limit),
    failedExecutions: (limit?: number) => ipcRenderer.invoke(IPC_CHANNELS.EMPLOYEE_EXECUTION_FAILED, limit),
    deleteExecution: (executionId: string) => ipcRenderer.invoke(IPC_CHANNELS.EMPLOYEE_EXECUTION_DELETE, executionId),
    onTaskCompletion: (callback: (notification: any) => void) => {
      const handler = (_event: any, notification: any) => callback(notification)
      ipcRenderer.on(IPC_CHANNELS.TASK_NOTIFICATION_COMPLETION, handler)
      return () => ipcRenderer.removeListener(IPC_CHANNELS.TASK_NOTIFICATION_COMPLETION, handler)
    },
    onNotificationClick: (callback: (data: { executionId: string; taskId: string; employeeId: string }) => void) => {
      const handler = (_event: any, data: { executionId: string; taskId: string; employeeId: string }) => callback(data)
      ipcRenderer.on(IPC_CHANNELS.TASK_NOTIFICATION_CLICK, handler)
      return () => ipcRenderer.removeListener(IPC_CHANNELS.TASK_NOTIFICATION_CLICK, handler)
    },
    onSegmentsUpdate: (callback: (data: { executionId: string; segments: any[]; isStreaming: boolean }) => void) => {
      const handler = (_event: any, data: { executionId: string; segments: any[]; isStreaming: boolean }) => callback(data)
      ipcRenderer.on(IPC_CHANNELS.TASK_EXECUTION_SEGMENTS_UPDATE, handler)
      return () => ipcRenderer.removeListener(IPC_CHANNELS.TASK_EXECUTION_SEGMENTS_UPDATE, handler)
    },
    onExecutionStatusUpdate: (callback: (data: { executionId: string; status: string; errorMessage: string | null }) => void) => {
      const handler = (_event: any, data: { executionId: string; status: string; errorMessage: string | null }) => callback(data)
      ipcRenderer.on(IPC_CHANNELS.TASK_EXECUTION_STATUS_UPDATE, handler)
      return () => ipcRenderer.removeListener(IPC_CHANNELS.TASK_EXECUTION_STATUS_UPDATE, handler)
    },
  },

  workflow: {
    list: (params?: Record<string, never>) => ipcRenderer.invoke(IPC_CHANNELS.WORKFLOW_LIST, params),
    get: (id: string) => ipcRenderer.invoke(IPC_CHANNELS.WORKFLOW_GET, id),
    create: (params: WorkflowCreateParams) => ipcRenderer.invoke(IPC_CHANNELS.WORKFLOW_CREATE, params),
    update: (params: WorkflowUpdateParams) => ipcRenderer.invoke(IPC_CHANNELS.WORKFLOW_UPDATE, params),
    delete: (id: string) => ipcRenderer.invoke(IPC_CHANNELS.WORKFLOW_DELETE, id),
    execute: (workflowId: string) => ipcRenderer.invoke(IPC_CHANNELS.WORKFLOW_EXECUTE, workflowId),
    abortExecution: (executionId: string) => ipcRenderer.invoke(IPC_CHANNELS.WORKFLOW_ABORT_EXECUTION, executionId),
    getExecution: (executionId: string) => ipcRenderer.invoke(IPC_CHANNELS.WORKFLOW_GET_EXECUTION, executionId),
    listExecutions: (params: { workflow_id: string; limit?: number }) => ipcRenderer.invoke(IPC_CHANNELS.WORKFLOW_LIST_EXECUTIONS, params),
    onExecutionProgress: (callback: (data: any) => void) => {
      const handler = (_event: any, data: any) => callback(data)
      ipcRenderer.on(IPC_CHANNELS.WORKFLOW_EXECUTION_PROGRESS, handler)
      return () => ipcRenderer.removeListener(IPC_CHANNELS.WORKFLOW_EXECUTION_PROGRESS, handler)
    },
    onNodeExecutionUpdate: (callback: (data: any) => void) => {
      const handler = (_event: any, data: any) => callback(data)
      ipcRenderer.on(IPC_CHANNELS.WORKFLOW_NODE_EXECUTION_UPDATE, handler)
      return () => ipcRenderer.removeListener(IPC_CHANNELS.WORKFLOW_NODE_EXECUTION_UPDATE, handler)
    },
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
    pauseAll: (type?: string) => ipcRenderer.invoke(IPC_CHANNELS.TASK_PAUSE_ALL, type),
    resumeAll: (type?: string) => ipcRenderer.invoke(IPC_CHANNELS.TASK_RESUME_ALL, type),
    cancelAll: (type?: string) => ipcRenderer.invoke(IPC_CHANNELS.TASK_CANCEL_ALL, type),
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
    pauseAll: (type?: string) => Promise<number>
    resumeAll: (type?: string) => Promise<number>
    cancelAll: (type?: string) => Promise<number>
    onTasksUpdated: (callback: (tasks: any[]) => void) => () => void
  }
  interaction: {
    onRequest: (callback: (request: any) => void) => () => void
    respond: (response: { id: string; confirmed?: boolean; selectedValue?: string; inputValue?: string; cancelled: boolean }) => Promise<{ success: boolean }>
  }
  employeeTask: {
    list: (employeeId: string) => Promise<any[]>
    get: (taskId: string) => Promise<any>
    create: (params: any) => Promise<any>
    update: (params: any) => Promise<any>
    delete: (taskId: string) => Promise<boolean>
    execute: (taskId: string) => Promise<{ success: boolean; execution?: any; error?: string }>
    abortExecution: (executionId: string) => Promise<boolean>
    listSchedules: (employeeId: string) => Promise<any[]>
    getSchedule: (scheduleId: string) => Promise<any>
    createSchedule: (params: any) => Promise<any>
    updateSchedule: (params: any) => Promise<any>
    deleteSchedule: (scheduleId: string) => Promise<boolean>
    validateCron: (cronExpr: string) => Promise<{ valid: boolean; error?: string; nextRun?: string }>
    listExecutions: (params: { employee_id: string; limit?: number; offset?: number }) => Promise<any[]>
    listExecutionsForTask: (params: { task_id: string; limit?: number }) => Promise<any[]>
    getExecution: (executionId: string) => Promise<any>
    allRecentExecutions: (limit?: number) => Promise<any[]>
    failedExecutions: (limit?: number) => Promise<any[]>
    deleteExecution: (executionId: string) => Promise<boolean>
    onTaskCompletion: (callback: (notification: any) => void) => () => void
    onNotificationClick: (callback: (data: { executionId: string; taskId: string; employeeId: string }) => void) => () => void
    onSegmentsUpdate: (callback: (data: { executionId: string; segments: any[]; isStreaming: boolean }) => void) => () => void
    onExecutionStatusUpdate: (callback: (data: { executionId: string; status: string; errorMessage: string | null }) => void) => () => void
  }
  workflow: {
    list: (params?: Record<string, never>) => Promise<any[]>
    get: (id: string) => Promise<any>
    create: (params: WorkflowCreateParams) => Promise<any>
    update: (params: WorkflowUpdateParams) => Promise<any>
    delete: (id: string) => Promise<boolean>
    execute: (workflowId: string) => Promise<{ success: boolean; executionId?: string; error?: string }>
    abortExecution: (executionId: string) => Promise<boolean>
    getExecution: (executionId: string) => Promise<any>
    listExecutions: (params: { workflow_id: string; limit?: number }) => Promise<any[]>
    onExecutionProgress: (callback: (data: any) => void) => () => void
    onNodeExecutionUpdate: (callback: (data: any) => void) => () => void
  }
}

declare global {
  interface Window {
    electronAPI: ElectronAPI
  }
}