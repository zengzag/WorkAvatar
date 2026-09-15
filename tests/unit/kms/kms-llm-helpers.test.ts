import { describe, it, expect, vi, beforeEach } from 'vitest'

const state = vi.hoisted(() => ({
  provider: null as any,
  createCalls: [] as Array<{ providerId: string; modelId?: string }>,
  chatCalls: [] as Array<{ messages: any[]; tools: any[]; options: any }>,
  content: '',
  chatError: null as any,
}))

vi.mock('../../../electron/main/services/agent/llm/pi-provider-factory', () => ({
  createPiProvider: async (providerId: string, modelId?: string) => {
    state.createCalls.push({ providerId, modelId })
    return state.provider
  },
}))

import { callLLMForJSON } from '../../../electron/main/services/kms/kms-llm-helpers'

const messages = [{ role: 'system' as const, content: 'sys' }, { role: 'user' as const, content: 'usr' }]

function installProvider() {
  state.provider = {
    chat: async (msgs: any[], tools: any[], options: any) => {
      state.chatCalls.push({ messages: msgs, tools, options })
      if (state.chatError) throw state.chatError
      return { content: state.content }
    },
  }
}

beforeEach(() => {
  state.provider = null
  state.createCalls.length = 0
  state.chatCalls.length = 0
  state.content = ''
  state.chatError = null
})

describe('kms-llm-helpers / 正常路径', () => {
  it('解析 JSON 响应并透传 messages 与空 tools', async () => {
    installProvider()
    state.content = '{"a":1,"b":[2]}'
    const out = await callLLMForJSON('p1', 'm1', messages, { a: 0, b: [] })
    expect(out).toEqual({ a: 1, b: [2] })
    expect(state.createCalls).toEqual([{ providerId: 'p1', modelId: 'm1' }])
    expect(state.chatCalls[0].messages).toBe(messages)
    expect(state.chatCalls[0].tools).toEqual([])
  })

  it('```json 围栏与前后噪声文本可被容错解析', async () => {
    installProvider()
    state.content = '结果如下：\n```json\n{"a":1}\n```\n以上'
    expect(await callLLMForJSON('p1', undefined, messages, null)).toEqual({ a: 1 })
  })

  it('modelId 为 undefined 时原样透传给 provider 工厂', async () => {
    installProvider()
    state.content = '{}'
    await callLLMForJSON('p1', undefined, messages, null)
    expect(state.createCalls[0]).toEqual({ providerId: 'p1', modelId: undefined })
  })

  it('内容非法时返回 fallback（同一引用）', async () => {
    installProvider()
    state.content = 'not json'
    const fallback = { fb: true }
    expect(await callLLMForJSON('p1', undefined, messages, fallback)).toBe(fallback)
  })
})

describe('kms-llm-helpers / 请求参数透传', () => {
  it('temperature/maxTokens 为 0 时仍透传（!== undefined 判断）', async () => {
    installProvider()
    state.content = '{}'
    await callLLMForJSON('p1', undefined, messages, null, { temperature: 0, maxTokens: 0 })
    expect(state.chatCalls[0].options).toMatchObject({ temperature: 0, maxTokens: 0 })
  })

  it('未提供可选参数时不出现在 options 中', async () => {
    installProvider()
    state.content = '{}'
    await callLLMForJSON('p1', undefined, messages, null)
    const options = state.chatCalls[0].options
    expect(options).not.toHaveProperty('temperature')
    expect(options).not.toHaveProperty('maxTokens')
    expect(options).not.toHaveProperty('signal')
    expect(options).not.toHaveProperty('logSource')
    expect(options).not.toHaveProperty('enableThinking')
  })

  it('signal/logSource 透传', async () => {
    installProvider()
    state.content = '{}'
    const controller = new AbortController()
    await callLLMForJSON('p1', undefined, messages, null, { signal: controller.signal, logSource: 'kms_test' })
    expect(state.chatCalls[0].options.signal).toBe(controller.signal)
    expect(state.chatCalls[0].options.logSource).toBe('kms_test')
  })

  it('enable_thinking 映射为 enableThinking，false 也透传', async () => {
    installProvider()
    state.content = '{}'
    await callLLMForJSON('p1', undefined, messages, null, { enable_thinking: false })
    expect(state.chatCalls[0].options.enableThinking).toBe(false)
    state.chatCalls.length = 0
    await callLLMForJSON('p1', undefined, messages, null, { enable_thinking: 'high' })
    expect(state.chatCalls[0].options.enableThinking).toBe('high')
  })
})

describe('kms-llm-helpers / 失败与错误处理', () => {
  it('provider 不存在时默认返回 fallback', async () => {
    state.provider = null
    const fallback = { summary: '' }
    expect(await callLLMForJSON('missing', undefined, messages, fallback)).toBe(fallback)
  })

  it('provider 不存在且 throwOnError 时抛默认错误信息', async () => {
    state.provider = null
    await expect(callLLMForJSON('missing', undefined, messages, null, { throwOnError: true }))
      .rejects.toThrow('LLM call failed: LLM Provider not found')
  })

  it('chat 抛 Error 时默认返回 fallback', async () => {
    installProvider()
    state.chatError = new Error('boom')
    const fallback = { ok: false }
    expect(await callLLMForJSON('p1', undefined, messages, fallback)).toBe(fallback)
  })

  it('chat 抛 Error 且 throwOnError 时使用默认错误信息', async () => {
    installProvider()
    state.chatError = new Error('boom')
    await expect(callLLMForJSON('p1', undefined, messages, null, { throwOnError: true }))
      .rejects.toThrow('LLM call failed: boom')
  })

  it('自定义 errorMessage 可覆盖错误信息', async () => {
    installProvider()
    state.chatError = new Error('boom')
    await expect(callLLMForJSON('p1', undefined, messages, null, {
      throwOnError: true,
      errorMessage: (err) => `自定义: ${(err as Error).message}`,
    })).rejects.toThrow('自定义: boom')
  })

  it('抛出非 Error 对象时错误信息为 Unknown error', async () => {
    installProvider()
    state.chatError = 'string error'
    await expect(callLLMForJSON('p1', undefined, messages, null, { throwOnError: true }))
      .rejects.toThrow('LLM call failed: Unknown error')
  })

  it('调用方未传 throwOnError 时不抛出（默认吞掉异常）', async () => {
    installProvider()
    state.chatError = new Error('boom')
    await expect(callLLMForJSON('p1', undefined, messages, { fb: 1 })).resolves.toEqual({ fb: 1 })
  })
})
