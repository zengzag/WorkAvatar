import { contextBridge, ipcRenderer } from 'electron'
import { IPC_CHANNELS } from '../shared/ipc-channels'
import type {
  ProjectListParams,
  ProjectCreateParams,
  ProjectUpdateParams,
  FileListParams,
  FileImportParams,
  FileParseParams,
  FileGetContentParams,
  EmployeeListParams,
  EmployeeCreateParams,
  EmployeeUpdateParams,
  SkillListParams,
  SkillCreateParams,
  SkillUpdateParams,
  ConversationListParams,
  ConversationCreateParams,
  AppGetPathParams,
  AppShowOpenDialogParams,
  LLMProviderCreateParams,
  LLMProviderUpdateParams,
  LLMTestConnectionParams,
  LLMChatStreamParams,
  EmployeeChatStreamParams,
  SettingsGetParams,
  SettingsSetParams,
  EmployeeProfileAnalyzeParams,
  ToolExecuteParams,
  ToolAssignParams,
  MCPServerCreateParams,
  MCPServerUpdateParams,
  KBCreateParams,
  KBUpdateParams,
  KBDocParseParams,
  KBLinkProjectParams,
} from '../shared/ipc-channels'

const electronAPI = {
  ping: () => ipcRenderer.invoke(IPC_CHANNELS.PING),

  project: {
    list: (params?: ProjectListParams) => ipcRenderer.invoke(IPC_CHANNELS.PROJECT_LIST, params),
    get: (id: string) => ipcRenderer.invoke(IPC_CHANNELS.PROJECT_GET, id),
    create: (params: ProjectCreateParams) => ipcRenderer.invoke(IPC_CHANNELS.PROJECT_CREATE, params),
    update: (params: ProjectUpdateParams) => ipcRenderer.invoke(IPC_CHANNELS.PROJECT_UPDATE, params),
    delete: (id: string) => ipcRenderer.invoke(IPC_CHANNELS.PROJECT_DELETE, id),
  },

  file: {
    list: (params: FileListParams) => ipcRenderer.invoke(IPC_CHANNELS.FILE_LIST, params),
    get: (id: string) => ipcRenderer.invoke(IPC_CHANNELS.FILE_GET, id),
    import: (params: FileImportParams) => ipcRenderer.invoke(IPC_CHANNELS.FILE_IMPORT, params),
    delete: (id: string) => ipcRenderer.invoke(IPC_CHANNELS.FILE_DELETE, id),
    parse: (params: FileParseParams) => ipcRenderer.invoke(IPC_CHANNELS.FILE_PARSE, params),
    getContent: (params: FileGetContentParams) => ipcRenderer.invoke(IPC_CHANNELS.FILE_GET_CONTENT, params),
  },

  employee: {
    list: (params?: EmployeeListParams) => ipcRenderer.invoke(IPC_CHANNELS.EMPLOYEE_LIST, params),
    get: (id: string) => ipcRenderer.invoke(IPC_CHANNELS.EMPLOYEE_GET, id),
    create: (params: EmployeeCreateParams) => ipcRenderer.invoke(IPC_CHANNELS.EMPLOYEE_CREATE, params),
    update: (params: EmployeeUpdateParams) => ipcRenderer.invoke(IPC_CHANNELS.EMPLOYEE_UPDATE, params),
    delete: (id: string) => ipcRenderer.invoke(IPC_CHANNELS.EMPLOYEE_DELETE, id),
    analyzeProfile: (params: EmployeeProfileAnalyzeParams) => ipcRenderer.invoke(IPC_CHANNELS.EMPLOYEE_PROFILE_ANALYZE, params),
    onProfileProgress: (callback: (data: { stage: string; detail?: string; chunk?: string }) => void) => {
      const handler = (_event: any, data: { stage: string; detail?: string; chunk?: string }) => callback(data)
      ipcRenderer.on(IPC_CHANNELS.EMPLOYEE_PROFILE_PROGRESS, handler)
      return () => ipcRenderer.removeListener(IPC_CHANNELS.EMPLOYEE_PROFILE_PROGRESS, handler)
    },
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
    sendMessage: (params: { conversation_id: string; role: 'user' | 'assistant'; content: string }) =>
      ipcRenderer.invoke(IPC_CHANNELS.CONVERSATION_SEND_MESSAGE, params),
  },

  llm: {
    getProviders: () => ipcRenderer.invoke(IPC_CHANNELS.LLM_PROVIDER_LIST),
    getProvider: (id: string) => ipcRenderer.invoke(IPC_CHANNELS.LLM_PROVIDER_GET, id),
    createProvider: (params: LLMProviderCreateParams) => ipcRenderer.invoke(IPC_CHANNELS.LLM_PROVIDER_CREATE, params),
    updateProvider: (params: LLMProviderUpdateParams) => ipcRenderer.invoke(IPC_CHANNELS.LLM_PROVIDER_UPDATE, params),
    deleteProvider: (id: string) => ipcRenderer.invoke(IPC_CHANNELS.LLM_PROVIDER_DELETE, id),
    testConnection: (params: LLMTestConnectionParams) => ipcRenderer.invoke(IPC_CHANNELS.LLM_TEST_CONNECTION, params),
    chatStream: (params: LLMChatStreamParams) => ipcRenderer.invoke(IPC_CHANNELS.LLM_CHAT_STREAM, params),
    employeeChatStream: (params: EmployeeChatStreamParams) => ipcRenderer.invoke(IPC_CHANNELS.EMPLOYEE_CHAT_STREAM, params),
    abortChat: () => ipcRenderer.invoke('llm:abort-chat'),
    onChunk: (callback: (chunk: string) => void) => {
      const handler = (_event: any, chunk: string) => callback(chunk)
      ipcRenderer.on('llm:chat-chunk', handler)
      return () => ipcRenderer.removeListener('llm:chat-chunk', handler)
    },
    onDone: (callback: () => void) => {
      const handler = () => callback()
      ipcRenderer.on('llm:chat-done', handler)
      return () => ipcRenderer.removeListener('llm:chat-done', handler)
    },
    onError: (callback: (error: string) => void) => {
      const handler = (_event: any, error: string) => callback(error)
      ipcRenderer.on('llm:chat-error', handler)
      return () => ipcRenderer.removeListener('llm:chat-error', handler)
    },
    onThought: (callback: (thought: string) => void) => {
      const handler = (_event: any, thought: string) => callback(thought)
      ipcRenderer.on('llm:thought', handler)
      return () => ipcRenderer.removeListener('llm:thought', handler)
    },
    onToolCall: (callback: (toolCall: { name: string; args: any }) => void) => {
      const handler = (_event: any, toolCall: { name: string; args: any }) => callback(toolCall)
      ipcRenderer.on('agent:tool-call', handler)
      return () => ipcRenderer.removeListener('agent:tool-call', handler)
    },
    onToolResult: (callback: (toolResult: { name: string; result: any }) => void) => {
      const handler = (_event: any, toolResult: { name: string; result: any }) => callback(toolResult)
      ipcRenderer.on('agent:tool-result', handler)
      return () => ipcRenderer.removeListener('agent:tool-result', handler)
    },
  },

  settings: {
    get: (params: SettingsGetParams) => ipcRenderer.invoke(IPC_CHANNELS.SETTINGS_GET, params),
    set: (params: SettingsSetParams) => ipcRenderer.invoke(IPC_CHANNELS.SETTINGS_SET, params),
  },

  app: {
    getPath: (params: AppGetPathParams) => ipcRenderer.invoke(IPC_CHANNELS.APP_GET_PATH, params),
    showOpenDialog: (params: AppShowOpenDialogParams) => ipcRenderer.invoke(IPC_CHANNELS.APP_SHOW_OPEN_DIALOG, params),
    showMessageBox: (params: any) => ipcRenderer.invoke(IPC_CHANNELS.APP_SHOW_MESSAGE_BOX, params),
  },

  ocr: {
    recognize: (params: { image_path: string; language?: string }) => ipcRenderer.invoke(IPC_CHANNELS.OCR_RECOGNIZE, params),
    status: () => ipcRenderer.invoke(IPC_CHANNELS.OCR_STATUS),
  },

  rule: {
    extractFile: (params: { file_id: string; provider_id?: string; model_id?: string }) => ipcRenderer.invoke(IPC_CHANNELS.RULE_EXTRACT_FILE, params),
    extractProject: (params: { project_id: string; provider_id?: string; model_id?: string }) => ipcRenderer.invoke(IPC_CHANNELS.RULE_EXTRACT_PROJECT, params),
  },

  sandbox: {
    testSkill: (params: { skill_id: string; provider_id?: string; model_id?: string }) => ipcRenderer.invoke(IPC_CHANNELS.SANDBOX_TEST_SKILL, params),
    testEmployee: (params: { employee_id: string; provider_id?: string; model_id?: string }) => ipcRenderer.invoke(IPC_CHANNELS.SANDBOX_TEST_EMPLOYEE, params),
    generateCases: (params: { skill_id: string }) => ipcRenderer.invoke(IPC_CHANNELS.SANDBOX_GENERATE_CASES, params),
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
    linkProject: (params: KBLinkProjectParams) => ipcRenderer.invoke(IPC_CHANNELS.KB_LINK_PROJECT, params),
    unlinkProject: (params: KBLinkProjectParams) => ipcRenderer.invoke(IPC_CHANNELS.KB_UNLINK_PROJECT, params),
    getLinkedProjects: (kbId: string) => ipcRenderer.invoke(IPC_CHANNELS.KB_GET_PROJECTS, kbId),
    parseAll: (params: { kb_id: string }) => ipcRenderer.invoke(IPC_CHANNELS.KB_PARSE_ALL, params),
    getFileByHash: (params: { hash: string }) => ipcRenderer.invoke(IPC_CHANNELS.KB_GET_FILE_BY_HASH, params),
    importDocsToProject: (params: { project_id: string; doc_ids: string[] }) => ipcRenderer.invoke(IPC_CHANNELS.KB_IMPORT_DOCS_TO_PROJECT, params),
    onUploadProgress: (callback: (progress: { current: number; total: number; fileName: string }) => void) => {
      const handler = (_event: any, progress: { current: number; total: number; fileName: string }) => callback(progress)
      ipcRenderer.on('kb:upload-progress', handler)
      return () => ipcRenderer.removeListener('kb:upload-progress', handler)
    },
    onParseProgress: (callback: (progress: { doc_id: string; stage: string; detail: string }) => void) => {
      const handler = (_event: any, progress: { doc_id: string; stage: string; detail: string }) => callback(progress)
      ipcRenderer.on('kb:parse-progress', handler)
      return () => ipcRenderer.removeListener('kb:parse-progress', handler)
    },
    onParseAllProgress: (callback: (progress: { current: number; total: number; docName: string }) => void) => {
      const handler = (_event: any, progress: { current: number; total: number; docName: string }) => callback(progress)
      ipcRenderer.on('kb:parse-all-progress', handler)
      return () => ipcRenderer.removeListener('kb:parse-all-progress', handler)
    },
    processDocument: (params: { doc_id: string; provider_id?: string; model_id?: string }) => ipcRenderer.invoke(IPC_CHANNELS.KB_PROCESS_DOCUMENT, params),
    processAll: (params: { kb_id: string; provider_id?: string; model_id?: string }) => ipcRenderer.invoke(IPC_CHANNELS.KB_PROCESS_ALL, params),
    buildGlobal: (params: { kb_id: string; provider_id?: string; model_id?: string }) => ipcRenderer.invoke(IPC_CHANNELS.KB_BUILD_GLOBAL, params),
    getStats: (kbId: string) => ipcRenderer.invoke(IPC_CHANNELS.KB_GET_STATS, kbId),
    getChapters: (docId: string) => ipcRenderer.invoke(IPC_CHANNELS.KB_GET_CHAPTERS, docId),
    getDocSummary: (docId: string) => ipcRenderer.invoke(IPC_CHANNELS.KB_GET_DOC_SUMMARY, docId),
    getGlobalSummary: (kbId: string) => ipcRenderer.invoke(IPC_CHANNELS.KB_GET_GLOBAL_SUMMARY, kbId),
    getEntities: (params: { kb_id: string; type?: string }) => ipcRenderer.invoke(IPC_CHANNELS.KB_GET_ENTITIES, params),
    getEntity: (params: { kb_id: string; name: string }) => ipcRenderer.invoke(IPC_CHANNELS.KB_GET_ENTITY, params),
    getEntityRelations: (params: { entity_id: string; depth?: number }) => ipcRenderer.invoke(IPC_CHANNELS.KB_GET_ENTITY_RELATIONS, params),
    getEntityMentions: (entityId: string) => ipcRenderer.invoke(IPC_CHANNELS.KB_GET_ENTITY_MENTIONS, entityId),
    searchChapters: (params: { kb_id: string; query: string; top_k?: number }) => ipcRenderer.invoke(IPC_CHANNELS.KB_SEARCH_CHAPTERS, params),
    searchDocSummaries: (params: { kb_id: string; query: string; top_k?: number }) => ipcRenderer.invoke(IPC_CHANNELS.KB_SEARCH_DOC_SUMMARIES, params),
    generateTimeline: (params: { kb_id: string; topic?: string }) => ipcRenderer.invoke(IPC_CHANNELS.KB_GENERATE_TIMELINE, params),
    getProcessingJobs: (params: { kb_id: string; status?: string }) => ipcRenderer.invoke(IPC_CHANNELS.KB_GET_PROCESSING_JOBS, params),
    getKBsForProject: (projectId: string) => ipcRenderer.invoke(IPC_CHANNELS.KB_GET_KBS_FOR_PROJECT, projectId),
    getDocContent: (docId: string) => ipcRenderer.invoke(IPC_CHANNELS.KB_GET_DOC_CONTENT, docId),
    onProcessProgress: (callback: (progress: { doc_id: string; stage: string; detail: string }) => void) => {
      const handler = (_event: any, progress: { doc_id: string; stage: string; detail: string }) => callback(progress)
      ipcRenderer.on('kb:process-progress', handler)
      return () => ipcRenderer.removeListener('kb:process-progress', handler)
    },
    onProcessAllProgress: (callback: (progress: { kb_id: string; stage: string; detail: string }) => void) => {
      const handler = (_event: any, progress: { kb_id: string; stage: string; detail: string }) => callback(progress)
      ipcRenderer.on('kb:process-all-progress', handler)
      return () => ipcRenderer.removeListener('kb:process-all-progress', handler)
    },
    onBuildGlobalProgress: (callback: (progress: { kb_id: string; stage: string; detail: string }) => void) => {
      const handler = (_event: any, progress: { kb_id: string; stage: string; detail: string }) => callback(progress)
      ipcRenderer.on('kb:build-global-progress', handler)
      return () => ipcRenderer.removeListener('kb:build-global-progress', handler)
    },
  },
}

contextBridge.exposeInMainWorld('electronAPI', {
  ...electronAPI,
  tasks: {
    getAll: () => ipcRenderer.invoke('tasks:get-all'),
    clearCompleted: () => ipcRenderer.invoke('tasks:clear-completed'),
    cancel: (taskId: string) => ipcRenderer.invoke('tasks:cancel', taskId),
    onTasksUpdated: (callback: (tasks: any[]) => void) => {
      const handler = (_event: any, tasks: any[]) => callback(tasks)
      ipcRenderer.on('tasks:updated', handler)
      return () => ipcRenderer.removeListener('tasks:updated', handler)
    },
  },
})

export type ElectronAPI = typeof electronAPI & {
  tasks: {
    getAll: () => Promise<any[]>
    clearCompleted: () => Promise<boolean>
    cancel: (taskId: string) => Promise<boolean>
    onTasksUpdated: (callback: (tasks: any[]) => void) => () => void
  }
}

declare global {
  interface Window {
    electronAPI: ElectronAPI
  }
}