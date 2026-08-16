import os from 'os'
import DatabaseService from './database.service'
import LLMClientService from './llm-client.service'
import SkillRegistryService from './skill-registry.service'
import EmployeeMemoryService from './employee-memory.service'
import McpRegistryService from './mcp-registry.service'
import NotesService from './notes/notes.service'
import WorkspaceManagerService from './workspace-manager.service'
import { EmployeeAgent } from './agent/business/employee-agent'
import type { EmployeeAgentConfig } from './agent/business/employee-agent'
import type { BaseAgentOptions } from './agent/core/base-agent'
import { allBuiltinTools, createKMSCollectionTools, javascriptExecTool, createKMSTools, createListAvailableToolsTool, createInvokeToolTool, runSkillScriptTool, type SearchScopeRef } from './agent/tools'
import { createConversationSearchTool } from './agent/tools/conversation-search.tool'
import { createConversationListTool } from './agent/tools/conversation-list.tool'
import type { Message } from './agent/core/types'
import type { LLMModelConfig, ThinkingLevel } from '../../shared/types'
import type { DBEmployee, DBEmployeeTool } from '../../shared/db-types'
import type { ToolMode } from '../../shared/channels/tool'
import type { ToolDefinition } from './agent/tools/types'
import { createLogger } from './logger'
import LLMLoggerService from './llm-logger.service'

const logger = createLogger('AgentEvent')

interface EmployeeChatStreamParams {
  employee_id: string
  provider_id: string
  model_id?: string
  messages: Array<{
    role: string
    content: string
    images?: string[]
    reasoning_content?: string
    toolCalls?: Array<{
      id: string
      name: string
      args: any
      result?: any
      isComplete?: boolean
    }>
    toolCallId?: string
  }>
  options?: {
    temperature?: number
    max_tokens?: number
  }
  use_skills?: boolean
  collection_ids?: string[]
  enable_thinking?: ThinkingLevel
  conversation_id?: string
  minimal_mode?: boolean
  high_permission?: boolean
}

interface EmployeeChatCallbacks {
  onChunk: (chunk: string) => void
  onThought: (thought: string) => void
  onToolCall: (toolCall: { id: string; name: string; args: any }) => void
  onToolCallDelta?: (delta: { index: number; id?: string; name?: string; arguments: string }) => void
  onToolResult: (toolResult: { name: string; result: any; rawResult?: any; generatedFiles?: any; success?: boolean }) => void
  onToolProgress?: (progress: { toolCallId: string; name: string; progress: any }) => void
  onDone: (metadata?: any) => void
  onError: (error: string) => void
}

interface CachedAgentEntry {
  agent: EmployeeAgent
  conversationId: string | null
  collectionIdsRef: SearchScopeRef
  /** 该 agent 持有的 MCP client 引用释放函数，agent 缓存被清除时调用 */
  mcpRelease?: () => Promise<void>
}

class EmployeeAgentService {
  private db: DatabaseService
  private llmClient: LLMClientService
  private skillRegistry: SkillRegistryService
  private memoryService: EmployeeMemoryService
  private mcpRegistry: McpRegistryService
  private agentEntries: Map<string, CachedAgentEntry> = new Map()
  private static instance: EmployeeAgentService

  private constructor() {
    this.db = DatabaseService.getInstance()
    this.llmClient = LLMClientService.getInstance()
    this.skillRegistry = SkillRegistryService.getInstance()
    this.memoryService = EmployeeMemoryService.getInstance()
    this.mcpRegistry = McpRegistryService.getInstance()
  }

  static getInstance(): EmployeeAgentService {
    if (!EmployeeAgentService.instance) {
      EmployeeAgentService.instance = new EmployeeAgentService()
    }
    return EmployeeAgentService.instance
  }

