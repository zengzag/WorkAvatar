import { ToolRegistry } from './tool-registry'
import { ToolDispatcher } from './tool-dispatcher'
import { SkillManager } from './skill-manager'
import { ToolDefinition, OpenAIToolDefinition } from './tool.types'
import { AgentConfig, Message, AgentRunOptions, AgentResponse, AgentRunStreamCallbacks } from './agent.types'

export class LightAgent {
  readonly version = '1.0.0'

  private config: AgentConfig
  private toolRegistry: ToolRegistry
  private toolDispatcher: ToolDispatcher
  private skillManager: SkillManager
  private chatParams: { messages: Message[] } = { messages: [] }
  private activeSkillInstructions: string[] = []
  
  constructor(config: AgentConfig) {
    this.config = {
      name: config.name || `LightAgent_${Math.random().toString(36).substring(2, 10)}`,
      instructions: config.instructions || 'You are a helpful assistant.',
      role: config.role,
      model: config.model,
      apiKey: config.apiKey || process.env.OPENAI_API_KEY,
      baseUrl: config.baseUrl || process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1',
      providerType: config.providerType,
      enableThinking: config.enableThinking,
      treeOfThought: config.treeOfThought || false,
      totModel: config.totModel,
      totApiKey: config.totApiKey,
      totBaseUrl: config.totBaseUrl,
      filterTools: config.filterTools !== false,
      selfLearning: config.selfLearning || false,
      skillsDirectories: config.skillsDirectories || ['skills'],
      allowedSkillPaths: config.allowedSkillPaths,
      autoDiscoverSkills: config.autoDiscoverSkills !== false,
      debug: config.debug || false,
      logLevel: config.logLevel || 'info'
    }

    this.toolRegistry = new ToolRegistry()
    this.toolDispatcher = new ToolDispatcher(this.toolRegistry)
    this.skillManager = new SkillManager(
      this.config.skillsDirectories,
      this.config.allowedSkillPaths,
      this.config.debug ? this.log.bind(this) : undefined
    )

    if (this.config.autoDiscoverSkills) {
      this.skillManager.discoverSkills()
    }
  }

  get name(): string {
    return this.config.name!
  }

  get instructions(): string {
    return this.config.instructions!
  }

  getHistory(): Message[] {
    return [...this.chatParams.messages]
  }

  getTools(): OpenAIToolDefinition[] {
    return this.toolRegistry.getOpenAISchemas()
  }

  registerTool(tool: ToolDefinition): boolean {
    return this.toolRegistry.registerTool(tool)
  }

  registerTools(tools: ToolDefinition[]): boolean {
    return this.toolRegistry.registerTools(tools)
  }

  createSkillTools(): ToolDefinition[] {
    const tools: ToolDefinition[] = []

    const activateSkill: ToolDefinition = {
      id: 'activate_skill',
      name: 'activate_skill',
      title: 'Activate Skill',
      description: 'Activate a skill by name to get its full instructions',
      parameters: {
        type: 'object',
        properties: {
          skill_name: {
            type: 'string',
            description: 'The name of the skill to activate'
          }
        },
        required: ['skill_name']
      },
      handler: (args: any) => {
        try {
          const instructions = this.skillManager.activateSkill(args.skill_name)
          return { success: true, instructions }
        } catch (error: any) {
          return { success: false, error: error.message }
        }
      },
      source: 'skill'
    }
    tools.push(activateSkill)

    const readReference: ToolDefinition = {
      id: 'read_reference',
      name: 'read_reference',
      title: 'Read Reference',
      description: 'Read a reference file from a skill',
      parameters: {
        type: 'object',
        properties: {
          skill_name: {
            type: 'string',
            description: 'The name of the skill'
          },
          reference_path: {
            type: 'string',
            description: 'The path to the reference file within the skill'
          }
        },
        required: ['skill_name', 'reference_path']
      },
      handler: (args: any) => {
        const content = this.skillManager.readReference(args.skill_name, args.reference_path)
        return { content }
      },
      source: 'skill'
    }
    tools.push(readReference)

    return tools
  }

