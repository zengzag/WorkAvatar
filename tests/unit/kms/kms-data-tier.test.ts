import { describe, it, expect, vi, beforeEach } from 'vitest'

const state = vi.hoisted(() => {
  const hot = new Set<string>()
  const cold = new Set<string>()
  const updates: Array<{ tier: string; ids: string[] }> = []
  const stats = new Map<string, { hitCount: number; readCount: number; lastAccessed: number | null }>()
  const updatedAt = new Map<string, number>()
  const dayArgs: Array<{ count: number; days: number }> = []
  const selects: string[] = []
  const flags = { missingEntries: 0 }

  const buildStats = (ids: string[]) => {
    const m = new Map<string, { hitCount: number; readCount: number; lastAccessed: number | null }>()
    const list = flags.missingEntries > 0 ? ids.slice(0, ids.length - flags.missingEntries) : ids
    for (const id of list) {
      m.set(id, stats.get(id) ?? { hitCount: 0, readCount: 0, lastAccessed: null })
    }
    return m
  }

  const fakeDb = {
    prepare: (sql: string) => {
      const n = sql.replace(/\s+/g, ' ').trim()
      if (n.startsWith('SELECT id FROM kms_files') || n.startsWith('SELECT id, updated_at FROM kms_files')) {
        selects.push(n)
        const tier = n.includes("'hot'") ? hot : cold
        const withUpdatedAt = n.includes('updated_at')
        return {
          all: () => [...tier].map(id =>
            withUpdatedAt ? { id, updated_at: updatedAt.get(id) ?? 0 } : { id }
          ),
        }
      }
      if (n.startsWith('UPDATE kms_files SET data_tier')) {
        return {
          run: (tier: string, ...ids: string[]) => {
            updates.push({ tier, ids })
            for (const id of ids) {
              hot.delete(id)
              cold.delete(id)
              if (tier === 'hot') hot.add(id)
              else cold.add(id)
              // 生产实现会同时刷新 updated_at（层级变更时间）
              updatedAt.set(id, Math.floor(Date.now() / 1000))
            }
            return { changes: ids.length }
          },
        }
      }
      throw new Error(`unexpected sql: ${n}`)
    },
    transaction: (fn: any) => (ids: string[], tier: string) => fn(ids, tier),
  }

  return { hot, cold, updates, stats, updatedAt, dayArgs, selects, flags, buildStats, fakeDb }
})

vi.mock('../../../electron/main/services/kms/kms-database.service', () => ({
  default: { getInstance: () => ({ getDb: () => state.fakeDb }) },
}))

vi.mock('../../../electron/main/services/kms/kms-crawler.service', () => ({
  default: {
    getInstance: () => ({
      getFileAccessStatsBatch: (ids: string[], days: number) => {
        state.dayArgs.push({ count: ids.length, days })
        return state.buildStats(ids)
      },
    }),
  },
}))

import KMSDataTierService from '../../../electron/main/services/kms/kms-data-tier.service'

const tiers = KMSDataTierService.getInstance()
const now = () => Math.floor(Date.now() / 1000)

function setStats(id: string, s: Partial<{ hitCount: number; readCount: number; lastAccessed: number | null }>) {
  state.stats.set(id, { hitCount: 0, readCount: 0, lastAccessed: null, ...s })
}

beforeEach(() => {
  state.hot.clear()
  state.cold.clear()
  state.updates.length = 0
  state.stats.clear()
  state.updatedAt.clear()
  state.dayArgs.length = 0
  state.selects.length = 0
  state.flags.missingEntries = 0
})

describe('kms-data-tier / 空库与去抖', () => {
  it('无 hot/cold 文件时不访问访问日志且返回空结果', () => {
    const out = tiers.evaluateDataTiers(true)
    expect(out).toEqual({ promotedFileIds: [], demotedFileIds: [] })
    expect(state.dayArgs).toHaveLength(0)
  })

  it('非强制模式在 5 分钟内不重复评估（去抖）', () => {
    state.cold.add('f1')
    setStats('f1', { hitCount: 20 })
    const first = tiers.evaluateDataTiers(true)
    expect(first.promotedFileIds).toEqual(['f1'])

    state.selects.length = 0
    const second = tiers.evaluateDataTiers(false)
    expect(second).toEqual({ promotedFileIds: [], demotedFileIds: [] })
    expect(state.selects).toHaveLength(0) // 未访问数据库

    // 强制模式忽略去抖
    const third = tiers.evaluateDataTiers(true)
    expect(third).toEqual({ promotedFileIds: [], demotedFileIds: [] })
    expect(state.selects.length).toBeGreaterThan(0)
  })
})

