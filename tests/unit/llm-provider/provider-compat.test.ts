import { describe, it, expect } from 'vitest'
import {
  getProviderCompat,
  resolveReasoningEffort,
  getProviderExtraRequestHeaders,
} from '../../../electron/main/services/agent/llm/provider-compat'
import { buildPiStreamOptions } from '../../../electron/main/services/agent/llm/pi-stream-options'

describe('provider-compat', () => {
  it('openai-compatible 未知 provider 回退 DEFAULT', () => {
    const compat = getProviderCompat('不存在的供应商')
    expect(compat.supportsStore).toBe(true)
    expect(compat.maxTokensField).toBe('max_completion_tokens')
  })

  it('opencode-go：聚合网关 compat + alwaysReasoning + 会话路由头', () => {
    const compat = getProviderCompat('opencode-go')
    expect(compat.supportsStore).toBe(false)
    expect(compat.supportsDeveloperRole).toBe(false)
    expect(compat.maxTokensField).toBe('max_tokens')
    expect(compat.alwaysReasoning).toBe(true)
    expect(compat.defaultReasoningEffort).toBe('low')
    expect(compat.sessionAffinityFormat).toBe('openai-nosession')
    expect(compat.extraRequestHeaders?.['x-opencode-session']).toBe('@sessionId')
  })

  it('deepseek：仅推理模型要求回传 reasoning_content（逐模型覆盖）', () => {
    expect(getProviderCompat('deepseek', 'deepseek-reasoner').requiresReasoningContentOnAssistantMessages).toBe(true)
    expect(getProviderCompat('deepseek', 'deepseek-v4-pro').requiresReasoningContentOnAssistantMessages).toBe(true)
    // 非推理模型不覆盖，避免向其回传空 reasoning_content
    expect(getProviderCompat('deepseek', 'deepseek-chat').requiresReasoningContentOnAssistantMessages).toBeUndefined()
  })

  it('moonshot：Kimi 系启用 deepseek thinking 格式，legacy moonshot-v1 不受影响', () => {
    expect(getProviderCompat('moonshot', 'kimi-k2.6').thinkingFormat).toBe('deepseek')
    expect(getProviderCompat('moonshot', 'kimi-k2.7-code').thinkingFormat).toBe('deepseek')
    // K3 用 reasoning_effort 且要求回传 reasoning_content
    const k3 = getProviderCompat('moonshot', 'kimi-k3')
    expect(k3.thinkingFormat).toBeUndefined()
    expect(k3.supportsReasoningEffort).toBe(true)
    expect(k3.requiresReasoningContentOnAssistantMessages).toBe(true)
    // 老模型保持历史行为（不发送 thinking 参数）
    expect(getProviderCompat('moonshot', 'moonshot-v1-8k').thinkingFormat).toBeUndefined()
  })

  it('zhipu：对齐 pi-ai 的 zai thinking 格式 + 工具流式', () => {
    const compat = getProviderCompat('zhipu')
    expect(compat.thinkingFormat).toBe('zai')
    expect(compat.zaiToolStream).toBe(true)
    expect(compat.maxTokensField).toBe('max_tokens')
  })

  it('resolveReasoningEffort：显式级别优先，alwaysReasoning 兜底 low', () => {
    expect(resolveReasoningEffort('openai', undefined, false)).toBe(false)
    expect(resolveReasoningEffort('openai', undefined, 'high')).toBe('high')
    expect(resolveReasoningEffort('opencode-go', undefined, false)).toBe('low')
    expect(resolveReasoningEffort('opencode-go', undefined, 'high')).toBe('high')
  })

  it('getProviderExtraRequestHeaders：@sessionId 占位符按需替换', () => {
    const withSession = getProviderExtraRequestHeaders('opencode-go', undefined, 'conv-123')
    expect(withSession).toEqual({ 'x-opencode-client': 'workavatar', 'x-opencode-session': 'conv-123' })
    // 无会话 ID 时跳过该头，仍保留客户端标识
    expect(getProviderExtraRequestHeaders('opencode-go', undefined)).toEqual({ 'x-opencode-client': 'workavatar' })
    // 无额外头的 provider 返回 undefined
    expect(getProviderExtraRequestHeaders('openai', undefined, 'x')).toBeUndefined()
  })
})

describe('buildPiStreamOptions', () => {
  it('采样参数映射到 samplingParams（含 top_p / penalties）', () => {
    const opts = buildPiStreamOptions({ topP: 0.9, frequencyPenalty: 0.2, presencePenalty: -0.1 })
    expect(opts.samplingParams).toEqual({ top_p: 0.9, frequency_penalty: 0.2, presence_penalty: -0.1 })
  })

  it('thinking_budget 映射到各档位 thinkingBudgets', () => {
    const opts = buildPiStreamOptions({ thinkingBudget: 4096 })
    expect(opts.thinkingBudgets).toEqual({ minimal: 4096, low: 4096, medium: 4096, high: 4096 })
  })

  it('extraBody 映射到 onPayload 且可覆盖原字段', () => {
    const opts = buildPiStreamOptions({ extraBody: { temperature: 0.1, custom_flag: true } })
    expect(typeof opts.onPayload).toBe('function')
    expect(opts.onPayload({ temperature: 0.7, model: 'm' })).toEqual({
      temperature: 0.1,
      model: 'm',
      custom_flag: true,
    })
  })

  it('额外请求头与内置会话路由头合并，且供应商配置优先', () => {
    const opts = buildPiStreamOptions({
      providerType: 'opencode-go',
      sessionId: 's1',
      extraHeaders: { 'x-custom': '1', 'x-opencode-session': 'override' },
    })
    expect(opts.headers).toEqual({
      'x-opencode-client': 'workavatar',
      'x-opencode-session': 'override',
      'x-custom': '1',
    })
  })

  it('reasoningEffort / sessionId / timeoutMs 透传，未设置时不出现多余键', () => {
    const opts = buildPiStreamOptions({
      providerType: 'opencode-go',
      sessionId: 's1',
      timeoutMs: 60000,
      enableThinking: false,
    })
    expect(opts.reasoningEffort).toBe('low')
    expect(opts.sessionId).toBe('s1')
    expect(opts.timeoutMs).toBe(60000)
    expect(opts.samplingParams).toBeUndefined()
    expect(opts.thinkingBudgets).toBeUndefined()
    expect(opts.onPayload).toBeUndefined()
  })

  it('流式调用忽略 timeoutMs（避免长回复被 SDK 整请求时限截断），非流式才透传', () => {
    expect(buildPiStreamOptions({ timeoutMs: 60000 }).timeoutMs).toBe(60000)
    expect(buildPiStreamOptions({ timeoutMs: 60000, streaming: true }).timeoutMs).toBeUndefined()
  })
})
