import { describe, it, expect, vi, beforeEach } from 'vitest'

const state = vi.hoisted(() => ({
  provider: null as any,
  chatCalls: [] as Array<{ messages: any[]; options: any }>,
  content: '',
  chatError: null as any,
  onChat: null as null | (() => void),
  collection: undefined as any,
  files: [] as any[],
  summaryRow: undefined as any,
  calls: [] as Array<{ sql: string; args: any[] }>,
}))

vi.mock('../../../electron/main/services/agent/llm/pi-provider-factory', () => ({
  createPiProvider: async () => state.provider,
}))

import {
  generateCollectionSummary,
  saveCollectionSummary,
} from '../../../electron/main/services/kms/kms-collection-llm-helpers'

const db = {
  prepare: (sql: string) => {
    const normalized = sql.replace(/\s+/g, ' ').trim()
    const record = (args: any[]) => state.calls.push({ sql: normalized, args })
    if (normalized.startsWith('SELECT id, name, description FROM kms_collections')) {
      return { get: (id: string) => { record([id]); return state.collection } }
    }
    if (normalized.includes('kms_file_collections')) {
      return { all: (id: string) => { record([id]); return state.files } }
    }
    if (normalized.startsWith('SELECT id FROM kms_collection_summaries')) {
      return { get: (id: string) => { record([id]); return state.summaryRow } }
    }
    return { run: (...args: any[]) => { record(args); return { changes: 1 } } }
  },
} as any

const llmConfig = { providerId: 'p1', modelId: 'm1', enableThinking: false } as any

function installProvider() {
  state.provider = {
    chat: async (msgs: any[], _tools: any[], options: any) => {
      state.chatCalls.push({ messages: msgs, options })
      state.onChat?.()
      if (state.chatError) throw state.chatError
      return { content: state.content }
    },
  }
}

beforeEach(() => {
  state.provider = null
  state.chatCalls.length = 0
  state.content = ''
  state.chatError = null
  state.onChat = null
  state.collection = { id: 'c1', name: '合集名', description: '描述' }
  state.files = [{ id: 'f1', file_name: 'a.md', light_summary: '摘要A', summary: '' }]
  state.summaryRow = undefined
  state.calls.length = 0
})