  async run(options: AgentRunOptions): Promise<AgentResponse> {
    const {
      query,
      tools: runtimeTools,
      stream = false,
      maxRetry = 100,
      userId = 'default_user',
      history = [],
      useSkills = true
    } = options

    this.activeSkillInstructions = []
    this.log('info', 'run_start', { query, userId, stream })

    if (stream) {
      throw new Error('Streaming mode not implemented yet')
    }

    try {
      const messages = this.buildMessages(query, history, useSkills)
      const activeTools = await this.resolveActiveTools(runtimeTools)
      return await this.coreRunLogic(messages, activeTools, maxRetry)
    } catch (error: any) {
      this.log('error', 'run_failed', { error: error.message })
      return {
        content: '',
        success: false,
        error: error.message
      }
    }
  }

  async runStream(options: AgentRunOptions, callbacks: AgentRunStreamCallbacks, signal?: AbortSignal): Promise<void> {
    const {
      query,
      tools: runtimeTools,
      maxRetry = 100,
      history = [],
      useSkills = true
    } = options

    this.activeSkillInstructions = []
    this.log('info', 'run_stream_start', { query })

    try {
      const messages = this.buildMessages(query, history, useSkills)
      const activeTools = await this.resolveActiveTools(runtimeTools)
      await this.coreRunLogicStream(messages, activeTools, maxRetry, callbacks, signal)
    } catch (error: any) {
      if (signal?.aborted) {
        callbacks.onDone?.()
        return
      }
      this.log('error', 'run_stream_failed', { error: error.message })
      callbacks.onError?.(error.message)
    }
  }

  private buildMessages(query: string, history: Message[], useSkills: boolean): Message[] {
    let systemPrompt = [
      `## 名称：${this.config.name}`,
      `## 指令：${this.config.instructions}`
    ]

    if (this.config.role) {
      systemPrompt.push(`## 身份：${this.config.role}`)
    }

    systemPrompt.push(
      '请一步一步思考来完成用户的要求。尽可能完成用户的回答，如果有补充信息，请参考补充信息来调用工具，直到获取所有满足用户的提问所需的答案。',
      '你可以使用知识库工具查询知识。'
    )

    if (useSkills) {
      const skillsXml = this.skillManager.getSkillsXml()
      if (skillsXml) {
        systemPrompt.push(`\n## 可用技能\n${skillsXml}`)
        systemPrompt.push('当用户需求与某个技能描述匹配时，请先使用 activate_skill 工具加载完整指令。')
      }
    }

    if (this.activeSkillInstructions.length > 0) {
      systemPrompt.push(`\n## 已激活技能指令\n${this.activeSkillInstructions.join('\n\n---\n\n')}`)
    }

    const messages: Message[] = [
      { role: 'system', content: systemPrompt.join('\n') },
      ...history,
      { role: 'user', content: query }
    ]

    this.chatParams.messages = messages
    return messages
  }

  private async resolveActiveTools(runtimeTools?: string[]): Promise<OpenAIToolDefinition[]> {
    if (this.config.treeOfThought) {
      const result = await this.runThought('', runtimeTools)
      return result.tools
    }
    if (runtimeTools) {
      return runtimeTools
        .map(name => this.toolRegistry.getOpenAISchemas().find(s => s.function.name === name))
        .filter((s): s is OpenAIToolDefinition => s !== undefined)
    }
    return this.toolRegistry.getOpenAISchemas()
  }

