import { describe, it, expect } from 'vitest'
import { buildPiStreamOptions } from '../../../electron/main/services/agent/llm/pi-stream-options'
import {
  getProviderCompat,
  resolveReasoningEffort,
  getProviderExtraRequestHeaders,
} from '../../../electron/main/services/agent/llm/provider-compat'

describe('buildPiStreamOptions 分支边界', () => {
  it('空输入不产生任何键（apiKey/signal/temperature/maxTokens 均省略）', () => {
    expect(buildPiStreamOptions({})).toEqual({})
  })

  it('apiKey / signal / temperature / maxTokens 按“非 undefined 即透传”语义处理', () => {
    const signal = new AbortController().signal
    const opts = buildPiStreamOptions({ apiKey: '', temperature: 0, maxTokens: 0, signal })
    expect(opts.apiKey).toBe('')
    expect(opts.temperature).toBe(0)
    expect(opts.maxTokens).toBe(0)
    expect(opts.signal).toBe(signal)

    const omitted = buildPiStreamOptions({ apiKey: undefined, temperature: undefined, maxTokens: undefined })
    expect('apiKey' in omitted).toBe(false)
    expect('temperature' in omitted).toBe(false)
    expect('maxTokens' in omitted).toBe(false)
    expect('signal' in omitted).toBe(false)
  })

  it('采样参数 0 值也计入 samplingParams（falsy 不等于未设置）', () => {
    const opts = buildPiStreamOptions({ topP: 0, frequencyPenalty: 0, presencePenalty: 0 })
    expect(opts.samplingParams).toEqual({ top_p: 0, frequency_penalty: 0, presence_penalty: 0 })
  })

  it('thinkingBudget 为 0 时仍映射四档', () => {
    expect(buildPiStreamOptions({ thinkingBudget: 0 }).thinkingBudgets).toEqual({
      minimal: 0, low: 0, medium: 0, high: 0,
    })
  })

  it('timeoutMs 为 0 且非流式时透传；流式一律忽略', () => {
    expect(buildPiStreamOptions({ timeoutMs: 0 }).timeoutMs).toBe(0)
    expect(buildPiStreamOptions({ timeoutMs: 0, streaming: false }).timeoutMs).toBe(0)
    expect(buildPiStreamOptions({ timeoutMs: 0, streaming: true }).timeoutMs).toBeUndefined()
  })

  it('无内置路由头的 provider 在 extraHeaders 为空对象时不产生 headers 键', () => {
    expect('headers' in buildPiStreamOptions({ providerType: 'openai', extraHeaders: {} })).toBe(false)
    // 仅 extraHeaders 时也会合并输出
    expect(buildPiStreamOptions({ providerType: 'openai', extraHeaders: { 'x-a': '1' } }).headers).toEqual({ 'x-a': '1' })
  })

  it('sessionId 为空串时不透传 sessionId，也不注入 @sessionId 路由头', () => {
    const opts = buildPiStreamOptions({ providerType: 'opencode-go', sessionId: '' })
    expect('sessionId' in opts).toBe(false)
    expect(opts.headers).toEqual({ 'x-opencode-client': 'workavatar' })
  })

  it('未知 provider 且未显式开启思考时不注入 reasoningEffort', () => {
    expect('reasoningEffort' in buildPiStreamOptions({ providerType: 'unknown-provider' })).toBe(false)
    expect(buildPiStreamOptions({ providerType: 'unknown-provider', enableThinking: 'medium' }).reasoningEffort).toBe('medium')
  })

  it('extraBody 为空对象时 onPayload 仍产出（浅合并为无操作）', () => {
    const opts = buildPiStreamOptions({ extraBody: {} })
    expect(typeof opts.onPayload).toBe('function')
    expect(opts.onPayload({ model: 'm' })).toEqual({ model: 'm' })
    expect('onPayload' in buildPiStreamOptions({})).toBe(false)
  })

  it('extraBody 覆盖同名键，未命中的键保留；undefined 值同样覆盖', () => {
    const opts = buildPiStreamOptions({ extraBody: { temperature: 0, custom: undefined } })
    const payload = opts.onPayload({ temperature: 0.9, top_p: 0.5, custom: 'old' })
    expect(payload.temperature).toBe(0)
    expect(payload.top_p).toBe(0.5)
    expect('custom' in payload).toBe(true)
    expect(payload.custom).toBeUndefined()
  })

  it('thinkingFormat provider 在未显式开启思考时仍不注入 reasoningEffort（由 pi-ai compat 推导）', () => {
    const opts = buildPiStreamOptions({ providerType: 'deepseek', modelId: 'deepseek-chat' })
    expect('reasoningEffort' in opts).toBe(false)
  })

  it('alwaysReasoning provider 未显式开启思考时注入 defaultReasoningEffort', () => {
    expect(buildPiStreamOptions({ providerType: 'opencode-go' }).reasoningEffort).toBe('low')
    expect(buildPiStreamOptions({ providerType: 'opencode-go', enableThinking: false }).reasoningEffort).toBe('low')
  })

  it('全部字段同时提供时键集合稳定（回归防护）', () => {
    const opts = buildPiStreamOptions({
      providerType: 'opencode-go', modelId: 'kimi-k2', apiKey: 'k', sessionId: 's',
      enableThinking: 'high', temperature: 0.3, maxTokens: 512, topP: 0.8,
      frequencyPenalty: 0.1, presencePenalty: 0.2, thinkingBudget: 1024,
      timeoutMs: 30000, extraHeaders: { 'x-e': '1' }, extraBody: { foo: 'bar' },
    })
    expect(Object.keys(opts).sort()).toEqual([
      'apiKey', 'headers', 'maxTokens', 'onPayload', 'reasoningEffort',
      'samplingParams', 'sessionId', 'temperature', 'thinkingBudgets', 'timeoutMs',
    ])
    expect(opts.headers['x-opencode-session']).toBe('s')
    expect(opts.headers['x-e']).toBe('1')
  })
})

