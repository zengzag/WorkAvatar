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
  LLMChatStreamWithRAGParams,
  EmployeeChatStreamParams,
  SettingsGetParams,
  SettingsSetParams,
  EmployeeProfileAnalyzeParams,
  ToolExecuteParams,
  ToolAssignParams,
  MCPServerCreateParams,
  MCPServerUpdateParams,
  WikiCompileParams,
  WikiSearchParams,
  WikiChatParams,
  WikiIngestParams,
  WikiQueryParams,
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
    chatStreamWithRAG: (params: LLMChatStreamWithRAGParams) => ipcRenderer.invoke(IPC_CHANNELS.LLM_CHAT_STREAM_WITH_RAG, params),
    employeeChatStream: (params: EmployeeChatStreamParams) => ipcRenderer.invoke(IPC_CHANNELS.EMPLOYEE_CHAT_STREAM, params),
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
    onRAGResults: (callback: (results: any[]) => void) => {
      const handler = (_event: any, results: any[]) => callback(results)
      ipcRenderer.on('llm:rag-results', handler)
      return () => ipcRenderer.removeListener('llm:rag-results', handler)
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

  rag: {
    indexProject: (params: { project_id: string }) => ipcRenderer.invoke(IPC_CHANNELS.RAG_INDEX_PROJECT, params),
    search: (params: { project_id: string; query: string; top_k?: number }) => ipcRenderer.invoke(IPC_CHANNELS.RAG_SEARCH, params),
    indexStatus: (params: { project_id: string }) => ipcRenderer.invoke(IPC_CHANNELS.RAG_INDEX_STATUS, params),
    deleteIndex: (params: { project_id: string }) => ipcRenderer.invoke(IPC_CHANNELS.RAG_DELETE_INDEX, params),
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

  wiki: {
    initialize: (params: { project_id: string }) => ipcRenderer.invoke(IPC_CHANNELS.WIKI_INITIALIZE, params),
    compile: (params: WikiCompileParams) => ipcRenderer.invoke(IPC_CHANNELS.WIKI_COMPILE, params),
    search: (params: WikiSearchParams) => ipcRenderer.invoke(IPC_CHANNELS.WIKI_SEARCH, params),
    getStatus: (params: { project_id: string }) => ipcRenderer.invoke(IPC_CHANNELS.WIKI_GET_STATUS, params),
    getPages: (params: { project_id: string }) => ipcRenderer.invoke(IPC_CHANNELS.WIKI_GET_PAGES, params),
    getPage: (params: { project_id: string; page_path: string }) => ipcRenderer.invoke(IPC_CHANNELS.WIKI_GET_PAGE, params),
    getRawFiles: (params: { project_id: string }) => ipcRenderer.invoke(IPC_CHANNELS.WIKI_GET_RAW_FILES, params),
    ingestSource: (params: WikiIngestParams) => ipcRenderer.invoke(IPC_CHANNELS.WIKI_INGEST_SOURCE, params),
    query: (params: WikiQueryParams) => ipcRenderer.invoke(IPC_CHANNELS.WIKI_QUERY, params),
    lint: (params: { project_id: string }) => ipcRenderer.invoke(IPC_CHANNELS.WIKI_LINT, params),
    audit: (params: { project_id: string }) => ipcRenderer.invoke(IPC_CHANNELS.WIKI_AUDIT, params),
    chatWithWiki: (params: WikiChatParams) => ipcRenderer.invoke(IPC_CHANNELS.WIKI_CHAT_WITH_WIKI, params),
    onWikiResults: (callback: (results: any[]) => void) => {
      const handler = (_event: any, results: any[]) => callback(results)
      ipcRenderer.on('llm:wiki-results', handler)
      return () => ipcRenderer.removeListener('llm:wiki-results', handler)
    },
    onIngestProgress: (callback: (progress: { stage: string; detail: string }) => void) => {
      const handler = (_event: any, progress: { stage: string; detail: string }) => callback(progress)
      ipcRenderer.on('wiki:ingest-progress', handler)
      return () => ipcRenderer.removeListener('wiki:ingest-progress', handler)
    },
    onIngestLLMChunk: (callback: (chunk: string) => void) => {
      const handler = (_event: any, chunk: string) => callback(chunk)
      ipcRenderer.on('wiki:ingest-llm-chunk', handler)
      return () => ipcRenderer.removeListener('wiki:ingest-llm-chunk', handler)
    },
    onIngestThought: (callback: (thought: string) => void) => {
      const handler = (_event: any, thought: string) => callback(thought)
      ipcRenderer.on('wiki:ingest-thought', handler)
      return () => ipcRenderer.removeListener('wiki:ingest-thought', handler)
    },
    onCompileProgress: (callback: (progress: { stage: string; detail: string }) => void) => {
      const handler = (_event: any, progress: { stage: string; detail: string }) => callback(progress)
      ipcRenderer.on('wiki:compile-progress', handler)
      return () => ipcRenderer.removeListener('wiki:compile-progress', handler)
    },
    onCompileLLMChunk: (callback: (chunk: string) => void) => {
      const handler = (_event: any, chunk: string) => callback(chunk)
      ipcRenderer.on('wiki:compile-llm-chunk', handler)
      return () => ipcRenderer.removeListener('wiki:compile-llm-chunk', handler)
    },
    onCompileThought: (callback: (thought: string) => void) => {
      const handler = (_event: any, thought: string) => callback(thought)
      ipcRenderer.on('wiki:compile-thought', handler)
      return () => ipcRenderer.removeListener('wiki:compile-thought', handler)
    },
    onQueryProgress: (callback: (progress: { stage: string; detail: string }) => void) => {
      const handler = (_event: any, progress: { stage: string; detail: string }) => callback(progress)
      ipcRenderer.on('wiki:query-progress', handler)
      return () => ipcRenderer.removeListener('wiki:query-progress', handler)
    },
  },
}

contextBridge.exposeInMainWorld('electronAPI', electronAPI)

export type ElectronAPI = typeof electronAPI

declare global {
  interface Window {
    electronAPI: ElectronAPI
  }
}
