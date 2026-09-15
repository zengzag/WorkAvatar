import { describe, it, expect, vi, beforeEach } from 'vitest'

const state = vi.hoisted(() => ({
  calls: [] as Array<{ sql: string; args: any[] }>,
  rows: new Map<string, any>(),
  listRows: [] as any[],
  hotRows: [] as any[],
  stopWords: new Set<string>(),
  idfFilter: false,
  idfCalls: 0,
}))

vi.mock('../../../electron/main/services/kms/kms-database.service', () => ({
  default: {
    getInstance: () => ({
      getDb: () => ({
        prepare: (sql: string) => {
          const normalized = sql.replace(/\s+/g, ' ').trim()
          const record = (args: any[]) => state.calls.push({ sql: normalized, args })
          if (normalized.startsWith('SELECT id, search_count FROM kms_keyword_stats')) {
            return { get: (kw: string) => { record([kw]); return state.rows.get(kw) } }
          }
          if (normalized.startsWith('UPDATE kms_keyword_stats')) {
            return { run: (...args: any[]) => { record(args); return { changes: 1 } } }
          }
          if (normalized.startsWith('INSERT INTO kms_keyword_stats')) {
            return { run: (...args: any[]) => { record(args); return { changes: 1 } } }
          }
          if (normalized.startsWith('DELETE FROM kms_keyword_stats')) {
            return { run: (...args: any[]) => { record(args); return { changes: 2 } } }
          }
          if (normalized.includes('result_file_ids_json')) {
            return { all: (...args: any[]) => { record(args); return state.hotRows } }
          }
          return { all: (...args: any[]) => { record(args); return state.listRows } }
        },
      }),
    }),
  },
}))

vi.mock('../../../electron/main/services/kms/kms-stop-words.service', () => ({
  default: {
    getInstance: () => ({
      isStopWord: (w: string) => state.stopWords.has(w),
      evaluateIdfAndCache: (_w: string) => {
        state.idfCalls++
        return { shouldFilter: state.idfFilter, reason: state.idfFilter ? 'low_idf' : undefined }
      },
    }),
  },
}))

import KMSKeywordStatsService from '../../../electron/main/services/kms/kms-keyword-stats.service'

const stats = KMSKeywordStatsService.getInstance()

const findCall = (prefix: string) => state.calls.find(c => c.sql.startsWith(prefix))

beforeEach(() => {
  state.calls.length = 0
  state.rows = new Map()
  state.listRows = []
  state.hotRows = []
  state.stopWords = new Set()
  state.idfFilter = false
  state.idfCalls = 0
})

describe('kms-keyword-stats / normalizeKeyword', () => {
  it('trim + 压缩空白', () => {
    expect(stats.normalizeKeyword('  知识 库  ')).toBe('知识 库')
    expect(stats.normalizeKeyword('a  b')).toBe('a b')
  })

  it('大写英文被转小写（同一关键词不会因大小写落成两条记录）', () => {
    expect(stats.normalizeKeyword('ABC')).toBe('abc')
    expect(stats.normalizeKeyword('KMS')).toBe('kms')
    expect(stats.normalizeKeyword('中AB文')).toBe('中ab文')
    expect(stats.normalizeKeyword('KMS')).toBe(stats.normalizeKeyword('kms'))
  })

  it('已小写英文保持原样', () => {
    expect(stats.normalizeKeyword('abc')).toBe('abc')
  })

  it('全角/特殊空格转半角并压缩', () => {
    expect(stats.normalizeKeyword('知识\u3000库')).toBe('知识 库')
    expect(stats.normalizeKeyword('a\u2002\u2003b')).toBe('a b')
  })

  it('制表符与换行被压缩为空格', () => {
    expect(stats.normalizeKeyword('\t A\n b ')).toBe('a b')
  })

  it('空串与纯空白归一化为空串', () => {
    expect(stats.normalizeKeyword('')).toBe('')
    expect(stats.normalizeKeyword('   ')).toBe('')
  })

  it('全角字母保持原样', () => {
    expect(stats.normalizeKeyword('ＡＢＣ')).toBe('ＡＢＣ')
  })
})