  private async coreRunLogic(
    messages: Message[],
    tools: OpenAIToolDefinition[],
    maxRetry: number
  ): Promise<AgentResponse> {
    let currentMessages = [...messages]
    const usedToolCalls: Array<{ name: string; args: any; result: any }> = []

    for (let attempt = 0; attempt < maxRetry; attempt++) {
      try {
        const response = await this.callLLM(currentMessages, tools)
        const assistantMessage = response.choices[0].message

        currentMessages.push({
          role: 'assistant',
          content: assistantMessage.content || '',
          reasoning_content: assistantMessage.reasoning_content || undefined,
          toolCalls: assistantMessage.tool_calls
        })

        if (!assistantMessage.tool_calls || assistantMessage.tool_calls.length === 0) {
          return {
            content: assistantMessage.content || '',
            toolCalls: usedToolCalls,
            success: true
          }
        }

        for (const toolCall of assistantMessage.tool_calls) {
          const toolName = toolCall.function.name
          let args: any
          try {
            args = JSON.parse(toolCall.function.arguments)
          } catch {
            args = {}
          }

          this.log('info', 'tool_call', { tool: toolName, args })

          const result = await this.toolDispatcher.dispatch(toolName, args)
          usedToolCalls.push({ name: toolName, args, result })

          if (toolName === 'activate_skill' && result.success && result.output) {
            const skillInstructions = String(result.output)
            if (!this.activeSkillInstructions.includes(skillInstructions)) {
              this.activeSkillInstructions.push(skillInstructions)
            }
          }

          currentMessages.push({
            role: 'tool',
            toolCallId: toolCall.id,
            content: result.success ? String(result.output) : String(result.error)
          })

          this.log('info', 'tool_result', { tool: toolName, result })
        }
      } catch (error: any) {
        this.log('warn', 'retry', { attempt, error: error.message })
        if (attempt === maxRetry - 1) {
          return {
            content: '',
            success: false,
            error: `Max retry (${maxRetry}) reached: ${error.message}`
          }
        }
      }
    }

    return {
      content: '',
      success: false,
      error: `Max retry (${maxRetry}) reached`
    }
  }

  private async coreRunLogicStream(
    messages: Message[],
    tools: OpenAIToolDefinition[],
    maxRetry: number,
    callbacks: AgentRunStreamCallbacks,
    signal?: AbortSignal
  ): Promise<void> {
    let currentMessages = [...messages]
    const usedToolCalls: Array<{ name: string; args: any; result: any }> = []

    for (let attempt = 0; attempt < maxRetry; attempt++) {
      if (signal?.aborted) {
        callbacks.onDone?.()
        return
      }
      try {
        let assistantContent = ''
        let assistantReasoning = ''
        let assistantToolCalls: any[] = []

        await this.callLLMStream(
          currentMessages,
          tools,
          {
            onChunk: (chunk: string) => {
              assistantContent += chunk
              callbacks.onChunk?.(chunk)
            },
            onThought: (thought: string) => {
              assistantReasoning += thought
              callbacks.onThought?.(thought)
            },
            onToolCall: (toolCalls: any[]) => {
              assistantToolCalls = toolCalls
            },
          },
          signal
        )

        currentMessages.push({
          role: 'assistant',
          content: assistantContent,
          reasoning_content: assistantReasoning || undefined,
          toolCalls: assistantToolCalls.length > 0 ? assistantToolCalls : undefined
        })

        if (!assistantToolCalls || assistantToolCalls.length === 0) {
          callbacks.onDone?.()
          return
        }

        for (const toolCall of assistantToolCalls) {
          const toolName = toolCall.function.name
          let args: any
          try {
            args = JSON.parse(toolCall.function.arguments)
          } catch {
            args = {}
          }

          this.log('info', 'tool_call', { tool: toolName, args })
          callbacks.onToolCall?.({ name: toolName, args })

          const result = await this.toolDispatcher.dispatch(toolName, args)
          usedToolCalls.push({ name: toolName, args, result })
          callbacks.onToolResult?.({ name: toolName, result: result.success ? result.output : result.error, rawResult: result.rawOutput })

          if (toolName === 'activate_skill' && result.success && result.output) {
            const skillInstructions = String(result.output)
            if (!this.activeSkillInstructions.includes(skillInstructions)) {
              this.activeSkillInstructions.push(skillInstructions)
            }
          }

          currentMessages.push({
            role: 'tool',
            toolCallId: toolCall.id,
            content: result.success ? String(result.output) : String(result.error)
          })

          this.log('info', 'tool_result', { tool: toolName, result })
        }
      } catch (error: any) {
        this.log('warn', 'retry', { attempt, error: error.message })
        if (attempt === maxRetry - 1) {
          callbacks.onError?.(`Max retry (${maxRetry}) reached: ${error.message}`)
          return
        }
      }
    }

    callbacks.onError?.(`Max retry (${maxRetry}) reached`)
  }

