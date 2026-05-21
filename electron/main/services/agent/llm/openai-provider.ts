import {
  ILLMProvider,
  LLMProviderConfig,
  LLMCallOptions,
  LLMResponse,
  LLMStreamCallbacks,
  LLMMessage,
  LLMToolCall,
  LLMMessageContentPart,
  LLMUsage,
} from './types'

export class OpenAIProvider implements ILLMProvider {
  readonly name = 'openai-compatible'
  private config: LLMProviderConfig

  constructor(config: LLMProviderConfig) {
    this.config = {
      ...config,
      baseUrl: config.baseUrl || 'https://api.openai.com/v1',
    }
  }

  updateConfig(config: Partial<LLMProviderConfig>): void {
    Object.assign(this.config, config)
  }

  getConfig(): LLMProviderConfig {
    return { ...this.config }
  }

  async chat(
    messages: LLMMessage[],
    tools?: any[],
    options?: LLMCallOptions
  ): Promise<LLMResponse> {
    const startTime = Date.now()
    const url = `${this.config.baseUrl}/chat/completions`
    const headers = this.buildHeaders()
    const body = this.buildBody(messages, tools, false, options)

    const response = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    })

    if (!response.ok) {
      const errorText = await response.text()
      throw this.createError(response.status, errorText)
    }

    const data = await response.json()
    const choice = data.choices?.[0]?.message

    return {
      content: choice?.content || '',
      reasoningContent: choice?.reasoning_content,
      toolCalls: choice?.tool_calls,
      finishReason: data.choices?.[0]?.finish_reason,
      usage: data.usage,
      latencyMs: Date.now() - startTime,
    }
  }

  async chatStream(
    messages: LLMMessage[],
    tools: any[],
    callbacks: LLMStreamCallbacks,
    signal?: AbortSignal
  ): Promise<LLMResponse> {
    const startTime = Date.now()
    const url = `${this.config.baseUrl}/chat/completions`
    const headers = this.buildHeaders()
    const body = this.buildBody(messages, tools, true)

    const response = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      ...(signal ? { signal } : {}),
    })

    if (!response.ok) {
      const errorText = await response.text()
      throw this.createError(response.status, errorText)
    }

    const reader = response.body?.getReader()
    if (!reader) {
      throw new Error('No response body for streaming')
    }

    let assistantContent = ''
    let assistantReasoning = ''
    let accumulatedToolCalls: LLMToolCall[] = []
    const decoder = new TextDecoder()
    let buffer = ''

    let fullBuffer = ''

    while (true) {
      const { done, value } = await reader.read()
      if (done) break

      const decoded = decoder.decode(value, { stream: true })
      fullBuffer += decoded
      buffer += decoded
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
            assistantReasoning += delta.reasoning_content
            callbacks.onThought(delta.reasoning_content)
          }

          if (delta?.content) {
            assistantContent += delta.content
            callbacks.onChunk(delta.content)
          }

          if (delta?.tool_calls) {
            for (const tc of delta.tool_calls) {
              const index = tc.index || 0
              if (!accumulatedToolCalls[index]) {
                accumulatedToolCalls[index] = {
                  id: tc.id || '',
                  type: 'function',
                  function: { name: '', arguments: '' },
                }
              }
              if (tc.id) accumulatedToolCalls[index].id = tc.id
              if (tc.function?.name) accumulatedToolCalls[index].function.name += tc.function.name
              if (tc.function?.arguments) accumulatedToolCalls[index].function.arguments += tc.function.arguments
            }
          }
        } catch {
          // ignore SSE parse errors
        }
      }
    }

    if (accumulatedToolCalls.length > 0) {
      callbacks.onToolCall(accumulatedToolCalls)
    }

    const usage = this.extractUsageFromBuffer(fullBuffer)

    return {
      content: assistantContent,
      reasoningContent: assistantReasoning || undefined,
      toolCalls: accumulatedToolCalls.length > 0 ? accumulatedToolCalls : undefined,
      latencyMs: Date.now() - startTime,
      usage,
    }
  }

  private extractUsageFromBuffer(buffer: string): LLMUsage | undefined {
    const lines = buffer.split('\n')
    for (const line of lines) {
      const trimmed = line.trim()
      if (!trimmed || !trimmed.startsWith('data: ')) continue
      const data = trimmed.slice(6)
      if (data === '[DONE]') continue
      try {
        const parsed = JSON.parse(data)
        if (parsed.usage) {
          return parsed.usage
        }
      } catch {
        // ignore
      }
    }
    return undefined
  }

  estimateTokens(messages: LLMMessage[]): number {
    let totalChars = 0
    for (const msg of messages) {
      totalChars += (msg.content?.length ?? 0)
      totalChars += (msg.reasoning_content?.length ?? 0)
      if (msg.tool_calls) {
        for (const tc of msg.tool_calls) {
          totalChars += (tc.function.name?.length ?? 0)
          totalChars += (tc.function.arguments?.length ?? 0)
        }
      }
    }
    return Math.ceil(totalChars / 3.5)
  }

  private buildHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    }
    if (this.config.apiKey) {
      headers['Authorization'] = `Bearer ${this.config.apiKey}`
    }
    return headers
  }

  private buildBody(
    messages: LLMMessage[],
    tools: any[] | undefined,
    stream: boolean,
    options?: LLMCallOptions
  ): any {
    const mergedOptions = { ...this.config.defaultOptions, ...options }
    const providerType = mergedOptions.providerType || this.config.providerType
    const enableThinking = mergedOptions.enableThinking

    const body: any = {
      model: this.config.model,
      messages: messages.map(m => {
        const msg: any = {
          role: m.role,
          content: this.formatMessageContent(m.content),
          tool_calls: m.tool_calls,
          tool_call_id: m.tool_call_id,
        }
        if (m.reasoning_content) {
          msg.reasoning_content = m.reasoning_content
        }
        return msg
      }),
    }

    if (stream) {
      body.stream = true
    }

    if (tools && tools.length > 0) {
      body.tools = tools
      body.tool_choice = 'auto'
    }

    if (mergedOptions.temperature !== undefined) {
      body.temperature = mergedOptions.temperature
    }
    if (mergedOptions.maxTokens !== undefined) {
      body.max_tokens = mergedOptions.maxTokens
    }
    if (mergedOptions.topP !== undefined) {
      body.top_p = mergedOptions.topP
    }
    if (mergedOptions.stopSequences) {
      body.stop = mergedOptions.stopSequences
    }

    this.applyThinkingParams(body, providerType, enableThinking)

    return body
  }

  private formatMessageContent(content: string | LLMMessageContentPart[]): string | LLMMessageContentPart[] {
    if (typeof content === 'string') {
      return content
    }
    if (Array.isArray(content)) {
      return content
    }
    return String(content)
  }

  private applyThinkingParams(body: any, providerType?: string, enableThinking?: boolean): void {
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

  private createError(status: number, body: string): Error {
    const retryable = status === 429 || status >= 500
    const error = new Error(`LLM call failed: ${status} - ${body}`)
    ;(error as any).status = status
    ;(error as any).retryable = retryable
    return error
  }
}