describe('kms-keyword-stats / isValidKeyword', () => {
  it('长度不足 2 视为无效', () => {
    expect(stats.isValidKeyword('')).toBe(false)
    expect(stats.isValidKeyword(' ')).toBe(false)
    expect(stats.isValidKeyword('a')).toBe(false)
    expect(stats.isValidKeyword('!')).toBe(false)
  })

  it('内置停用词（含搜索修饰词）无效', () => {
    for (const w of ['的', '如何', '什么', '方法', '实现', '配置', 'the', 'THE', 'This']) {
      expect(stats.isValidKeyword(w), w).toBe(false)
    }
  })

  it('用户停用词表中的词无效', () => {
    state.stopWords.add('知识库')
    expect(stats.isValidKeyword('知识库')).toBe(false)
    expect(stats.isValidKeyword('管理')).toBe(true)
  })

  it('纯标点/符号无效', () => {
    expect(stats.isValidKeyword('！！')).toBe(false)
    expect(stats.isValidKeyword('，。')).toBe(false)
    expect(stats.isValidKeyword('!!!')).toBe(false)
  })

  it('普通中英文关键词有效', () => {
    expect(stats.isValidKeyword('知识库')).toBe(true)
    expect(stats.isValidKeyword('ab')).toBe(true)
    expect(stats.isValidKeyword('a1')).toBe(true)
    expect(stats.isValidKeyword('  知识  ')).toBe(true)
  })
})

describe('kms-keyword-stats / incrementKeywordStat', () => {
  it('空查询/纯空白不写库', () => {
    stats.incrementKeywordStat('')
    stats.incrementKeywordStat('   ')
    expect(state.calls).toHaveLength(0)
  })

  it('单关键词插入新记录：keyword 归一化小写，display_keyword 保留原始写法', () => {
    stats.incrementKeywordStat('  KMS  ')
    const insert = findCall('INSERT INTO kms_keyword_stats')!
    expect(insert).toBeTruthy()
    expect(insert.args).toHaveLength(6)
    expect(insert.args[1]).toBe('kms')
    expect(insert.args[2]).toBe('KMS')
    expect(insert.args[5]).toBe('[]')
    expect(insert.args[0]).toMatch(/^[0-9a-f]{24}$/)
  })

  it('时间戳以秒为单位写入 first/last_searched_at', () => {
    stats.incrementKeywordStat('知识库')
    const insert = findCall('INSERT INTO kms_keyword_stats')!
    expect(insert.args[1]).toBe('知识库')
    expect(insert.args[3]).toBeGreaterThan(1_600_000_000)
    expect(insert.args[3]).toBeLessThan(10_000_000_000)
    expect(insert.args[4]).toBe(insert.args[3] as number)
  })

  it('单关键词不做 IDF 过滤（仅多关键词路径调用）', () => {
    stats.incrementKeywordStat('知识库')
    expect(state.calls.some(c => c.sql.startsWith('INSERT'))).toBe(true)
    expect(state.idfCalls).toBe(0)
    state.calls.length = 0
    stats.incrementKeywordStat('知识库 管理系统')
    expect(state.idfCalls).toBe(2)
  })

  it('已存在记录时累加计数并更新', () => {
    state.rows.set('知识库', { id: 'row-1', search_count: 3 })
    stats.incrementKeywordStat('知识库')
    const update = findCall('UPDATE kms_keyword_stats')!
    expect(update).toBeTruthy()
    expect(update.sql).toContain('search_count = search_count + 1')
    expect(update.args).toHaveLength(3)
    expect(update.args[2]).toBe('row-1')
    expect(findCall('INSERT')).toBeUndefined()
  })

  it('命中文件ID最多保留 20 个', () => {
    const ids = Array.from({ length: 25 }, (_, i) => `f${i}`)
    stats.incrementKeywordStat('知识库', ids)
    const stored = JSON.parse(findCall('INSERT')!.args[5])
    expect(stored).toHaveLength(20)
    expect(stored[0]).toBe('f0')
    expect(stored[19]).toBe('f19')
  })

  it('命中文件ID为空数组时存 []', () => {
    stats.incrementKeywordStat('知识库')
    expect(findCall('INSERT')!.args[5]).toBe('[]')
  })

  it('多关键词按空格拆分后分别记录', () => {
    stats.incrementKeywordStat('知识库  管理系统', ['f1'])
    const inserts = state.calls.filter(c => c.sql.startsWith('INSERT'))
    expect(inserts).toHaveLength(2)
    expect(inserts.map(c => c.args[1])).toEqual(['知识库', '管理系统'])
    expect(inserts.map(c => c.args[2])).toEqual(['知识库', '管理系统'])
  })

  it('多关键词中的停用词与无效词被跳过', () => {
    state.stopWords.add('系统')
    stats.incrementKeywordStat('知识库 系统 的 !! 管理')
    const inserts = state.calls.filter(c => c.sql.startsWith('INSERT'))
    expect(inserts.map(c => c.args[1])).toEqual(['知识库', '管理'])
  })

  it('多关键词中 IDF 判定为通用词时跳过', () => {
    state.idfFilter = true
    stats.incrementKeywordStat('知识库 管理系统')
    expect(state.calls.filter(c => c.sql.startsWith('INSERT'))).toHaveLength(0)
  })

  it('幂等性：重复相同查询只累加计数不新增关键词', () => {
    stats.incrementKeywordStat('知识库')
    state.rows.set('知识库', { id: 'row-1', search_count: 1 })
    stats.incrementKeywordStat('知识库')
    expect(state.calls.filter(c => c.sql.startsWith('INSERT'))).toHaveLength(1)
    expect(state.calls.filter(c => c.sql.startsWith('UPDATE'))).toHaveLength(1)
  })
})