  private async getOrCreateAgent(
    employeeId: string,
    providerId: string,
    modelId?: string,
    enableThinking?: ThinkingLevel,
    conversationId?: string,
    employee?: DBEmployee
  ): Promise<CachedAgentEntry> {
    const cacheKey = `${employeeId}:${providerId}:${modelId || 'default'}:${enableThinking || 'no-thinking'}`

    const existing = this.agentEntries.get(cacheKey)
    if (existing) {
      if (conversationId && existing.conversationId !== conversationId) {
        // 切换对话时清除旧缓存：先释放 MCP client 引用，再删除条目
        if (existing.mcpRelease) {
          existing.mcpRelease().catch(() => { /* ignore */ })
        }
        this.agentEntries.delete(cacheKey)
      } else {
        return existing
      }
    }

    const emp = employee ?? this.db.getDb().prepare('SELECT * FROM employees WHERE id = ?').get(employeeId) as DBEmployee | undefined
    if (!emp) {
      throw new Error(`Employee ${employeeId} not found`)
    }

    const config = await this.llmClient.getProviderConfig(providerId)
    if (!config) {
      throw new Error(`Provider ${providerId} not found`)
    }

    let instructions = '你是专业数字员工，基于资料库和工具为用户提供服务。'
    let role: string | undefined
    if (emp.profile_json) {
      try {
        const profile = JSON.parse(emp.profile_json)
        if (profile.roleName) {
          role = profile.roleName
        }
        // 旧数据兼容：无 rules 时回退到画像中的 roleDescription
        if (!emp.rules?.trim() && profile.roleDescription) {
          instructions = profile.roleDescription
        }
      } catch (error) {
        logger.warn('Failed to parse employee profile_json, using default instructions', error)
      }
    }
    if (emp.rules?.trim()) {
      // 规则（系统提示词）：唯一权威来源
      instructions = emp.rules
    } else if (!emp.profile_json && emp.description) {
      // 兼容未迁移的旧数据（description 曾兼作系统提示词）
      instructions = emp.description
    }

    const employeeSkills = this.skillRegistry.getEmployeeSkills(employeeId)

    const enabledSkillPaths = employeeSkills.enabled.map(skill => skill.installPath)

    const modelConfig = this.getModelConfig(config, modelId)

    const resolvedModelName = modelConfig?.model || modelId || config.model

    const memoryEnabled = emp.memory_enabled === 1
    const memoryPrompt = memoryEnabled
      ? (this.memoryService.formatMemoriesForPrompt(
          this.memoryService.listMemories(employeeId)
        ) || undefined)
      : undefined

    const agentConfig: EmployeeAgentConfig = {
      employeeId: emp.id,
      name: emp.name,
      instructions,
      role,
      model: resolvedModelName,
      apiKey: config.api_key,
      baseUrl: config.base_url || this.llmClient.getBaseURL(config),
      providerType: config.provider_type,
      enableThinking: enableThinking ?? modelConfig?.enable_thinking ?? false,
      sessionId: conversationId,
      allowedSkillPaths: enabledSkillPaths,
      autoDiscoverSkills: true,
      debug: modelConfig?.debug ?? false,
      workspaceGuidance: (() => {
        // 稳定不变的环境信息（系统环境/笔记库）保留在 system prompt；
        // 任务工作区信息随任务变化，改由动态上下文 <workspace> 注入（见 buildWorkspaceContextPrompt）
        const platformMap: Record<string, string> = { win32: 'Windows', darwin: 'macOS', linux: 'Linux' }
        const osName = platformMap[process.platform] || process.platform
        const osRelease = os.release()
        const osArch = os.arch()
        const parts: string[] = []
        parts.push(`系统环境：${osName} ${osRelease}（${osArch}）`)
        const notesRoot = NotesService.getInstance().getVaultRoot()
        parts.push(`笔记库：${notesRoot}（.md 格式；只读默认，增删改需用户确认）`)
        return parts.join('\n')
      })(),
    }

    const agentOptions: BaseAgentOptions = {
      memoryConfig: {
        maxTokens: modelConfig?.context_window ?? (modelConfig?.max_tokens ? modelConfig.max_tokens * 4 : 128000),
        strategy: modelConfig?.memory_strategy ?? 'sliding_window_with_summary',
        recentTurnsToKeep: modelConfig?.recent_turns_to_keep ?? 10,
      },
      toolTimeoutMs: modelConfig?.tool_timeout_ms ?? 30000,
      toolMaxRetries: modelConfig?.tool_max_retries ?? 2,
      toolMaxResultSize: modelConfig?.tool_max_result_size ?? 50000,
      onEvent: (event, data) => {
        logger.info(`${event}`, data)
      },
    }

    const agent = new EmployeeAgent(agentConfig, agentOptions)

    // skill 激活统一通过 activate_skill 工具（渐进披露第 2 层），
    // 不再为每个 skill 注册 skill_<name> 工具，避免工具表膨胀。
    // 斜杠菜单 /<skill-name> 由前端转换为 activate_skill 调用指令。
    const toolModes = this.getEmployeeToolModes(employeeId)
    agent.registerTools(this.applyToolModes(allBuiltinTools, toolModes))

    const collectionIdsRef: SearchScopeRef = { current: { collectionIds: [] } }
    agent.registerTools(this.applyToolModes(createKMSTools(collectionIdsRef), toolModes))
    agent.registerTools(this.applyToolModes(createKMSCollectionTools(collectionIdsRef), toolModes))

    if (toolModes.get('javascript_exec') !== 'off') {
      agent.registerTools([{ ...javascriptExecTool, onDemand: toolModes.get('javascript_exec') === 'on_demand' }])
    }

    // run_skill_script 工具：受全局开关 skills_enable_script_execution 控制（默认禁用）
    const scriptExecRow = this.db.getDb().prepare("SELECT value FROM settings WHERE key = 'skills_enable_script_execution'").get() as { value: string } | undefined
    if (scriptExecRow?.value === '1' || scriptExecRow?.value === 'true') {
      agent.registerTools([runSkillScriptTool])
    }

    if (toolModes.get('search_conversations') !== 'off') {
      agent.registerTools(this.applyToolModes(createConversationSearchTool(employeeId), toolModes))
    }

    if (toolModes.get('list_conversations') !== 'off' || toolModes.get('get_conversation_detail') !== 'off') {
      agent.registerTools(this.applyToolModes(createConversationListTool(employeeId), toolModes))
    }

    // 注入员工已启用的外部 MCP server 工具（标记为按需工具）
    // 失败容忍：单个 server 失败不影响 agent 创建，仅记录日志
    let mcpRelease: (() => Promise<void>) | undefined
    try {
      const mcpResult = await this.mcpRegistry.buildAgentTools(employeeId)
      if (mcpResult.tools.length > 0) {
        const mcpOnDemandTools = mcpResult.tools.map(t => ({ ...t, onDemand: true }))
        agent.registerTools(mcpOnDemandTools)
        mcpRelease = mcpResult.release
        logger.info(`Injected ${mcpOnDemandTools.length} MCP tools for employee ${employeeId}`)
      }
    } catch (err: any) {
      logger.warn(`Failed to inject MCP tools for employee ${employeeId}: ${err?.message || err}`)
    }

    // 注册元工具（常驻 LLM tools 数组）：list_available_tools + invoke_tool
    agent.registerTools([
      createListAvailableToolsTool(agent.getToolRegistry(), emp.workspace_path || ''),
      createInvokeToolTool(agent.getToolDispatcher(), agent.getToolRegistry()),
    ])

    if (memoryPrompt) {
      agent.updateMemoryPrompt(memoryPrompt)
    }

    // 注入任务工作区上下文（随会话稳定，不走 system prompt → 保持 KV cache 前缀稳定）
    agent.updateWorkspaceContextPrompt(this.buildWorkspaceContextPrompt(emp, conversationId))

    this.agentEntries.set(cacheKey, {
      agent,
      conversationId: conversationId || null,
      collectionIdsRef,
      mcpRelease,
    })
    return { agent, conversationId: conversationId || null, collectionIdsRef }
  }

