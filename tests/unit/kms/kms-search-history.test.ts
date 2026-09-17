import { describe, it, expect, vi, beforeEach } from 'vitest'

const state = vi.hoisted(() => ({
  calls: [] as Array<{ sql: string; args: any[] }>,
  existing: undefined as any,
  rows: [] as any[],
}))

vi.mock('../../../electron/main/services/kms/kms-database.service', () => ({
  default: {
    getInstance: () => ({
      getDb: () => ({
        prepare: (sql: string) => {
          const normalized = sql.replace(/\s+/g, ' ').trim()
          const record = (args: any[]) => state.calls.push({ sql: normalized, args })
          return {
            get: (...args: any[]) => { record(args); return state.existing },
            all: (...args: any[]) => { record(args); return state.rows },
            run: (...args: any[]) => { record(args); return { changes: 1 } },
          }
        },
      }),
    }),
  },
}))

import KMSSearchHistoryService from '../../../electron/main/services/kms/kms-search-history.service'

const history = KMSSearchHistoryService.getInstance()

const insertCall = () => state.calls.find(c => c.sql.startsWith('INSERT INTO kms_search_history'))
const updateCall = () => state.calls.find(c => c.sql.startsWith('UPDATE kms_search_history'))
const selectCall = () => state.calls.find(c => c.sql.startsWith('SELECT id FROM kms_search_history'))

beforeEach(() => {
  state.calls.length = 0
  state.existing = undefined
  state.rows = []
})

describe('kms-search-history / recordSearchHistory', () => {
  it('无同 query 记录时插入新行，filters 缺省存 {}', () => {
    history.recordSearchHistory({ query: '知识库', searchMode: 'hybrid', resultCount: 3 })
    const insert = insertCall()!
    expect(insert).toBeTruthy()
    expect(updateCall()).toBeUndefined()
    expect(insert.args).toHaveLength(5)
    expect(insert.args[1]).toBe('知识库')
    expect(insert.args[2]).toBe('hybrid')
    expect(insert.args[3]).toBe(3)
    expect(insert.args[4]).toBe('{}')
    expect(insert.args[0]).toMatch(/^[0-9a-f]{24}$/)
  })

  it('filters 提供时序列化为 JSON', () => {
    history.recordSearchHistory({
      query: 'q',
      searchMode: 'keyword',
      resultCount: 0,
      filters: { fileTypes: ['.md'], nested: { a: 1 } },
    })
    expect(insertCall()!.args[4]).toBe('{"fileTypes":[".md"],"nested":{"a":1}}')
  })

  it('已存在同 query 记录时更新而非插入', () => {
    state.existing = { id: 'row-1' }
    history.recordSearchHistory({ query: '知识库', searchMode: 'vector', resultCount: 9 })
    expect(insertCall()).toBeUndefined()
    const update = updateCall()!
    expect(update.args).toEqual(['vector', 9, '{}', 'row-1'])
    expect(selectCall()!.args).toEqual(['知识库'])
  })

  it('filters 为空对象时仍序列化', () => {
    state.existing = { id: 'row-1' }
    history.recordSearchHistory({ query: 'q', searchMode: 'm', resultCount: 1, filters: {} })
    expect(updateCall()!.args[2]).toBe('{}')
  })

  it('空 query 仍会插入（无空值校验）', () => {
    history.recordSearchHistory({ query: '', searchMode: 'hybrid', resultCount: 0 })
    expect(insertCall()!.args[1]).toBe('')
  })

  it('resultCount 为负数/极大值时原样写入', () => {
    history.recordSearchHistory({ query: 'a', searchMode: 'm', resultCount: -1 })
    expect(insertCall()!.args[3]).toBe(-1)
    state.calls.length = 0
    history.recordSearchHistory({ query: 'b', searchMode: 'm', resultCount: Number.MAX_SAFE_INTEGER })
    expect(insertCall()!.args[3]).toBe(Number.MAX_SAFE_INTEGER)
  })
})

describe('kms-search-history / getSearchHistory', () => {
  it('默认 limit 50 且无 WHERE 过滤', () => {
    history.getSearchHistory()
    const call = state.calls[0]
    expect(call.sql).toBe('SELECT id, query, search_mode, result_count, created_at FROM kms_search_history ORDER BY created_at DESC LIMIT ?')
    expect(call.args).toEqual([50])
  })

  it('searchMode 生成过滤条件', () => {
    history.getSearchHistory({ searchMode: 'hybrid' })
    const call = state.calls[0]
    expect(call.sql).toContain('WHERE search_mode = ?')
    expect(call.args).toEqual(['hybrid', 50])
  })

  it('limit 0 回退为默认 50（falsy 判断）', () => {
    history.getSearchHistory({ limit: 0 })
    expect(state.calls[0].args).toEqual([50])
  })

  it('limit 负数被夹到 1，超过 500 被夹到 500', () => {
    history.getSearchHistory({ limit: -3 })
    expect(state.calls[0].args).toEqual([1])
    state.calls.length = 0
    history.getSearchHistory({ limit: 1000 })
    expect(state.calls[0].args).toEqual([500])
  })

  it('searchMode 为空串时不生成过滤条件', () => {
    history.getSearchHistory({ searchMode: '' })
    expect(state.calls[0].sql).not.toContain('WHERE')
  })

  it('结果原样透传', () => {
    state.rows = [{ id: '1', query: 'q' }]
    expect(history.getSearchHistory()).toEqual([{ id: '1', query: 'q' }])
  })
})

describe('kms-search-history / clearSearchHistory 与 deleteSearchHistory', () => {
  it('不传 searchMode 时清空全表', () => {
    history.clearSearchHistory()
    expect(state.calls[0].sql).toBe('DELETE FROM kms_search_history')
    expect(state.calls[0].args).toEqual([])
  })

  it('传 searchMode 时按模式删除', () => {
    history.clearSearchHistory('keyword')
    expect(state.calls[0].sql).toBe('DELETE FROM kms_search_history WHERE search_mode = ?')
    expect(state.calls[0].args).toEqual(['keyword'])
  })

  it('searchMode 为空串时退化为清空全表', () => {
    history.clearSearchHistory('')
    expect(state.calls[0].sql).toBe('DELETE FROM kms_search_history')
  })

  it('按 id 删除单条', () => {
    history.deleteSearchHistory('id-1')
    expect(state.calls[0].sql).toBe('DELETE FROM kms_search_history WHERE id = ?')
    expect(state.calls[0].args).toEqual(['id-1'])
  })
})
