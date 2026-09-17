import { describe, it, expect, vi, beforeEach } from 'vitest'

const h = vi.hoisted(() => ({
  config: null as any,
  baseURL: 'https://base.example/v1',
  getProviderConfigCalls: 0,
}))

vi.mock('../../../electron/main/services/llm-client.service', () => ({
  default: {
    getInstance: () => ({
      getProviderConfig: async (id: string) => {
        h.getProviderConfigCalls++
        return h.config ? { ...h.config, id } : null
      },
      getBaseURL: () => h.baseURL,
    }),
  },
}))

import { createPiProvider } from '../../../electron/main/services/agent/llm/pi-provider-factory'

const providerConfig = (over: Record<string, any> = {}) => ({
  id: 'p1',
  name: '测试供应商',
  provider_type: 'openai',
  base_url: 'https://api.example/v1',
  model: 'gpt-4o',
  temperature: 0.7,
  max_tokens: 4096,
  timeout_ms: 60000,
  api_key: 'sk-test',
  extra_headers_json: undefined,
  extra_body_json: undefined,
  models_json: undefined,
  ...over,
})

beforeEach(() => {
  h.config = null
  h.baseURL = 'https://base.example/v1'
  h.getProviderConfigCalls = 0
})

describe('agent/llm/pi-provider-factory', () => {
  it('供应商不存在时返回 null', async () => {
    expect(await createPiProvider('missing')).toBeNull()
    expect(h.getProviderConfigCalls).toBe(1)
  })

  it('模型名为空时抛出含供应商信息的错误', async () => {
    h.config = providerConfig({ model: '', models_json: undefined })
    await expect(createPiProvider('p1')).rejects.toThrow(/Model name is empty for provider "测试供应商" \(p1\)/)
  })

  it('显式传入的 modelId 覆盖默认模型', async () => {
    h.config = providerConfig()
    const provider: any = await createPiProvider('p1', 'gpt-4o-mini')
    expect(provider.getConfig().model).toBe('gpt-4o-mini')
  })

  it('models_json 中的 id 解析为实际模型名；未命中则原样透传', async () => {
    h.config = providerConfig({
      models_json: JSON.stringify([{ id: 'm-1', model: 'gpt-4o-2024-11-20' }]),
    })
    const mapped: any = await createPiProvider('p1', 'm-1')
    expect(mapped.getConfig().model).toBe('gpt-4o-2024-11-20')

    const passthrough: any = await createPiProvider('p1', 'not-listed')
    expect(passthrough.getConfig().model).toBe('not-listed')
  })

  it('models_json 非法 JSON 时不抛错，模型名原样透传', async () => {
    h.config = providerConfig({ models_json: '{not-json' })
    const provider: any = await createPiProvider('p1', 'gpt-4o')
    expect(provider.getConfig().model).toBe('gpt-4o')
  })

  it('defaultOptions：模型级配置优先，缺失时回退供应商级，enableThinking 兜底 false', async () => {
    h.config = providerConfig({
      models_json: JSON.stringify([{
        id: 'm-1', model: 'gpt-4o-mini',
        temperature: 0.1, max_tokens: 128, enable_thinking: 'high',
        top_p: 0.5, frequency_penalty: 0.2, presence_penalty: 0.3, thinking_budget: 2048,
      }]),
    })
    const provider: any = await createPiProvider('p1', 'm-1')
    expect(provider.getConfig().defaultOptions).toEqual({
      temperature: 0.1,
      maxTokens: 128,
      enableThinking: 'high',
      topP: 0.5,
      frequencyPenalty: 0.2,
      presencePenalty: 0.3,
      thinkingBudget: 2048,
      timeoutMs: 60000,
      extraHeaders: undefined,
      extraBody: undefined,
    })
  })

  it('模型配置缺省时回退供应商级 temperature / max_tokens，enableThinking 为 false', async () => {
    h.config = providerConfig({
      models_json: JSON.stringify([{ id: 'm-2', model: 'gpt-4o-mini' }]),
    })
    const provider: any = await createPiProvider('p1', 'm-2')
    const opts = provider.getConfig().defaultOptions
    expect(opts.temperature).toBe(0.7)
    expect(opts.maxTokens).toBe(4096)
    expect(opts.enableThinking).toBe(false)
    expect(opts.topP).toBeUndefined()
  })

  it('baseUrl / providerType / apiKey 透传；extra_headers_json / extra_body_json 解析为对象', async () => {
    h.baseURL = 'https://resolved.example/v1'
    h.config = providerConfig({
      extra_headers_json: '{"x-h":"1"}',
      extra_body_json: '{"foo":"bar"}',
    })
    const provider: any = await createPiProvider('p1')
    const cfg = provider.getConfig()
    expect(cfg.baseUrl).toBe('https://resolved.example/v1')
    expect(cfg.providerType).toBe('openai')
    expect(cfg.apiKey).toBe('sk-test')
    expect(cfg.defaultOptions.extraHeaders).toEqual({ 'x-h': '1' })
    expect(cfg.defaultOptions.extraBody).toEqual({ foo: 'bar' })
  })

  it('extra_headers_json 为数组 / 标量 / 非法 JSON 时解析为 undefined', async () => {
    for (const raw of ['[1,2]', '"str"', 'not-json', 'null', '']) {
      h.config = providerConfig({ extra_headers_json: raw, extra_body_json: raw })
      const provider: any = await createPiProvider('p1')
      expect(provider.getConfig().defaultOptions.extraHeaders).toBeUndefined()
      expect(provider.getConfig().defaultOptions.extraBody).toBeUndefined()
    }
  })

  it('provider 无 api_key 时 providerType 仍透传（缺省 provider_type 为 undefined）', async () => {
    h.config = providerConfig({ api_key: undefined, provider_type: undefined })
    const provider: any = await createPiProvider('p1')
    expect(provider.getConfig().apiKey).toBeUndefined()
    expect(provider.getConfig().providerType).toBeUndefined()
  })
})