  /**
   * 工具三态（on/on_demand/off）映射：
   * - 无配置行 → 按工具定义默认模式（onDemand 标志：常驻=on，否则 on_demand）
   * - 有配置行 → 使用 tool_mode 列值（旧数据 tool_mode 缺失时回退默认）
   */
  private getEmployeeToolModes(employeeId: string): Map<string, ToolMode> {
    const modeMap = new Map<string, ToolMode>()
    for (const t of allBuiltinTools) {
      modeMap.set(t.id, t.onDemand ? 'on_demand' : 'on')
    }
    // KMS / 脚本 / 对话记忆工具（工厂函数创建，均按需）
    const extraOnDemandIds = [
      'kms_search', 'kms_get_content', 'kms_list_collections',
      'javascript_exec',
      'search_conversations', 'list_conversations', 'get_conversation_detail',
    ]
    for (const id of extraOnDemandIds) {
      modeMap.set(id, 'on_demand')
    }

    // 协作工具（delegate_to_employee）默认关闭，需在员工设置中手动启用
    modeMap.set('delegate_to_employee', 'off')

    let rows = this.db.getDb().prepare(
      'SELECT tool_id, tool_mode FROM employee_tools WHERE employee_id = ?'
    ).all(employeeId) as DBEmployeeTool[]

    rows = rows.map(row => ({ ...row, tool_id: row.tool_id === 'office_exec' ? 'javascript_exec' : row.tool_id }))

    for (const row of rows) {
      if (modeMap.has(row.tool_id) && (row.tool_mode === 'on' || row.tool_mode === 'on_demand' || row.tool_mode === 'off')) {
        modeMap.set(row.tool_id, row.tool_mode)
      }
    }
    return modeMap
  }

