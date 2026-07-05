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
import LLMLoggerService from '../../llm-logger.service'

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
    const logSource = options?.logSource || 'agent'

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
      })

      if (!response.ok) {
        const errorText = await response.text()
        const err = this.createError(response.status, errorText)
        LLMLoggerService.getInstance().logCall({
          type: 'chat',
          source: logSource,
          model: this.config.model,
          providerType: this.config.providerType,
          request: {
            messages: this.sanitizeMessagesForLog(messages),
            tools: tools?.length ? tools : undefined,
            temperature: body.temperature,
            max_tokens: body.max_tokens,
            stream: false,
          },
          error: `${response.status} - ${errorText}`,
        })
        throw err
      }

      const data = await response.json()
      const choice = data.choices?.[0]?.message
      const latencyMs = Date.now() - startTime

      const usage = this.normalizeUsage(data.usage)

      LLMLoggerService.getInstance().logCall({
        type: 'chat',
        source: logSource,
        model: this.config.model,
        providerType: this.config.providerType,
        request: {
          messages: this.sanitizeMessagesForLog(messages),
          tools: tools?.length ? tools : undefined,
          temperature: body.temperature,
          max_tokens: body.max_tokens,
          stream: false,
        },
        response: {
          content: choice?.content || '',
          reasoningContent: choice?.reasoning_content,
          toolCalls: choice?.tool_calls,
          finishReason: data.choices?.[0]?.finish_reason,
          usage,
          latencyMs,
        },
      })

      return {
        content: choice?.content || '',
        reasoningContent: choice?.reasoning_content,
        toolCalls: choice?.tool_calls,
        finishReason: data.choices?.[0]?.finish_reason,
        usage,
        latencyMs,
      }
    } catch (error: any) {
      if (!(error as any).status) {
        LLMLoggerService.getInstance().logCall({
          type: 'chat',
          source: logSource,
          model: this.config.model,
          providerType: this.config.providerType,
          request: {
            messages: this.sanitizeMessagesForLog(messages),
            tools: tools?.length ? tools : undefined,
            temperature: body.temperature,
            max_tokens: body.max_tokens,
            stream: false,
          },
          error: error.message,
        })
      }
      throw error
    }
  }

  async chatStream(
    messages: LLMMessage[],
    tools: any[],
    callbacks: LLMStreamCallbacks,
    signal?: AbortSignal,
    options?: LLMCallOptions
  ): Promise<LLMResponse> {
    const startTime = Date.now()
    const logSource = options?.logSource || 'agent'
    const url = `${this.config.baseUrl}/chat/completions`
    const headers = this.buildHeaders()
    const body = this.buildBody(messages, tools, true)

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        ...(signal ? { signal } : {}),
      })

      if (!response.ok) {
        const errorText = await response.text()
        const err = this.createError(response.status, errorText)
        LLMLoggerService.getInstance().logCall({
          type: 'chatStream',
          source: logSource,
          model: this.config.model,
          providerType: this.config.providerType,
          request: {
            messages: this.sanitizeMessagesForLog(messages),
            tools: tools?.length ? tools : undefined,
            temperature: body.temperature,
            max_tokens: body.max_tokens,
            stream: true,
          },
          error: `${response.status} - ${errorText}`,
        })
        throw err
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
      let streamUsage: LLMUsage | undefined

      while (true) {
        const { done, value } = await reader.read()
        if (done) break

        const decoded = decoder.decode(value, { stream: true })
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

            // 在主循环中直接提取 usage，避免二次遍历解析
            if (parsed.usage) {
              streamUsage = this.normalizeUsage(parsed.usage)
            }
          } catch {
          }
        }
      }

      if (accumulatedToolCalls.length > 0) {
        callbacks.onToolCall(accumulatedToolCalls)
      }

      const usage = streamUsage
      const latencyMs = Date.now() - startTime

      LLMLoggerService.getInstance().logCall({
        type: 'chatStream',
        source: logSource,
        model: this.config.model,
        providerType: this.config.providerType,
        request: {
          messages: this.sanitizeMessagesForLog(messages),
          tools: tools?.length ? tools : undefined,
          temperature: body.temperature,
          max_tokens: body.max_tokens,
          stream: true,
        },
        response: {
          content: assistantContent,
          reasoningContent: assistantReasoning || undefined,
          toolCalls: accumulatedToolCalls.length > 0 ? accumulatedToolCalls : undefined,
          usage,
          latencyMs,
        },
      })

      return {
        content: assistantContent,
        reasoningContent: assistantReasoning || undefined,
        toolCalls: accumulatedToolCalls.length > 0 ? accumulatedToolCalls : undefined,
        latencyMs,
        usage,
      }
    } catch (error: any) {
      if (!(error as any).status) {
        LLMLoggerService.getInstance().logCall({
          type: 'chatStream',
          source: logSource,
          model: this.config.model,
          providerType: this.config.providerType,
          request: {
            messages: this.sanitizeMessagesForLog(messages),
            tools: tools?.length ? tools : undefined,
            temperature: body.temperature,
            max_tokens: body.max_tokens,
            stream: true,
          },
          error: error.message,
        })
      }
      throw error
    }
  }

  private normalizeUsage(raw: any): LLMUsage | undefined {
    if (!raw) return undefined
    const cachedTokens =
      raw.prompt_tokens_details?.cached_tokens ??
      raw.prompt_cache_hit_tokens ??
      undefined
    return {
      promptTokens: raw.promptTokens ?? raw.prompt_tokens,
      completionTokens: raw.completionTokens ?? raw.completion_tokens,
      totalTokens: raw.totalTokens ?? raw.total_tokens,
      ...(cachedTokens != null ? { cachedTokens } : {}),
    }
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
      body.stream_options = { include_usage: true }
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

  private sanitizeMessagesForLog(messages: LLMMessage[]): any[] {
    return messages.map(m => {
      const msg: any = { role: m.role }
      if (typeof m.content === 'string') {
        msg.content = m.content
      } else if (Array.isArray(m.content)) {
        msg.content = m.content.map((part: LLMMessageContentPart) => {
          if (part.type === 'image_url') {
            return { type: 'image_url', image_url: { url: '[image]' } }
          }
          return part
        })
      }
      if (m.tool_calls) {
        msg.tool_calls = m.tool_calls
      }
      if (m.tool_call_id) {
        msg.tool_call_id = m.tool_call_id
      }
      if (m.reasoning_content) {
        msg.reasoning_content = m.reasoning_content
      }
      return msg
    })
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
      } else if (providerType === 'qwen') {
        body.enable_thinking = false
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