describe('kms-keyword-stats / getKeywordStats', () => {
  it('默认 minCount=1、limit=50、无时间过滤', () => {
    stats.getKeywordStats()
    const call = state.calls[0]
    expect(call.sql).not.toContain('last_searched_at >=' )
    expect(call.args).toEqual([1, 50])
  })

  it('minCount=0 被保留（nullish 判断）', () => {
    stats.getKeywordStats({ minCount: 0 })
    expect(state.calls[0].args).toEqual([0, 50])
  })

  it('limit 0 回退 50，负数夹到 1，超大夹到 500', () => {
    stats.getKeywordStats({ limit: 0 })
    expect(state.calls[0].args[1]).toBe(50)
    state.calls.length = 0
    stats.getKeywordStats({ limit: -5 })
    expect(state.calls[0].args[1]).toBe(1)
    state.calls.length = 0
    stats.getKeywordStats({ limit: 999 })
    expect(state.calls[0].args[1]).toBe(500)
  })

  it('recentDays 生成近 N 天时间阈值', () => {
    const before = Math.floor(Date.now() / 1000) - 3 * 86400
    stats.getKeywordStats({ recentDays: 3 })
    const after = Math.floor(Date.now() / 1000) - 3 * 86400
    const call = state.calls[0]
    expect(call.sql).toContain('last_searched_at >= ?')
    expect(call.args[1]).toBeGreaterThanOrEqual(before)
    expect(call.args[1]).toBeLessThanOrEqual(after)
    expect(call.args[2]).toBe(50)
  })

  it('recentDays=0 不生成时间过滤', () => {
    stats.getKeywordStats({ recentDays: 0 })
    expect(state.calls[0].sql).not.toContain('last_searched_at >=')
  })

  it('结果原样透传', () => {
    state.listRows = [{ keyword: 'a', search_count: 2 }]
    expect(stats.getKeywordStats()).toEqual([{ keyword: 'a', search_count: 2 }])
  })
})