describe('kms-collection-llm-helpers / generateCollectionSummary', () => {
  it('合集不存在时返回错误且不调用 LLM', async () => {
    state.collection = undefined
    expect(await generateCollectionSummary(db, 'missing', llmConfig)).toEqual({ error: 'Collection not found' })
    expect(state.chatCalls).toHaveLength(0)
  })

  it('进入时已中断返回 ABORTED', async () => {
    const controller = new AbortController()
    controller.abort()
    expect(await generateCollectionSummary(db, 'c1', llmConfig, controller.signal)).toEqual({ error: 'ABORTED' })
    expect(state.chatCalls).toHaveLength(0)
    expect(state.calls).toHaveLength(1) // 仅查询了合集本身
  })

  it('合集内无文件返回 NO_FILES', async () => {
    state.files = []
    expect(await generateCollectionSummary(db, 'c1', llmConfig)).toEqual({ error: 'NO_FILES' })
    expect(state.chatCalls).toHaveLength(0)
  })

  it('成功时返回 trim 后的摘要与主题词，主题词最多 8 个', async () => {
    installProvider()
    state.content = JSON.stringify({
      summary: '  合集摘要  ',
      keyTopics: ['t1', 't2', 't3', 't4', 't5', 't6', 't7', 't8', 't9', 't10'],
    })
    const out = await generateCollectionSummary(db, 'c1', llmConfig)
    expect(out).toEqual({ summary: '合集摘要', keyTopics: ['t1', 't2', 't3', 't4', 't5', 't6', 't7', 't8'] })
  })

  it('keyTopics 非数组时回落为空数组', async () => {
    installProvider()
    state.content = '{"summary":"S","keyTopics":"not-array"}'
    expect(await generateCollectionSummary(db, 'c1', llmConfig)).toEqual({ summary: 'S', keyTopics: [] })
  })

  it('keyTopics 中非字符串项被转换、空白项被过滤', async () => {
    installProvider()
    state.content = JSON.stringify({ summary: 'S', keyTopics: [1, '  ', '  有效  ', null, 'x'] })
    expect(await generateCollectionSummary(db, 'c1', llmConfig)).toEqual({ summary: 'S', keyTopics: ['1', '有效', 'null', 'x'] })
  })

  it('摘要为空/纯空白时返回错误', async () => {
    installProvider()
    state.content = '{"summary":"   ","keyTopics":[]}'
    expect(await generateCollectionSummary(db, 'c1', llmConfig)).toEqual({ error: 'LLM returned empty summary' })
  })

  it('LLM 返回非法 JSON 时按空摘要处理', async () => {
    installProvider()
    state.content = 'not json'
    expect(await generateCollectionSummary(db, 'c1', llmConfig)).toEqual({ error: 'LLM returned empty summary' })
  })

  it('输入摘要超过 12000 字时截断并标注省略数量', async () => {
    installProvider()
    state.files = Array.from({ length: 5 }, (_, i) => ({
      id: `f${i}`,
      file_name: `file${i}`,
      light_summary: 'x'.repeat(3000),
      summary: '',
    }))
    state.content = '{"summary":"S","keyTopics":[]}'
    await generateCollectionSummary(db, 'c1', llmConfig)
    const prompt: string = state.chatCalls[0].messages[1].content
    expect(prompt).toContain('...（其余 2 个文件省略）')
    expect(prompt).toContain('文件数量：5')
  })

  it('light_summary 缺失时回退 summary 字段', async () => {
    installProvider()
    state.files = [{ id: 'f1', file_name: 'a.md', light_summary: '', summary: '完整摘要' }]
    state.content = '{"summary":"S"}'
    await generateCollectionSummary(db, 'c1', llmConfig)
    expect(state.chatCalls[0].messages[1].content).toContain('【a.md】 完整摘要')
  })

  it('LLM 调用抛错时返回真实错误信息（不再退化为空摘要报错）', async () => {
    installProvider()
    state.chatError = new Error('llm down')
    expect(await generateCollectionSummary(db, 'c1', llmConfig)).toEqual({ error: 'LLM call failed: llm down' })
  })

  it('AbortError 且无 signal 时按真实错误返回（signal 中断路径见下条）', async () => {
    installProvider()
    const err = new Error('aborted')
    err.name = 'AbortError'
    state.chatError = err
    expect(await generateCollectionSummary(db, 'c1', llmConfig)).toEqual({ error: 'LLM call failed: aborted' })
  })

  it('LLM 返回后信号已中断则不采用结果', async () => {
    installProvider()
    const controller = new AbortController()
    state.onChat = () => controller.abort()
    state.content = '{"summary":"S"}'
    expect(await generateCollectionSummary(db, 'c1', llmConfig, controller.signal)).toEqual({ error: 'ABORTED' })
  })

  it('enableThinking 配置映射为 high', async () => {
    installProvider()
    state.content = '{"summary":"S"}'
    await generateCollectionSummary(db, 'c1', { ...llmConfig, enableThinking: true })
    expect(state.chatCalls[0].options.enableThinking).toBe('high')
  })

  it('未开启 thinking 时透传 false', async () => {
    installProvider()
    state.content = '{"summary":"S"}'
    await generateCollectionSummary(db, 'c1', llmConfig)
    expect(state.chatCalls[0].options.enableThinking).toBe(false)
  })
})

describe('kms-collection-llm-helpers / saveCollectionSummary', () => {
  it('已存在记录时更新', () => {
    state.summaryRow = { id: 'row-1' }
    saveCollectionSummary(db, 'c1', '摘要', ['t1'])
    const update = state.calls.find(c => c.sql.startsWith('UPDATE kms_collection_summaries'))!
    expect(update).toBeTruthy()
    expect(update.args).toEqual(['摘要', '["t1"]', 'c1'])
    expect(state.calls.some(c => c.sql.startsWith('INSERT'))).toBe(false)
  })

  it('无记录时插入并生成 24 位十六进制 id', () => {
    state.summaryRow = undefined
    saveCollectionSummary(db, 'c1', '摘要', ['t1', 't2'])
    const insert = state.calls.find(c => c.sql.startsWith('INSERT INTO kms_collection_summaries'))!
    expect(insert).toBeTruthy()
    expect(insert.args[0]).toMatch(/^[0-9a-f]{24}$/)
    expect(insert.args.slice(1)).toEqual(['c1', '摘要', '["t1","t2"]'])
  })

  it('keyTopics 缺省时存空数组', () => {
    saveCollectionSummary(db, 'c1', '摘要')
    const insert = state.calls.find(c => c.sql.startsWith('INSERT INTO kms_collection_summaries'))!
    expect(insert.args[3]).toBe('[]')
  })
})