  private async runThought(
    query: string,
    runtimeTools?: string[]
  ): Promise<{ thought: string; tools: OpenAIToolDefinition[] }> {
    const availableTools = runtimeTools
      ? runtimeTools
          .map(name => this.toolRegistry.getOpenAISchemas().find(s => s.function.name === name))
          .filter((s): s is OpenAIToolDefinition => s !== undefined)
      : this.toolRegistry.getOpenAISchemas()

    const toolsStr = JSON.stringify(availableTools, null, 2)
    const now = new Date()

    const systemPrompt = `你是一个智能助手，请根据用户输入的问题，结合工具使用计划，生成一个思维树，并按照思维树依次调用工具步骤，最终生成一个最终回答。
今日的日期：${now.toISOString().split('T')[0]}
当前时间：${now.toTimeString().split(' ')[0]}
工具列表：${toolsStr}`

    this.log('debug', 'run_thought', { systemPrompt })

    try {
      const response1 = await this.callLLM(
        [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: query }
        ],
        []
      )
      const thought1 = response1.choices[0].message.content || ''

      this.log('debug', 'thought_response', { response: thought1 })

      const response2 = await this.callLLM(
        [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: query },
          { role: 'assistant', content: thought1 },
          { role: 'user', content: '请反思你的回答，请严格按照<工具列表>中的工具来规划，不可以创造其他新的工具。请输出新的任务规划，不要输出其他分析和回答。' }
        ],
        []
      )
      const refinedThought = response2.choices[0].message.content || ''

      this.log('debug', 'refined_thought', { response: refinedThought })