  /** 按员工工具模式过滤并应用 onDemand 标志（off 移除，on_demand 标记按需，on 常驻） */
  private applyToolModes(tools: ToolDefinition[], modeMap: Map<string, ToolMode>): ToolDefinition[] {
    return tools
      .filter(t => modeMap.get(t.id) !== 'off')
      .map(t => ({ ...t, onDemand: modeMap.get(t.id) === 'on_demand' }))
  }

  /** 构建任务工作区上下文（随会话稳定，注入 <workspace> 上下文块） */
  private buildWorkspaceContextPrompt(emp: DBEmployee, conversationId?: string): string | undefined {
    const taskWorkspace = conversationId
      ? WorkspaceManagerService.getInstance().getConversationWorkspacePath(conversationId)
      : ''
    const lines: string[] = []
    if (taskWorkspace) {
      lines.push(`当前任务工作区：${taskWorkspace}（读写授权，增删改直接执行）`)
      if (emp.workspace_path) {
        lines.push(`数字员工工作区：${emp.workspace_path}（只读默认，增删改需用户确认，仅用于查看其他任务）`)
      }
    } else if (emp.workspace_path) {
      // 旧对话无任务目录：回退到员工工作区为读写授权，保持兼容
      lines.push(`工作区：${emp.workspace_path}（读写授权，增删改直接执行）`)
    }
    return lines.length > 0 ? lines.join('\n') : undefined
  }

  private getModelConfig(config: any, modelId?: string): LLMModelConfig & Record<string, any> | null {
    if (!config?.models_json) return null
    try {
      const models: Array<LLMModelConfig & Record<string, any>> = JSON.parse(config.models_json)
      const matched = modelId
        ? models.find(m => m.id === modelId) || models.find(m => m.model === modelId)
        : models.find(m => m.is_default)
      return matched ?? null
    } catch {
      return null
    }
  }

  async chatStream(params: EmployeeChatStreamParams, callbacks: EmployeeChatCallbacks, signal?: AbortSignal): Promise<void> {
    const { employee_id, provider_id, model_id, messages, use_skills = true, collection_ids = [], enable_thinking, conversation_id, minimal_mode = false, high_permission = false } = params

    const employee = this.db.getDb().prepare('SELECT * FROM employees WHERE id = ?').get(employee_id) as DBEmployee | undefined
    const employeeName = employee?.name || 'unknown'

    logger.info(`Chat stream started: employee="${employeeName}"(${employee_id}), conversation=${conversation_id || 'none'}, msgs=${messages.length}, skills=${use_skills}, thinking=${enable_thinking ?? 'auto'}, minimal=${minimal_mode}, highPerm=${high_permission}`)

    const logCtx = {
      employeeId: employee_id,
      employeeName,
      conversationId: conversation_id,
      source: 'chat',
    }

    await LLMLoggerService.getInstance().runWithContext(logCtx, async () => {
      const entry = await this.getOrCreateAgent(employee_id, provider_id, model_id, enable_thinking, conversation_id, employee)
      const agent = entry.agent
      agent.setMinimalMode(minimal_mode)
      entry.collectionIdsRef.current.collectionIds = collection_ids || []

      const history: Message[] = this.expandFrontendMessages(messages.slice(0, -1))
      const lastMsg = messages[messages.length - 1]
      const query = lastMsg?.content || ''
      const queryImages = lastMsg?.images

      const systemPromptCached = await this.prepareSystemPrompt(agent, conversation_id, collection_ids, minimal_mode)
      const maxIterations = await this.resolveMaxIterations(provider_id, model_id)

      await agent.runStream(
        {
          query,
          history,
          useSkills: use_skills,
          maxIterations,
          metadata: { queryImages },
        },
        {
          onChunk: callbacks.onChunk,
          onThought: callbacks.onThought,
          onToolCall: callbacks.onToolCall,
          onToolCallDelta: callbacks.onToolCallDelta,
          onToolResult: callbacks.onToolResult,
          onToolProgress: callbacks.onToolProgress,
          onDone: (metadata?: any) => {
            callbacks.onDone(metadata)
          },
          onError: callbacks.onError,
        },
        signal
      )

      this.persistSystemPrompt(conversation_id, agent, systemPromptCached)
    })
  }