describe('kms-data-tier / 降级（hot → cold）', () => {
  it('超过 90 天未访问的 hot 文件被降级', () => {
    state.hot.add('f1')
    setStats('f1', { lastAccessed: now() - 91 * 86400 })
    const out = tiers.evaluateDataTiers(true)
    expect(out.demotedFileIds).toEqual(['f1'])
    expect(state.updates).toEqual([{ tier: 'cold', ids: ['f1'] }])
    expect(state.cold.has('f1')).toBe(true)
    expect(state.hot.has('f1')).toBe(false)
  })

  it('恰好 90 天（阈值边界）不降级', () => {
    state.hot.add('f1')
    setStats('f1', { lastAccessed: now() - 90 * 86400 })
    expect(tiers.evaluateDataTiers(true).demotedFileIds).toEqual([])
  })

  it('无任何访问记录（保留窗口内无访问）的 hot 文件被降级', () => {
    state.hot.add('f1')
    setStats('f1', { lastAccessed: null })
    expect(tiers.evaluateDataTiers(true).demotedFileIds).toEqual(['f1'])
    expect(state.updates).toEqual([{ tier: 'cold', ids: ['f1'] }])
  })

  it('刚做过深度处理（updated_at 新）但尚无访问记录的 hot 文件不降级', () => {
    state.hot.add('f1')
    setStats('f1', { lastAccessed: null })
    state.updatedAt.set('f1', now())
    expect(tiers.evaluateDataTiers(true).demotedFileIds).toEqual([])
    expect(state.updates).toHaveLength(0)
  })

  it('降级查询使用 90 天窗口', () => {
    state.hot.add('f1')
    tiers.evaluateDataTiers(true)
    expect(state.dayArgs[0].days).toBe(90)
  })
})

describe('kms-data-tier / 晋升（cold → hot）', () => {
  it('命中次数达到 15 次晋升', () => {
    state.cold.add('f1')
    setStats('f1', { hitCount: 15 })
    expect(tiers.evaluateDataTiers(true).promotedFileIds).toEqual(['f1'])
    expect(state.hot.has('f1')).toBe(true)
  })

  it('命中 14 次不晋升（阈值边界）', () => {
    state.cold.add('f1')
    setStats('f1', { hitCount: 14 })
    expect(tiers.evaluateDataTiers(true).promotedFileIds).toEqual([])
  })

  it('读取次数达到 8 次晋升', () => {
    state.cold.add('f1')
    setStats('f1', { readCount: 8 })
    expect(tiers.evaluateDataTiers(true).promotedFileIds).toEqual(['f1'])
  })

  it('读取 7 次不晋升（阈值边界）', () => {
    state.cold.add('f1')
    setStats('f1', { readCount: 7 })
    expect(tiers.evaluateDataTiers(true).promotedFileIds).toEqual([])
  })

  it('晋升查询使用 30 天窗口', () => {
    state.cold.add('f1')
    tiers.evaluateDataTiers(true)
    expect(state.dayArgs[0].days).toBe(30)
  })

  it('晋升与降级可同时发生，先降级后晋升', () => {
    state.hot.add('h1')
    state.cold.add('c1')
    setStats('h1', { lastAccessed: now() - 200 * 86400 })
    setStats('c1', { hitCount: 100 })
    const out = tiers.evaluateDataTiers(true)
    expect(out.demotedFileIds).toEqual(['h1'])
    expect(out.promotedFileIds).toEqual(['c1'])
    expect(state.updates.map(u => u.tier)).toEqual(['cold', 'hot'])
  })

  it('超过 500 个文件时分批更新（避免 SQLITE 参数上限）', () => {
    const ids = Array.from({ length: 601 }, (_, i) => `c${i}`)
    for (const id of ids) {
      state.cold.add(id)
      setStats(id, { hitCount: 20 })
    }
    const out = tiers.evaluateDataTiers(true)
    expect(out.promotedFileIds).toHaveLength(601)
    expect(state.updates).toHaveLength(2)
    expect(state.updates[0].ids).toHaveLength(500)
    expect(state.updates[1].ids).toHaveLength(101)
  })

  it('重复评估具有幂等性（已晋升的文件不再重复更新）', () => {
    state.cold.add('f1')
    setStats('f1', { hitCount: 20 })
    expect(tiers.evaluateDataTiers(true).promotedFileIds).toEqual(['f1'])
    state.updates.length = 0
    expect(tiers.evaluateDataTiers(true).promotedFileIds).toEqual([])
    expect(state.updates).toHaveLength(0)
  })

  it('crawler 返回缺少条目的统计 Map 时抛 TypeError（依赖 crawler 契约）', () => {
    state.cold.add('f1')
    state.cold.add('f2')
    state.flags.missingEntries = 1
    expect(() => tiers.evaluateDataTiers(true)).toThrow(TypeError)
  })
})
