import LLMClientService from '../../llm-client.service'
import { getModelConfig, resolveModelName } from '../../llm-request-builder'
import { PiAIProvider } from './pi-ai-provider'

/**
 * 从 provider 配置构建 PiAIProvider（业务模块统一 LLM 调用入口）。
 * modelId 为 models_json 中的模型 ID 或 API 模型名，缺省用 provider 默认模型；
 * 模型级 temperature/max_tokens/enable_thinking 作为 defaultOptions 兜底。
 */
export async function createPiProvider(providerId: string, modelId?: string): Promise<PiAIProvider | null> {
  const llmClient = LLMClientService.getInstance()
  const config = await llmClient.getProviderConfig(providerId)
  if (!config) return null

  const model = resolveModelName(config, modelId || config.model)
  if (!model?.trim()) {
    throw new Error(`Model name is empty for provider "${config.name}" (${config.id}). Please configure a default model.`)
  }

  const modelConfig = getModelConfig(config, model)

  return new PiAIProvider({
    model,
    apiKey: config.api_key,
    baseUrl: llmClient.getBaseURL(config),
    providerType: config.provider_type,
    defaultOptions: {
      temperature: modelConfig?.temperature ?? config.temperature,
      maxTokens: modelConfig?.max_tokens ?? config.max_tokens,
      enableThinking: modelConfig?.enable_thinking ?? false,
    },
  })
}