  private async prepareSystemPrompt(
    agent: EmployeeAgent,
    conversationId: string | undefined,
    collectionIds: string[],
    minimalMode: boolean,
  ): Promise<boolean> {
    // 1) system prompt 稳定前缀优先从 conversations 缓存加载（字节级相同 → KV cache 命中）
    //    memory / 知识库范围不再嵌入 system prompt，改为 prepend 到用户 query（见 EmployeeAgent.patchOptionsWithDynamicContext）
    //    向后兼容：旧缓存中若含 "## 跨任务记忆" / "## 当前对话可使用的资料库合集" 等旧标记，
    //    视为 legacy prompt 格式，丢弃并强制按新格式重建，避免 memory/kb 与 <memory>/<knowledge_scope> 重复。
    let systemPromptCached = false
    if (conversationId) {
      const conv = this.db.getDb().prepare(
        `SELECT system_prompt FROM conversations WHERE id = ?`
      ).get(conversationId) as { system_prompt?: string } | undefined
      const cached = conv?.system_prompt
      if (cached) {
        const isLegacy = cached.includes('## 跨任务记忆')
          || cached.includes('## 当前对话可使用的资料库合集')
          || cached.includes('调用前务必先调用 list_available_tools 获取详细工具详细使用说明')
          || cached.includes('<skills>')
          || !cached.includes('report_generated_files')
        if (!isLegacy) {
          agent.setCachedSystemPrompt(cached)
          systemPromptCached = true
        }
      }
    }

    // 2) 知识库范围：独立于 system prompt，始终根据本轮 collectionIds 设置
    //    （它会在 EmployeeAgent.runStream/run 中作为 <knowledge_scope> 拼到 query 前缀，
    //     不影响 system prompt 的字节级稳定性）
    if (minimalMode || collectionIds.length === 0) {
      agent.updateKBContextPrompt(undefined)
    } else {
      const kmsService = require('./kms/kms.service').default.getInstance()
      const allCollections = kmsService.listCollections() as any[]
      const selected = allCollections.filter((c: any) => collectionIds.includes(c.id))
      if (selected.length > 0) {
        const names = selected.map((c: any) => c.name).join('、')
        agent.updateKBContextPrompt(`当前对话可使用的资料库合集: ${names}（检索默认限定在此范围内）`)
      } else {
        agent.updateKBContextPrompt(undefined)
      }
    }

    return systemPromptCached
  }

  private async resolveMaxIterations(providerId: string, modelId?: string): Promise<number> {
    const config = await this.llmClient.getProviderConfig(providerId)
    if (!config?.models_json) return 100
    try {
      const models: LLMModelConfig[] = JSON.parse(config.models_json)
      const matched = modelId
        ? models.find(m => m.id === modelId) || models.find(m => m.model === modelId)
        : models.find(m => m.is_default)
      if (matched?.max_retry !== undefined) {
        return matched.max_retry
      }
    } catch (err: any) {
      logger.warn(`Failed to parse models_json for max_iterations (provider=${providerId}):`, err?.message || err)
    }
    return 100
  }

  private persistSystemPrompt(
    conversationId: string | undefined,
    agent: EmployeeAgent,
    systemPromptCached: boolean
  ): void {
    if (!conversationId || systemPromptCached) return
    const cachedPrompt = agent.getCachedSystemPrompt()
    if (cachedPrompt) {
      this.db.getDb().prepare(
        `UPDATE conversations SET system_prompt = ? WHERE id = ?`
      ).run(cachedPrompt, conversationId)
    }
  }

