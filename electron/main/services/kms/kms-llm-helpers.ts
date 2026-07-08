import LLMClientService from '../llm-client.service'
import { parseJSON } from './kms-paragraph-processor'

/** callLLMForJSON 调用选项 */
export interface CallLLMForJSONOptions {
  temperature?: number
  maxTokens?: number
  signal?: AbortSignal
  logSource?: string
  enable_thinking?: boolean
  /** 失败时抛出异常而不是返回 fallback。默认 false */
  throwOnError?: boolean
  /** 自定义错误信息（仅 throwOnError=true 时使用） */
  errorMessage?: (err: unknown) => string
}

/**
 * 调用 LLM 并将响应解析为 JSON 对象。
 *
 * 统一封装 KMS 模块内 9 处 LLM-JSON 调用模板：
 * - 自动注入 model 参数（避免 400 MissingParameter）
 * - 使用 parseJSON 容错解析（支持 ```json``` 围栏 + 字符串内换行修复）
 * - 默认失败返回 fallback；可选 throwOnError 抛出
 *
 * 调用方负责在必要时检查 signal.aborted 与业务字段合法性。
 */
export async function callLLMForJSON<T>(
  llmClient: LLMClientService,
  providerId: string,
  modelId: string | undefined,
  messages: Array<{ role: 'system' | 'user'; content: string }>,
  fallback: T,
  options: CallLLMForJSONOptions = {},
): Promise<T> {
  try {
    const result = await llmClient.chat(providerId, messages, {
      ...(options.temperature !== undefined ? { temperature: options.temperature } : {}),
      ...(options.maxTokens !== undefined ? { max_tokens: options.maxTokens } : {}),
      ...(modelId ? { model: modelId } : {}),
      ...(options.signal ? { signal: options.signal } : {}),
      ...(options.logSource ? { logSource: options.logSource } : {}),
      ...(options.enable_thinking !== undefined ? { enable_thinking: options.enable_thinking } : {}),
    })
    return parseJSON<T>(result, fallback)
  } catch (err) {
    if (options.throwOnError) {
      throw new Error(
        options.errorMessage
          ? options.errorMessage(err)
          : `LLM call failed: ${err instanceof Error ? err.message : 'Unknown error'}`,
      )
    }
    return fallback
  }
}