describe('kms-keyword-stats / findHotKeywordsWithoutCards', () => {
  it('SQL 参数取 recentDays 与 min(threshold, boostThreshold)', () => {
    stats.findHotKeywordsWithoutCards(10, 30, 6)
    const call = state.calls[0]
    const now = Math.floor(Date.now() / 1000)
    expect(call.args[0]).toBeGreaterThanOrEqual(now - 30 * 86400 - 1)
    expect(call.args[0]).toBeLessThanOrEqual(now - 30 * 86400)
    expect(call.args[1]).toBe(6)
  })

  it('threshold 小于 boost 时取 threshold', () => {
    stats.findHotKeywordsWithoutCards(3, 30, 6)
    expect(state.calls[0].args[1]).toBe(3)
  })

  it('筛选达到常规阈值或近期 boost 阈值的行', () => {
    const now = Math.floor(Date.now() / 1000)
    state.hotRows = [
      { keyword: 'k1', display_keyword: 'K1', search_count: 10, last_searched_at: now, result_file_ids_json: '["f1"]' },
      { keyword: 'k2', display_keyword: 'K2', search_count: 7, last_searched_at: now, result_file_ids_json: '[]' },
      { keyword: 'k3', display_keyword: 'K3', search_count: 5, last_searched_at: now, result_file_ids_json: '[]' },
    ]
    const out = stats.findHotKeywordsWithoutCards(10, 30, 6)
    expect(out.map(r => r.keyword)).toEqual(['k1', 'k2'])
    expect(out[0]).toEqual({ keyword: 'k1', displayKeyword: 'K1', searchCount: 10, resultFileIds: ['f1'] })
  })

  it('近期 boost 已过期时不适用 boost 规则', () => {
    const now = Math.floor(Date.now() / 1000)
    state.hotRows = [
      { keyword: 'k1', display_keyword: 'K1', search_count: 7, last_searched_at: now - 8 * 86400, result_file_ids_json: '[]' },
    ]
    expect(stats.findHotKeywordsWithoutCards(10, 30, 6)).toEqual([])
  })

  it('result_file_ids_json 非法 JSON 时回退为空数组', () => {
    const now = Math.floor(Date.now() / 1000)
    state.hotRows = [
      { keyword: 'k1', display_keyword: 'K1', search_count: 20, last_searched_at: now, result_file_ids_json: '{bad json' },
      { keyword: 'k2', display_keyword: 'K2', search_count: 20, last_searched_at: now, result_file_ids_json: null },
    ]
    const out = stats.findHotKeywordsWithoutCards(10)
    expect(out[0].resultFileIds).toEqual([])
    expect(out[1].resultFileIds).toEqual([])
  })

  it('无候选行时返回空数组', () => {
    expect(stats.findHotKeywordsWithoutCards(10)).toEqual([])
  })
})

describe('kms-keyword-stats / 清理相关', () => {
  it('deleteKeywordStat 按关键词删除', () => {
    stats.deleteKeywordStat('知识库')
    expect(state.calls[0].sql).toBe('DELETE FROM kms_keyword_stats WHERE keyword = ?')
    expect(state.calls[0].args).toEqual(['知识库'])
  })

  it('cleanupStaleKeywordStats 返回变更条数并使用 90 天阈值', () => {
    const before = Math.floor(Date.now() / 1000) - 90 * 86400
    const changes = stats.cleanupStaleKeywordStats()
    const after = Math.floor(Date.now() / 1000) - 90 * 86400
    expect(changes).toBe(2)
    const call = state.calls[0]
    expect(call.sql).toContain('last_searched_at < ?')
    expect(call.sql).toContain('search_count < 3')
    expect(call.args[0]).toBeGreaterThanOrEqual(before)
    expect(call.args[0]).toBeLessThanOrEqual(after)
  })
})