      const response3 = await this.callLLM(
        [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: query },
          { role: 'assistant', content: refinedThought },
          { role: 'user', content: '请严格按以下要求执行：\n1. 分析问题需求并规划需要使用的工具\n2. 仅输出包含工具名称的JSON格式结果\n3. 使用以下结构（示例）：\n{"tools": [{"name": "工具名称1"}, {"name": "工具名称2"}]}\n4. 不要包含任何解释性内容' }
        ],
        []
      )
      const reflectionResult = response3.choices[0].message.content || ''

      this.log('debug', 'tool_reflection', { result: reflectionResult })

      let selectedTools = availableTools

      if (this.config.filterTools) {
        try {
          selectedTools = this.toolRegistry.filterTools(reflectionResult)
          this.log('debug', 'filtered_tools', { tools: selectedTools.map(t => t.function.name) })
        } catch (error) {
          this.log('warn', 'filter_tools_failed', { error })
        }
      }

      return { thought: refinedThought, tools: selectedTools }
    } catch (error: any) {
      this.log('error', 'run_thought_failed', { error: error.message })
      throw new Error(`思维链执行失败: ${error.message}`)
    }
  }

  private async callLLM(
    messages: Message[],
    tools: OpenAIToolDefinition[]
  ): Promise<any> {
    const url = `${this.config.baseUrl}/chat/completions`
    const headers: Record<string, string> = {
      'Content-Type': 'application/json'
    }

    if (this.config.apiKey) {
      headers['Authorization'] = `Bearer ${this.config.apiKey}`
    }

    const body: any = {
      model: this.config.model,
      messages: messages.map(m => {
        const msg: any = {
          role: m.role,
          content: m.content,
          tool_calls: m.toolCalls,
          tool_call_id: m.toolCallId
        }
        if (m.reasoning_content) {
          msg.reasoning_content = m.reasoning_content
        }
        return msg
      })
    }

    if (tools.length > 0) {
      body.tools = tools
      body.tool_choice = 'auto'
    }

    this.applyThinkingParams(body)

    this.log('debug', 'llm_call', { model: this.config.model, messagesCount: messages.length, toolsCount: tools.length })

    const response = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body)
    })

    if (!response.ok) {
      const errorText = await response.text()
      throw new Error(`LLM call failed: ${response.status} - ${errorText}`)
    }

    return await response.json()
  }

  private async callLLMStream(
    messages: Message[],
    tools: OpenAIToolDefinition[],
    callbacks: {
      onChunk: (chunk: string) => void
      onThought: (thought: string) => void
      onToolCall: (toolCalls: any[]) => void
    },
    signal?: AbortSignal
  ): Promise<void> {
    const url = `${this.config.baseUrl}/chat/completions`
    const headers: Record<string, string> = {
      'Content-Type': 'application/json'
    }

    if (this.config.apiKey) {
      headers['Authorization'] = `Bearer ${this.config.apiKey}`
    }

    const body: any = {
      model: this.config.model,
      messages: messages.map(m => {
        const msg: any = {
          role: m.role,
          content: m.content,
          tool_calls: m.toolCalls,
          tool_call_id: m.toolCallId
        }
        if (m.reasoning_content) {
          msg.reasoning_content = m.reasoning_content
        }
        return msg
      }),
      stream: true
    }

    if (tools.length > 0) {
      body.tools = tools
      body.tool_choice = 'auto'
    }

    this.applyThinkingParams(body)

    this.log('debug', 'llm_stream_call', { model: this.config.model, messagesCount: messages.length, toolsCount: tools.length })

    const response = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      ...(signal ? { signal } : {}),
    })

    if (!response.ok) {
      const errorText = await response.text()
      throw new Error(`LLM stream call failed: ${response.status} - ${errorText}`)
    }

    const reader = response.body?.getReader()
    if (!reader) {
      throw new Error('No response body')
    }

    const decoder = new TextDecoder()
    let buffer = ''
    let accumulatedToolCalls: any[] = []

    while (true) {
      const { done, value } = await reader.read()
      if (done) break

      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split('\n')
      buffer = lines.pop() || ''

      for (const line of lines) {
        const trimmed = line.trim()
        if (!trimmed || !trimmed.startsWith('data: ')) continue

        const data = trimmed.slice(6)
        if (data === '[DONE]') continue

        try {
          const parsed = JSON.parse(data)
          const delta = parsed.choices?.[0]?.delta

          if (delta?.reasoning_content) {
            callbacks.onThought(delta.reasoning_content)
          }

          if (delta?.content) {
            callbacks.onChunk(delta.content)
          }

          if (delta?.tool_calls) {
            for (const tc of delta.tool_calls) {
              const index = tc.index || 0
              if (!accumulatedToolCalls[index]) {
                accumulatedToolCalls[index] = {
                  id: tc.id || '',
                  type: 'function',
                  function: {
                    name: '',
                    arguments: ''
                  }
                }
              }
              if (tc.id) accumulatedToolCalls[index].id = tc.id
              if (tc.function?.name) accumulatedToolCalls[index].function.name += tc.function.name
              if (tc.function?.arguments) accumulatedToolCalls[index].function.arguments += tc.function.arguments
            }
          }
        } catch {
          // ignore parse errors
        }
      }
    }

    if (accumulatedToolCalls.length > 0) {
      callbacks.onToolCall(accumulatedToolCalls)
    }
  }

  private applyThinkingParams(body: any): void {
    const providerType = this.config.providerType
    const enableThinking = this.config.enableThinking

    if (enableThinking) {
      if (providerType === 'deepseek') {
        body.thinking = { type: 'enabled' }
        body.reasoning_effort = 'high'
      } else if (providerType === 'qwen') {
        body.enable_thinking = true
      } else if (providerType === 'volcengine') {
        body.thinking = { type: 'enabled' }
      } else if (providerType === 'zhipu') {
        body.thinking = { type: 'enabled' }
      }
    } else {
      if (providerType === 'deepseek') {
        body.thinking = { type: 'disabled' }
      } else if (providerType === 'volcengine') {
        body.thinking = { type: 'disabled' }
      } else if (providerType === 'zhipu') {
        body.thinking = { type: 'disabled' }
      }
    }
  }

  private log(level: string, action: string, data: any): void {
    if (!this.config.debug) return
    
    const timestamp = new Date().toISOString()
    console.log(`[${timestamp}] [${level.toUpperCase()}] [${action}]`, data)
  }
}