  async compactConversation(params: {
    employee_id: string
    provider_id: string
    model_id?: string
    messages: EmployeeChatStreamParams['messages']
    conversation_id?: string
    collection_ids?: string[]
    enable_thinking?: ThinkingLevel
    minimal_mode?: boolean
  }): Promise<{ summary: string; stats: any }> {
    const { employee_id, provider_id, model_id, messages, conversation_id, collection_ids = [], enable_thinking, minimal_mode = false } = params

    const employee = this.db.getDb().prepare('SELECT * FROM employees WHERE id = ?').get(employee_id) as DBEmployee | undefined
    const employeeName = employee?.name || 'unknown'

    const logCtx = {
      employeeId: employee_id,
      employeeName,
      conversationId: conversation_id,
      source: 'compact',
    }

    return LLMLoggerService.getInstance().runWithContext(logCtx, async () => {
      const entry = await this.getOrCreateAgent(employee_id, provider_id, model_id, enable_thinking, conversation_id)
      const agent = entry.agent
      entry.collectionIdsRef.current.collectionIds = collection_ids

      const history = this.expandFrontendMessages(messages)

      await this.prepareSystemPrompt(agent, conversation_id, collection_ids, minimal_mode)

      const { summary, stats } = await agent.compactConversation(history)

      return { summary, stats }
    })
  }

  getContextStats(params: {
    employee_id: string
    provider_id: string
    model_id?: string
    enable_thinking?: ThinkingLevel
  }): any {
    const { employee_id, provider_id, model_id, enable_thinking } = params
    const cacheKey = `${employee_id}:${provider_id}:${model_id || 'default'}:${enable_thinking || 'no-thinking'}`
    const entry = this.agentEntries.get(cacheKey)
    if (!entry) return null
    return entry.agent.getContextStats()
  }

  clearAgentCache(employeeId?: string): void {
    if (employeeId) {
      for (const [key, entry] of this.agentEntries.entries()) {
        if (key.startsWith(`${employeeId}:`)) {
          // 释放该 agent 持有的 MCP client 引用，避免连接泄漏
          if (entry.mcpRelease) {
            entry.mcpRelease().catch(() => { /* ignore */ })
          }
          this.agentEntries.delete(key)
        }
      }
    } else {
      // 清空所有缓存：先释放全部 MCP 引用
      for (const entry of this.agentEntries.values()) {
        if (entry.mcpRelease) {
          entry.mcpRelease().catch(() => { /* ignore */ })
        }
      }
      this.agentEntries.clear()
    }
  }

  private expandFrontendMessages(
    messages: EmployeeChatStreamParams['messages']
  ): Message[] {
    const result: Message[] = []
    for (const m of messages) {
      if (m.role === 'assistant' && m.toolCalls && m.toolCalls.length > 0) {
        // 仅保留已执行完毕的 tool_call（isComplete !== false）；
        // 被中断的（isComplete=false，参数未输出完或未收到 onToolResult）会缺少 arguments
        // 或无对应 tool response，发给 LLM 会报错，需过滤掉
        const validToolCalls = m.toolCalls.filter(tc => tc.id && tc.name && tc.isComplete !== false)
        const assistantMsg: Message = {
          role: 'assistant',
          content: m.content,
          images: m.images,
          reasoning_content: m.reasoning_content,
          toolCalls: validToolCalls.length > 0
            ? validToolCalls.map(tc => ({
                id: tc.id,
                type: 'function' as const,
                function: {
                  name: tc.name,
                  arguments: typeof tc.args === 'string' ? tc.args : JSON.stringify(tc.args ?? {}),
                },
              }))
            : undefined,
        }
        result.push(assistantMsg)

        for (const tc of validToolCalls) {
          // 工具执行成功但无返回值时，result 可能为 undefined/null/空字符串；
          // OpenAI 协议要求 tool result content 非空，补一个占位文本
          const toolContent = tc.result === undefined || tc.result === null
            ? ''
            : (typeof tc.result === 'string' ? tc.result : JSON.stringify(tc.result))
          result.push({
            role: 'tool',
            toolCallId: tc.id,
            content: toolContent || '工具执行完成，无返回值',
          })
        }
      } else {
        result.push({
          role: m.role as Message['role'],
          content: m.content,
          images: m.images,
          reasoning_content: m.reasoning_content,
          toolCallId: m.toolCallId,
        })
      }
    }
    return result
  }

}

export default EmployeeAgentService
