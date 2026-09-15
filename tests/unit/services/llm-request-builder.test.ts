/**
 * LLM 请求构建纯函数单测：模型配置解析 / 模型名解析 / 请求头构建 / JSON 对象解析。
 * 全部为无副作用纯函数，重点覆盖非法输入与优先级覆盖分支。
 */
import { describe, it, expect } from 'vitest'
import {
  getModelConfig,
  resolveModelName,
  buildHeaders,
  parseJsonRecord,
} from '../../../electron/main/services/llm-request-builder'
import type { LLMProviderConfig } from '../../../electron/main/services/llm-client-types'

function provider(overrides: Partial<LLMProviderConfig> = {}): LLMProviderConfig {
  return {
    id: 'p1',
    name: 'Provider',
    provider_type: 'openai',
    base_url: 'https://api.example.com',
    model: 'fallback-model',
    api_key: 'sk-123',
    models_json: '[]',
    ...overrides,
  } as LLMProviderConfig
}

describe('llm-request-builder / getModelConfig', () => {
  it('无 models_json 或空串返回 null', () => {
    expect(getModelConfig(provider({ models_json: undefined as any }), 'gpt')).toBeNull()
    expect(getModelConfig(provider({ models_json: '' }), 'gpt')).toBeNull()
  })

  it('models_json 非法 JSON 时返回 null 不抛错', () => {
    expect(getModelConfig(provider({ models_json: '{ not json' }), 'gpt')).toBeNull()
  })

  it('优先按 id 命中，其次按 model 命中', () => {
    const cfg = provider({
      models_json: JSON.stringify([
        { id: 'alias', model: 'gpt-4o' },
        { id: 'other', model: 'alias' },
      ]),
    })
    expect(getModelConfig(cfg, 'alias')?.model).toBe('gpt-4o')
    expect(getModelConfig(cfg, 'gpt-4o')?.id).toBe('alias')
  })

  it('空数组 / 未命中返回 null', () => {
    expect(getModelConfig(provider({ models_json: '[]' }), 'gpt')).toBeNull()
    expect(getModelConfig(provider({ models_json: JSON.stringify([{ id: 'a', model: 'b' }]) }), 'zzz')).toBeNull()
  })

  it('models_json 为 JSON 对象（非数组）时 find 不存在返回 null 不抛错', () => {
    expect(getModelConfig(provider({ models_json: '{"id":"a"}' }), 'a')).toBeNull()
  })
})

describe('llm-request-builder / resolveModelName', () => {
  it('按 id 命中时返回真实 API 模型名', () => {
    const cfg = provider({ models_json: JSON.stringify([{ id: 'alias', model: 'gpt-4o-mini' }]) })
    expect(resolveModelName(cfg, 'alias')).toBe('gpt-4o-mini')
  })

  it('未命中 / 无 models_json / 非法 JSON 时原样返回标识符', () => {
    expect(resolveModelName(provider({ models_json: JSON.stringify([{ id: 'a', model: 'b' }]) }), 'x')).toBe('x')
    expect(resolveModelName(provider({ models_json: '' }), 'x')).toBe('x')
    expect(resolveModelName(provider({ models_json: 'oops' }), 'x')).toBe('x')
  })

  it('仅按 id 匹配（不按 model 反查），与 getModelConfig 语义不同', () => {
    const cfg = provider({ models_json: JSON.stringify([{ id: 'alias', model: 'gpt-4o' }]) })
    expect(resolveModelName(cfg, 'gpt-4o')).toBe('gpt-4o')
  })
})

describe('llm-request-builder / buildHeaders', () => {
  it('默认仅 Content-Type', () => {
    expect(buildHeaders(provider({ api_key: undefined as any }))).toEqual({
      'Content-Type': 'application/json',
    })
  })

  it('有 api_key 时追加 Authorization Bearer', () => {
    expect(buildHeaders(provider({ api_key: 'sk-abc' })).Authorization).toBe('Bearer sk-abc')
  })

  it('extra_headers_json 合并进请求头', () => {
    const headers = buildHeaders(
      provider({ extra_headers_json: JSON.stringify({ 'X-Trace': '1' }) })
    )
    expect(headers['X-Trace']).toBe('1')
    expect(headers.Authorization).toBe('Bearer sk-123')
  })

  it('extra_headers_json 可覆盖默认头（含 Authorization）', () => {
    const headers = buildHeaders(
      provider({
        extra_headers_json: JSON.stringify({
          'Content-Type': 'application/x-www-form-urlencoded',
          Authorization: 'Basic xyz',
        }),
      })
    )
    expect(headers['Content-Type']).toBe('application/x-www-form-urlencoded')
    expect(headers.Authorization).toBe('Basic xyz')
  })

  it('extra_headers_json 非法 JSON 时忽略，不影响默认头', () => {
    expect(buildHeaders(provider({ extra_headers_json: '{bad' }))).toEqual({
      'Content-Type': 'application/json',
      Authorization: 'Bearer sk-123',
    })
  })

  it('extra_headers_json 为 JSON 数组时下标会被当作请求头键（宽松解析，默认头不被覆盖）', () => {
    const headers = buildHeaders(provider({ extra_headers_json: '[1,2]' }))
    expect(headers['Content-Type']).toBe('application/json')
    expect(headers.Authorization).toBe('Bearer sk-123')
    // Object.assign 会把数组下标一并拷入，暴露调用方传入非对象时的行为
    expect(headers['0']).toBe(1)
  })
})

describe('llm-request-builder / parseJsonRecord', () => {
  it('空值返回 undefined', () => {
    expect(parseJsonRecord(undefined)).toBeUndefined()
    expect(parseJsonRecord(null)).toBeUndefined()
    expect(parseJsonRecord('')).toBeUndefined()
  })

  it('合法对象返回解析结果', () => {
    expect(parseJsonRecord('{"a":1}')).toEqual({ a: 1 })
    expect(parseJsonRecord('{}')).toEqual({})
  })

  it('数组与标量视为非法（非对象）', () => {
    expect(parseJsonRecord('[1,2]')).toBeUndefined()
    expect(parseJsonRecord('5')).toBeUndefined()
    expect(parseJsonRecord('"str"')).toBeUndefined()
    expect(parseJsonRecord('null')).toBeUndefined()
  })

  it('非法 JSON 返回 undefined', () => {
    expect(parseJsonRecord('{oops')).toBeUndefined()
  })
})
