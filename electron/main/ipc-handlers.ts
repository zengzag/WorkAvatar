import { ipcMain, dialog, app } from 'electron'
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
  SettingsGetParams,
  SettingsSetParams,
  EmployeeProfileAnalyzeParams,
  ToolExecuteParams,
  ToolAssignParams,
  MCPServerCreateParams,
  MCPServerUpdateParams,
  WikiIngestParams,
  WikiQueryParams,
} from '../shared/ipc-channels'
import ProjectManagerService from './services/project-manager.service'
import FileParserService from './services/file-parser.service'
import LLMClientService from './services/llm-client.service'
import RAGService from './services/rag.service'
import OCRService from './services/ocr.service'
import RuleExtractionService from './services/rule-extraction.service'
import SandboxTesterService from './services/sandbox-tester.service'
import DatabaseService from './services/database.service'
import EmployeeProfilingService from './services/employee-profiling.service'
import ToolEngineService from './services/tool-engine.service'
import SkillRegistryService from './services/skill-registry.service'
import LLMWikiService from './services/llm-wiki.service'
import EmployeeAgentService from './services/employee-agent.service'

export function registerIpcHandlers() {
  const projectManager = ProjectManagerService.getInstance()
  const fileParser = FileParserService.getInstance()
  const llmClient = LLMClientService.getInstance()
  const ragService = RAGService.getInstance()
  const ocrService = OCRService.getInstance()
  const ruleExtractor = RuleExtractionService.getInstance()
  const sandboxTester = SandboxTesterService.getInstance()
  const profilingService = EmployeeProfilingService.getInstance()
  const toolEngine = ToolEngineService.getInstance()
  const skillRegistry = SkillRegistryService.getInstance()
  const wikiService = LLMWikiService.getInstance()
  const employeeAgent = EmployeeAgentService.getInstance()
  const db = DatabaseService.getInstance().getDb()

  ipcMain.handle(IPC_CHANNELS.PING, () => {
    return 'pong from main process'
  })

  ipcMain.handle(IPC_CHANNELS.PROJECT_LIST, (_, params?: ProjectListParams) => {
    return projectManager.getProjectList(params?.limit, params?.offset)
  })

  ipcMain.handle(IPC_CHANNELS.PROJECT_GET, (_, id: string) => {
    return projectManager.getProject(id)
  })

  ipcMain.handle(IPC_CHANNELS.PROJECT_CREATE, (_, params: ProjectCreateParams) => {
    return projectManager.createProject(params.name, params.description, params.root_path)
  })

  ipcMain.handle(IPC_CHANNELS.PROJECT_UPDATE, (_, params: ProjectUpdateParams) => {
    const { id, ...data } = params
    return projectManager.updateProject(id, data)
  })

  ipcMain.handle(IPC_CHANNELS.PROJECT_DELETE, (_, id: string) => {
    return projectManager.deleteProject(id)
  })

  ipcMain.handle(IPC_CHANNELS.FILE_LIST, (_, params: FileListParams) => {
    return projectManager.getFileList(params.project_id, params.status)
  })

  ipcMain.handle(IPC_CHANNELS.FILE_GET, (_, id: string) => {
    return projectManager.getFile(id)
  })

  ipcMain.handle(IPC_CHANNELS.FILE_IMPORT, async (_, params: FileImportParams) => {
    const imported = []
    const errors = []

    for (const filePath of params.paths) {
      try {
        const result = await fileParser.importFile(params.project_id, filePath)
        imported.push(result)
      } catch (error) {
        errors.push({
          path: filePath,
          error: error instanceof Error ? error.message : 'Unknown error',
        })
      }
    }

    return { success: imported.length > 0, imported, errors }
  })

  ipcMain.handle(IPC_CHANNELS.FILE_DELETE, (_, id: string) => {
    return projectManager.deleteFile(id)
  })

  ipcMain.handle(IPC_CHANNELS.FILE_PARSE, async (_, params: FileParseParams) => {
    try {
      const result = await fileParser.parseFile(params.file_id)
      return { success: true, result }
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      }
    }
  })

  ipcMain.handle(IPC_CHANNELS.FILE_GET_CONTENT, (_, params: FileGetContentParams) => {
    const content = fileParser.getFileContent(params.file_id)
    return {
      success: content !== null,
      content: content || undefined,
    }
  })

  ipcMain.handle(IPC_CHANNELS.EMPLOYEE_LIST, (_, params?: EmployeeListParams) => {
    return projectManager.getEmployeeList(params?.project_id, params?.status)
  })

  ipcMain.handle(IPC_CHANNELS.EMPLOYEE_GET, (_, id: string) => {
    return projectManager.getEmployee(id)
  })

  ipcMain.handle(IPC_CHANNELS.EMPLOYEE_CREATE, (_, params: EmployeeCreateParams) => {
    return projectManager.createEmployee(params.project_id, params.name, params.description, params.profile_json)
  })

  ipcMain.handle(IPC_CHANNELS.EMPLOYEE_UPDATE, (_, params: EmployeeUpdateParams) => {
    const { id, ...data } = params
    return projectManager.updateEmployee(id, data)
  })

  ipcMain.handle(IPC_CHANNELS.EMPLOYEE_DELETE, (_, id: string) => {
    return projectManager.deleteEmployee(id)
  })

  ipcMain.handle(IPC_CHANNELS.SKILL_LIST, (_, params: SkillListParams) => {
    return projectManager.getSkillList(params.employee_id)
  })

  ipcMain.handle(IPC_CHANNELS.SKILL_CREATE, (_, params: SkillCreateParams) => {
    return projectManager.createSkill(
      params.employee_id,
      params.type,
      params.name,
      params.description,
      params.prompt_template
    )
  })

  ipcMain.handle(IPC_CHANNELS.SKILL_UPDATE, (_, params: SkillUpdateParams) => {
    const { id, ...data } = params
    return projectManager.updateSkill(id, data)
  })

  ipcMain.handle(IPC_CHANNELS.SKILL_DELETE, (_, id: string) => {
    return projectManager.deleteSkill(id)
  })

  ipcMain.handle(IPC_CHANNELS.CONVERSATION_LIST, (_, params: ConversationListParams) => {
    return projectManager.getConversationList(params.employee_id)
  })

  ipcMain.handle(IPC_CHANNELS.CONVERSATION_GET, (_, id: string) => {
    return projectManager.getConversation(id)
  })

  ipcMain.handle(IPC_CHANNELS.CONVERSATION_CREATE, (_, params: ConversationCreateParams) => {
    return projectManager.createConversation(params.employee_id, params.skill_id, params.title)
  })

  ipcMain.handle(IPC_CHANNELS.CONVERSATION_UPDATE, (_, params: { id: string; title?: string; messages_json?: string; message_count?: number; status?: string }) => {
    const { id, ...data } = params
    return projectManager.updateConversation(id, data)
  })

  ipcMain.handle(IPC_CHANNELS.CONVERSATION_DELETE, (_, id: string) => {
    return projectManager.deleteConversation(id)
  })

  ipcMain.handle(IPC_CHANNELS.APP_GET_PATH, (_, params: AppGetPathParams) => {
    return app.getPath(params.name)
  })

  ipcMain.handle(IPC_CHANNELS.APP_SHOW_OPEN_DIALOG, async (_, params: AppShowOpenDialogParams) => {
    const result = await dialog.showOpenDialog({
      title: params.title,
      defaultPath: params.defaultPath,
      buttonLabel: params.buttonLabel,
      filters: params.filters,
      properties: params.properties,
    })
    return result
  })

  ipcMain.handle(IPC_CHANNELS.APP_SHOW_MESSAGE_BOX, async (_, params: any) => {
    const result = await dialog.showMessageBox({
      type: params.type,
      title: params.title,
      message: params.message,
      detail: params.detail,
      buttons: params.buttons,
      defaultId: params.defaultId,
    })
    return result
  })

  ipcMain.handle(IPC_CHANNELS.LLM_PROVIDER_LIST, () => {
    return llmClient.getProviderList()
  })

  ipcMain.handle(IPC_CHANNELS.LLM_PROVIDER_GET, (_, id: string) => {
    return llmClient.getProvider(id)
  })

  ipcMain.handle(IPC_CHANNELS.LLM_PROVIDER_CREATE, async (_, params: LLMProviderCreateParams) => {
    return llmClient.createProvider(params)
  })

  ipcMain.handle(IPC_CHANNELS.LLM_PROVIDER_UPDATE, async (_, params: LLMProviderUpdateParams) => {
    const { id, ...data } = params
    return llmClient.updateProvider(id, data)
  })

  ipcMain.handle(IPC_CHANNELS.LLM_PROVIDER_DELETE, async (_, id: string) => {
    return llmClient.deleteProvider(id)
  })

  ipcMain.handle(IPC_CHANNELS.LLM_TEST_CONNECTION, async (_, params: LLMTestConnectionParams) => {
    return llmClient.testConnection(params.provider_id)
  })

  ipcMain.handle(IPC_CHANNELS.LLM_CHAT_STREAM, async (event, params: LLMChatStreamParams) => {
    await llmClient.chatStream(
      params.provider_id,
      params.messages,
      (chunk: string) => {
        event.sender.send('llm:chat-chunk', chunk)
      },
      () => {
        event.sender.send('llm:chat-done')
      },
      (error: Error) => {
        event.sender.send('llm:chat-error', error.message)
      },
      params.model_id ? { ...params.options, model: params.model_id } : params.options,
      undefined,
      (thoughtChunk: string) => {
        event.sender.send('llm:thought', thoughtChunk)
      },
    )
    return { success: true }
  })

  ipcMain.handle(IPC_CHANNELS.EMPLOYEE_CHAT_STREAM, async (event, params: any) => {
    try {
      await employeeAgent.chatStream(
        {
          employee_id: params.employee_id,
          provider_id: params.provider_id,
          model_id: params.model_id,
          messages: params.messages,
          use_skills: params.use_skills !== false,
          use_wiki: params.use_wiki !== false,
          use_rag: params.use_rag !== false,
        },
        {
          onChunk: (chunk: string) => {
            event.sender.send('llm:chat-chunk', chunk)
          },
          onThought: (thought: string) => {
            event.sender.send('llm:thought', thought)
          },
          onToolCall: (toolCall: { name: string; args: any }) => {
            event.sender.send('agent:tool-call', toolCall)
          },
          onToolResult: (toolResult: { name: string; result: any; rawResult?: any }) => {
            event.sender.send('agent:tool-result', toolResult)
            const raw = toolResult.rawResult
            if (toolResult.name === 'query_wiki' && raw?.success && raw?.results) {
              event.sender.send('llm:wiki-results', raw.results)
            }
            if (toolResult.name === 'query_rag' && raw?.success && raw?.results) {
              event.sender.send('llm:rag-results', raw.results)
            }
          },
          onDone: () => {
            event.sender.send('llm:chat-done')
          },
          onError: (error: string) => {
            event.sender.send('llm:chat-error', error)
          },
        }
      )
      return { success: true }
    } catch (error: any) {
      event.sender.send('llm:chat-error', error.message || String(error))
      return { success: false, error: error.message || String(error) }
    }
  })

  ipcMain.handle(IPC_CHANNELS.LLM_CHAT_STREAM_WITH_RAG, async (event, params: LLMChatStreamWithRAGParams) => {
    try {
      const lastMessage = params.messages[params.messages.length - 1]
      const query = lastMessage?.content || ''

      const searchResults = await ragService.search(
        params.project_id,
        query,
        params.rag_options?.top_k || 5,
        params.rag_options?.min_score || 0.5
      )

      event.sender.send('llm:rag-results', searchResults)

      const ragContext = searchResults.length > 0
        ? '\n\n【参考知识】\n' + searchResults.map((r, i) => `${i + 1}. [${r.source.file_name}] ${r.text}`).join('\n')
        : ''

      const systemMessage = params.messages.find(m => m.role === 'system')
      const otherMessages = params.messages.filter(m => m.role !== 'system')

      const enhancedMessages: Array<{ role: string; content: string }> = []

      if (systemMessage) {
        enhancedMessages.push({
          role: 'system',
          content: systemMessage.content + ragContext,
        })
      } else if (ragContext) {
        enhancedMessages.push({
          role: 'system',
          content: '你是专业的数字员工助手。请基于以下参考知识回答用户问题。' + ragContext,
        })
      }

      enhancedMessages.push(...otherMessages)

      await llmClient.chatStream(
        params.provider_id,
        enhancedMessages,
        (chunk: string) => {
          event.sender.send('llm:chat-chunk', chunk)
        },
        () => {
          event.sender.send('llm:chat-done')
        },
        (error: Error) => {
          event.sender.send('llm:chat-error', error.message)
        },
        params.model_id ? { ...params.options, model: params.model_id } : params.options,
        undefined,
        (thoughtChunk: string) => {
          event.sender.send('llm:thought', thoughtChunk)
        },
      )
      return { success: true }
    } catch (error: any) {
      event.sender.send('llm:chat-error', error.message)
      return { success: false, error: error.message }
    }
  })

  ipcMain.handle(IPC_CHANNELS.SETTINGS_GET, (_, params: SettingsGetParams) => {
    const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(params.key) as any
    return row?.value || null
  })

  ipcMain.handle(IPC_CHANNELS.SETTINGS_SET, (_, params: SettingsSetParams) => {
    db.prepare(
      'INSERT INTO settings (key, value, updated_at) VALUES (?, ?, unixepoch()) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at'
    ).run(params.key, params.value)
    return { success: true }
  })

  ipcMain.handle(IPC_CHANNELS.SETTINGS_KEY_GET, (_, params: SettingsGetParams) => {
    const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(params.key) as any
    return row?.value || null
  })

  ipcMain.handle(IPC_CHANNELS.SETTINGS_KEY_SET, (_, params: SettingsSetParams) => {
    db.prepare(
      'INSERT INTO settings (key, value, updated_at) VALUES (?, ?, unixepoch()) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at'
    ).run(params.key, params.value)
    return { success: true }
  })

  ipcMain.handle(IPC_CHANNELS.RAG_INDEX_PROJECT, async (_, params: { project_id: string }) => {
    const result = await ragService.indexProjectFiles(params.project_id)
    return result
  })

  ipcMain.handle(IPC_CHANNELS.RAG_SEARCH, async (_, params: { project_id: string; query: string; top_k?: number }) => {
    const results = await ragService.search(params.project_id, params.query, params.top_k || 5)
    return results
  })

  ipcMain.handle(IPC_CHANNELS.RAG_INDEX_STATUS, async (_, params: { project_id: string }) => {
    const status = await ragService.getIndexStatus(params.project_id)
    return status
  })

  ipcMain.handle(IPC_CHANNELS.RAG_DELETE_INDEX, async (_, params: { project_id: string }) => {
    const result = await ragService.deleteIndex(params.project_id)
    return { success: result }
  })

  ipcMain.handle(IPC_CHANNELS.OCR_RECOGNIZE, async (_, params: { image_path: string; language?: string }) => {
    try {
      const result = await ocrService.recognize(params.image_path, { language: params.language })
      return { success: true, result }
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      }
    }
  })

  ipcMain.handle(IPC_CHANNELS.OCR_STATUS, () => {
    return {
      rapidocr_available: ocrService.isRapidOCRAvailable(),
      tesseract_available: true,
    }
  })

  ipcMain.handle(IPC_CHANNELS.RULE_EXTRACT_FILE, async (_, params: { file_id: string; provider_id?: string; model_id?: string }) => {
    try {
      const result = await ruleExtractor.extractFromFile(params.file_id, params.provider_id, params.model_id)
      return { success: true, result }
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      }
    }
  })

  ipcMain.handle(IPC_CHANNELS.RULE_EXTRACT_PROJECT, async (_, params: { project_id: string; provider_id?: string; model_id?: string }) => {
    try {
      const result = await ruleExtractor.extractFromProject(params.project_id, params.provider_id, params.model_id)
      return { success: true, result }
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      }
    }
  })

  ipcMain.handle(IPC_CHANNELS.SANDBOX_TEST_SKILL, async (_, params: { skill_id: string; provider_id?: string; model_id?: string }) => {
    try {
      const report = await sandboxTester.runSkillTests(params.skill_id, params.provider_id, params.model_id)
      return { success: true, report }
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      }
    }
  })

  ipcMain.handle(IPC_CHANNELS.SANDBOX_TEST_EMPLOYEE, async (_, params: { employee_id: string; provider_id?: string; model_id?: string }) => {
    try {
      const report = await sandboxTester.runEmployeeTests(params.employee_id, params.provider_id, params.model_id)
      return { success: true, report }
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      }
    }
  })

  ipcMain.handle(IPC_CHANNELS.SANDBOX_GENERATE_CASES, (_, params: { skill_id: string }) => {
    try {
      const cases = sandboxTester.generateTestCasesFromRules(params.skill_id)
      return { success: true, cases }
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      }
    }
  })

  ipcMain.handle(IPC_CHANNELS.EMPLOYEE_PROFILE_ANALYZE, async (event, params: EmployeeProfileAnalyzeParams) => {
    try {
      const result = await profilingService.analyzeProjectForEmployee(
        params.project_id,
        params.file_ids,
        params.provider_id,
        params.model_id,
        params.additional_context,
        (data) => {
          event.sender.send(IPC_CHANNELS.EMPLOYEE_PROFILE_PROGRESS, data)
        }
      )
      return { success: true, profile: result.profile, analysisMethod: result.analysisMethod, error: result.error }
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      }
    }
  })

  ipcMain.handle(IPC_CHANNELS.TOOL_LIST_BUILTIN, () => {
    return toolEngine.getBuiltinTools().map((t) => ({
      id: t.id,
      name: t.name,
      description: t.description,
      parameters: t.parameters,
      source: t.source,
    }))
  })

  ipcMain.handle(IPC_CHANNELS.TOOL_EXECUTE, async (_, params: ToolExecuteParams) => {
    return toolEngine.executeTool(params.tool_id, params.args)
  })

  ipcMain.handle(IPC_CHANNELS.TOOL_GET_EMPLOYEE_TOOLS, (_, params: { employee_id: string }) => {
    const employeeTools = db.prepare(
      'SELECT et.*, t.name, t.description, t.type FROM employee_tools et LEFT JOIN tools t ON et.tool_id = t.id WHERE et.employee_id = ?'
    ).all(params.employee_id) as any[]

    const builtinTools = toolEngine.getBuiltinTools()
    const assignedToolIds = employeeTools.map((et) => et.tool_id)

    const assigned = employeeTools.map((et) => {
      const builtin = builtinTools.find((t) => t.id === et.tool_id)
      return {
        ...et,
        name: et.name || builtin?.name || et.tool_id,
        description: et.description || builtin?.description || '',
        source: et.source || builtin?.source || 'builtin',
      }
    })

    return {
      assigned,
      available: builtinTools.filter((t) => !assignedToolIds.includes(t.id)).map((t) => ({
        id: t.id,
        name: t.name,
        description: t.description,
        source: t.source,
      })),
    }
  })

  ipcMain.handle(IPC_CHANNELS.TOOL_ASSIGN_TO_EMPLOYEE, (_, params: ToolAssignParams) => {
    const id = require('crypto').randomUUID()
    db.prepare(
      'INSERT INTO employee_tools (id, employee_id, tool_id, is_enabled) VALUES (?, ?, ?, ?) ON CONFLICT DO NOTHING'
    ).run(id, params.employee_id, params.tool_id, params.is_enabled !== false ? 1 : 0)
    return { success: true }
  })

  ipcMain.handle(IPC_CHANNELS.TOOL_REMOVE_FROM_EMPLOYEE, (_, params: { employee_id: string; tool_id: string }) => {
    db.prepare('DELETE FROM employee_tools WHERE employee_id = ? AND tool_id = ?').run(params.employee_id, params.tool_id)
    return { success: true }
  })

  ipcMain.handle(IPC_CHANNELS.MCP_SERVER_LIST, () => {
    return db.prepare('SELECT * FROM mcp_servers ORDER BY created_at DESC').all()
  })

  ipcMain.handle(IPC_CHANNELS.MCP_SERVER_CREATE, (_, params: MCPServerCreateParams) => {
    const id = require('crypto').randomUUID()
    const now = Math.floor(Date.now() / 1000)
    db.prepare(
      'INSERT INTO mcp_servers (id, name, command, args_json, env_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
    ).run(
      id,
      params.name,
      params.command,
      JSON.stringify(params.args || []),
      JSON.stringify(params.env || {}),
      now,
      now
    )
    return db.prepare('SELECT * FROM mcp_servers WHERE id = ?').get(id)
  })

  ipcMain.handle(IPC_CHANNELS.MCP_SERVER_UPDATE, (_, params: MCPServerUpdateParams) => {
    const { id, ...data } = params
    const updates: string[] = []
    const values: any[] = []

    if (data.name !== undefined) { updates.push('name = ?'); values.push(data.name) }
    if (data.command !== undefined) { updates.push('command = ?'); values.push(data.command) }
    if (data.args !== undefined) { updates.push('args_json = ?'); values.push(JSON.stringify(data.args)) }
    if (data.env !== undefined) { updates.push('env_json = ?'); values.push(JSON.stringify(data.env)) }
    if (data.is_enabled !== undefined) { updates.push('is_enabled = ?'); values.push(data.is_enabled ? 1 : 0) }

    if (updates.length > 0) {
      updates.push('updated_at = unixepoch()')
      values.push(id)
      db.prepare(`UPDATE mcp_servers SET ${updates.join(', ')} WHERE id = ?`).run(...values)
    }

    return db.prepare('SELECT * FROM mcp_servers WHERE id = ?').get(id)
  })

  ipcMain.handle(IPC_CHANNELS.MCP_SERVER_DELETE, (_, id: string) => {
    const result = db.prepare('DELETE FROM mcp_servers WHERE id = ?').run(id)
    return { success: result.changes > 0 }
  })

  ipcMain.handle(IPC_CHANNELS.MCP_SERVER_CONNECT, async (_, id: string) => {
    const server = db.prepare('SELECT * FROM mcp_servers WHERE id = ?').get(id) as any
    if (!server) return { success: false, error: 'Server not found' }

    const result = await toolEngine.connectMCPServer({
      id: server.id,
      name: server.name,
      command: server.command,
      args: JSON.parse(server.args_json || '[]'),
      env: JSON.parse(server.env_json || '{}'),
      enabled: server.is_enabled === 1,
    })

    if (result.success) {
      db.prepare("UPDATE mcp_servers SET status = 'connected', last_error = NULL, updated_at = unixepoch() WHERE id = ?").run(id)
    } else {
      db.prepare("UPDATE mcp_servers SET status = 'error', last_error = ?, updated_at = unixepoch() WHERE id = ?").run(result.error || 'Unknown error', id)
    }

    return result
  })

  ipcMain.handle(IPC_CHANNELS.MCP_SERVER_DISCONNECT, async (_, id: string) => {
    await toolEngine.disconnectMCPServer(id)
    db.prepare("UPDATE mcp_servers SET status = 'disconnected', updated_at = unixepoch() WHERE id = ?").run(id)
    return { success: true }
  })

  ipcMain.handle(IPC_CHANNELS.SKILL_REGISTRY_LIST, () => {
    return skillRegistry.getInstalledSkills()
  })

  ipcMain.handle(IPC_CHANNELS.SKILL_REGISTRY_GET, (_, id: string) => {
    return skillRegistry.getSkillById(id)
  })

  ipcMain.handle(IPC_CHANNELS.SKILL_REGISTRY_INSTALL, async (_, params: { source: 'directory' | 'zip'; path: string }) => {
    try {
      if (params.source === 'directory') {
        return await skillRegistry.installFromDirectory(params.path)
      } else {
        return await skillRegistry.installFromZip(params.path)
      }
    } catch (error: any) {
      return { success: false, error: error.message }
    }
  })

  ipcMain.handle(IPC_CHANNELS.SKILL_REGISTRY_UNINSTALL, async (_, id: string) => {
    const result = await skillRegistry.uninstallSkill(id)
    return { success: result }
  })

  ipcMain.handle(IPC_CHANNELS.SKILL_REGISTRY_TOGGLE, (_, params: { id: string; enabled: boolean }) => {
    skillRegistry.toggleSkill(params.id, params.enabled)
    return { success: true }
  })

  ipcMain.handle(IPC_CHANNELS.SKILL_REGISTRY_GET_EMPLOYEE_SKILLS, (_, params: { employee_id: string }) => {
    return skillRegistry.getEmployeeSkills(params.employee_id)
  })

  ipcMain.handle(IPC_CHANNELS.SKILL_REGISTRY_ASSIGN_TO_EMPLOYEE, (_, params: { employee_id: string; skill_id: string }) => {
    skillRegistry.assignSkillToEmployee(params.skill_id, params.employee_id)
    return { success: true }
  })

  ipcMain.handle(IPC_CHANNELS.SKILL_REGISTRY_REMOVE_FROM_EMPLOYEE, (_, params: { employee_id: string; skill_id: string }) => {
    skillRegistry.removeSkillFromEmployee(params.skill_id, params.employee_id)
    return { success: true }
  })

  ipcMain.handle(IPC_CHANNELS.WIKI_INITIALIZE, async (_, params: { project_id: string }) => {
    return await wikiService.initializeWiki(params.project_id)
  })

  ipcMain.handle(IPC_CHANNELS.WIKI_COMPILE, async (event, params: { project_id: string; provider_id?: string; model_id?: string; force?: boolean }) => {
    return await wikiService.compileWiki(
      params.project_id,
      params.provider_id,
      params.model_id,
      (stage: string, detail: string) => {
        event.sender.send('wiki:compile-progress', { stage, detail })
      },
      (chunk: string) => {
        event.sender.send('wiki:compile-llm-chunk', chunk)
      },
      (thought: string) => {
        event.sender.send('wiki:compile-thought', thought)
      },
      params.force || false
    )
  })

  ipcMain.handle(IPC_CHANNELS.WIKI_SEARCH, async (_, params: { project_id: string; query: string; top_k?: number }) => {
    return await wikiService.searchWiki(params.project_id, params.query, params.top_k || 5)
  })

  ipcMain.handle(IPC_CHANNELS.WIKI_GET_STATUS, async (_, params: { project_id: string }) => {
    return wikiService.getWikiStatus(params.project_id)
  })

  ipcMain.handle(IPC_CHANNELS.WIKI_GET_PAGES, async (_, params: { project_id: string }) => {
    return wikiService.getWikiPageList(params.project_id)
  })

  ipcMain.handle(IPC_CHANNELS.WIKI_GET_PAGE, async (_, params: { project_id: string; page_path: string }) => {
    return wikiService.getWikiPage(params.project_id, params.page_path)
  })

  ipcMain.handle(IPC_CHANNELS.WIKI_GET_RAW_FILES, async (_, params: { project_id: string }) => {
    return wikiService.getRawFiles(params.project_id)
  })

  ipcMain.handle(IPC_CHANNELS.WIKI_INGEST_SOURCE, async (event, params: WikiIngestParams) => {
    const result = await wikiService.ingestSource(
      params.project_id,
      params.raw_file_path,
      params.provider_id,
      params.model_id,
      (stage: string, detail: string) => {
        event.sender.send('wiki:ingest-progress', { stage, detail })
      },
      (chunk: string) => {
        event.sender.send('wiki:ingest-llm-chunk', chunk)
      },
      (thought: string) => {
        event.sender.send('wiki:ingest-thought', thought)
      }
    )
    return result
  })

  ipcMain.handle(IPC_CHANNELS.WIKI_QUERY, async (event, params: WikiQueryParams) => {
    const result = await wikiService.queryWiki(
      params.project_id,
      params.query,
      params.provider_id,
      params.model_id,
      (stage: string, detail: string) => {
        event.sender.send('wiki:query-progress', { stage, detail })
      }
    )
    return result
  })

  ipcMain.handle(IPC_CHANNELS.WIKI_LINT, async (_, params: { project_id: string }) => {
    return await wikiService.lintWiki(params.project_id)
  })

  ipcMain.handle(IPC_CHANNELS.WIKI_AUDIT, async (_, params: { project_id: string }) => {
    return await wikiService.auditWiki(params.project_id)
  })

  ipcMain.handle(IPC_CHANNELS.WIKI_CHAT_WITH_WIKI, async (event, params: {
    provider_id: string
    model_id?: string
    project_id: string
    messages: Array<{ role: string; content: string }>
    options?: { temperature?: number; max_tokens?: number; stream?: boolean }
    use_wiki?: boolean
    use_rag?: boolean
  }) => {
    try {
      const lastMessage = params.messages[params.messages.length - 1]
      const query = lastMessage?.content || ''
      let enhancedContext = ''
      const wikiResults: any[] = []
      const ragResults: any[] = []

      if (params.use_wiki !== false) {
        const results = await wikiService.searchWiki(params.project_id, query, 5)
        if (results.length > 0) {
          wikiResults.push(...results)
          enhancedContext += '\n\n【Wiki 知识库参考】\n\n'
          for (const r of results) {
            enhancedContext += `# ${r.page.title}\n${r.page.content.substring(0, 1500)}\n\n`
          }
        }
      }

      if (params.use_rag) {
        const results = await ragService.search(params.project_id, query, 5, 0.5)
        if (results.length > 0) {
          ragResults.push(...results)
          enhancedContext += '\n\n【RAG 向量检索参考】\n\n'
          for (const r of results) {
            enhancedContext += `[${r.source.file_name}] ${r.text}\n\n`
          }
        }
      }

      event.sender.send('llm:wiki-results', wikiResults)
      if (params.use_rag) {
        event.sender.send('llm:rag-results', ragResults)
      }

      const systemMessage = params.messages.find(m => m.role === 'system')
      const otherMessages = params.messages.filter(m => m.role !== 'system')

      const enhancedMessages: Array<{ role: string; content: string }> = []

      if (systemMessage) {
        enhancedMessages.push({
          role: 'system',
          content: systemMessage.content + enhancedContext,
        })
      } else if (enhancedContext) {
        enhancedMessages.push({
          role: 'system',
          content: '你是专业的数字员工助手。请基于以下参考知识回答用户问题。' + enhancedContext,
        })
      }

      enhancedMessages.push(...otherMessages)

      await llmClient.chatStream(
        params.provider_id,
        enhancedMessages,
        (chunk: string) => {
          event.sender.send('llm:chat-chunk', chunk)
        },
        () => {
          event.sender.send('llm:chat-done')
        },
        (error: Error) => {
          event.sender.send('llm:chat-error', error.message)
        },
        params.model_id ? { ...params.options, model: params.model_id } : params.options,
        undefined,
        (thoughtChunk: string) => {
          event.sender.send('llm:thought', thoughtChunk)
        },
      )
      return { success: true }
    } catch (error: any) {
      event.sender.send('llm:chat-error', error.message)
      return { success: false, error: error.message }
    }
  })
}