describe('provider-compat 分支边界', () => {
  it('providerType 大小写不敏感：统一小写查表', () => {
    expect(getProviderCompat('OpenAI').sendSessionAffinityHeaders).toBe(true)
    expect(getProviderCompat('OPENAI').supportsStore).toBe(true)
    expect(getProviderCompat('openai').sendSessionAffinityHeaders).toBe(true)
  })

  it('空串 / undefined providerType 回退 DEFAULT', () => {
    expect(getProviderCompat('')).toEqual(getProviderCompat(undefined))
    expect(getProviderCompat(undefined).supportsStore).toBe(true)
  })

  it('modelId 为空串时不应用 modelOverrides', () => {
    expect(getProviderCompat('deepseek', '')).toBe(getProviderCompat('deepseek'))
    expect(getProviderCompat('deepseek', '')?.requiresReasoningContentOnAssistantMessages).toBeUndefined()
  })

  it('modelOverrides 正则大小写不敏感', () => {
    expect(getProviderCompat('deepseek', 'DeepSeek-Reasoner').requiresReasoningContentOnAssistantMessages).toBe(true)
    expect(getProviderCompat('moonshot', 'KIMI-K2.6').thinkingFormat).toBe('deepseek')
    expect(getProviderCompat('moonshot', 'kimi-k3-turbo').supportsReasoningEffort).toBe(true)
  })

  it('modelOverrides 首个命中生效（K3 优先于 K2 规则）', () => {
    const k3 = getProviderCompat('moonshot', 'kimi-k3')
    expect(k3.thinkingFormat).toBeUndefined()
    expect(k3.requiresReasoningContentOnAssistantMessages).toBe(true)
  })

  it('resolveReasoningEffort：alwaysReasoning provider 未开启思考时返回默认强度，显式级别优先', () => {
    expect(resolveReasoningEffort('opencode-go', undefined, undefined)).toBe('low')
    expect(resolveReasoningEffort('opencode-go', 'any', 'medium')).toBe('medium')
    expect(resolveReasoningEffort('deepseek', 'deepseek-reasoner', false)).toBe(false)
    expect(resolveReasoningEffort(undefined, undefined, false)).toBe(false)
  })

  it('getProviderExtraRequestHeaders：无模板返回 undefined；空 sessionId 跳过占位头', () => {
    expect(getProviderExtraRequestHeaders('unknown', undefined, 's')).toBeUndefined()
    expect(getProviderExtraRequestHeaders('opencode-go', undefined, '')).toEqual({ 'x-opencode-client': 'workavatar' })
  })

  it('getProviderExtraRequestHeaders 每次返回新对象，调用方修改不污染模板', () => {
    const first = getProviderExtraRequestHeaders('opencode-go', undefined, 's1')!
    first['x-injected'] = 'yes'
    const second = getProviderExtraRequestHeaders('opencode-go', undefined, 's1')!
    expect(second['x-injected']).toBeUndefined()
    expect(second).toEqual({ 'x-opencode-client': 'workavatar', 'x-opencode-session': 's1' })
  })

  it('getProviderCompat 返回对象可安全用于读取（含 modelOverrides 的浅拷贝语义）', () => {
    const base = getProviderCompat('deepseek')
    const patched = getProviderCompat('deepseek', 'deepseek-reasoner')
    expect(base.requiresReasoningContentOnAssistantMessages).toBeUndefined()
    expect(patched.requiresReasoningContentOnAssistantMessages).toBe(true)
    expect(patched.modelOverrides).toBe(base.modelOverrides) // 浅合并，未命中字段共享引用
  })
})
