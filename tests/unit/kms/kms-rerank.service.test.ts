/**
 * 规则重排器单元测试：
 * 新鲜度指数半衰期衰减（始终生效）、非最新版本降权、词覆盖加成、
 * 文件名前缀加成、批量排序稳定性与确定性注入时钟。
 */
import { describe, it, expect } from 'vitest'
import {
  rerankOne,
  rerankResults,
  FRESHNESS_MAX_MULTIPLIER,
  FRESHNESS_FLOOR,
  FRESHNESS_HALF_LIFE_DAYS,
  STALE_VERSION_PENALTY,
} from '../../../electron/main/services/kms/kms-rerank.service'

const nowSec = 1_700_000_000

describe('rerankOne / 新鲜度（指数半衰期，始终生效）', () => {
  it('无 modifiedTime 时 freshnessScore = 1，不参与衰减', () => {
    const result = rerankOne(
      { id: 'a' },
      { baseScore: 0.5, nowSec },
      ['term']
    )
    expect(result.freshnessScore).toBe(1)
    expect(result.rerankScore).toBe(0.5)
  })

  it('当天文档获得最大加成 FRESHNESS_MAX_MULTIPLIER', () => {
    const result = rerankOne(
      { id: 'a' },
      { baseScore: 1, modifiedTime: nowSec, nowSec },
      []
    )
    expect(result.freshnessScore).toBeCloseTo(FRESHNESS_MAX_MULTIPLIER)
  })

  it('恰好一个半衰期时加成幅度减半', () => {
    const result = rerankOne(
      { id: 'a' },
      { baseScore: 1, modifiedTime: nowSec - FRESHNESS_HALF_LIFE_DAYS * 86400, nowSec },
      []
    )
    const expected = FRESHNESS_FLOOR + (FRESHNESS_MAX_MULTIPLIER - FRESHNESS_FLOOR) * 0.5
    expect(result.freshnessScore).toBeCloseTo(expected)
  })

  it('极旧文档收敛到下限 FRESHNESS_FLOOR', () => {
    const result = rerankOne(
      { id: 'a' },
      { baseScore: 1, modifiedTime: nowSec - 3650 * 86400, nowSec },
      []
    )
    expect(result.freshnessScore).toBeCloseTo(FRESHNESS_FLOOR, 3)
  })

  it('更近的文档权重更高', () => {
    const fresh = rerankOne({ id: 'a' }, { baseScore: 1, modifiedTime: nowSec - 10 * 86400, nowSec }, [])
    const stale = rerankOne({ id: 'b' }, { baseScore: 1, modifiedTime: nowSec - 300 * 86400, nowSec }, [])
    expect(fresh.rerankScore).toBeGreaterThan(stale.rerankScore)
  })
})

describe('rerankOne / 版本与词覆盖', () => {
  it('非最新版本被降权乘 STALE_VERSION_PENALTY', () => {
    const stale = rerankOne(
      { id: 'a' },
      { baseScore: 1, contentVersionId: 'v1', latestVersionId: 'v2', nowSec },
      []
    )
    const fresh = rerankOne(
      { id: 'b' },
      { baseScore: 1, contentVersionId: 'v2', latestVersionId: 'v2', nowSec },
      []
    )
    expect(stale.staleVersion).toBe(true)
    expect(stale.rerankScore).toBeCloseTo(STALE_VERSION_PENALTY)
    expect(fresh.staleVersion).toBe(false)
    expect(fresh.rerankScore).toBe(1)
  })

  it('无版本信息不受影响（缺省视为最新）', () => {
    const result = rerankOne({ id: 'a' }, { baseScore: 0.8, nowSec }, [])
    expect(result.staleVersion).toBe(false)
    expect(result.rerankScore).toBe(0.8)
  })

  it('词覆盖率越高加成越大：全部命中高于 0 命中', () => {
    const all = rerankOne(
      { id: 'a' },
      { baseScore: 1, text: 'alpha beta', fileName: '', nowSec },
      ['alpha', 'beta']
    )
    const none = rerankOne(
      { id: 'b' },
      { baseScore: 1, text: 'nothing here', fileName: '', nowSec },
      ['alpha', 'beta']
    )
    expect(all.termCoverage).toBe(1)
    expect(none.termCoverage).toBe(0)
    expect(all.rerankScore).toBeGreaterThan(none.rerankScore)
  })

  it('文件名前缀命中加成', () => {
    const prefix = rerankOne({ id: 'a' }, { baseScore: 1, fileName: 'alpha-report', nowSec }, ['alpha'])
    const contains = rerankOne({ id: 'b' }, { baseScore: 1, fileName: 'the-alpha-report', nowSec }, ['alpha'])
    expect(prefix.rerankScore).toBeGreaterThan(contains.rerankScore)
  })
})

describe('rerankResults 批量', () => {
  it('baseScore 相同、时间新旧不同时按新鲜度重排', () => {
    const out = rerankResults(
      [
        { item: { id: 'old' }, hints: { baseScore: 1, modifiedTime: nowSec - 300 * 86400, nowSec } },
        { item: { id: 'new' }, hints: { baseScore: 1, modifiedTime: nowSec - 5 * 86400, nowSec } },
      ],
      []
    )
    expect(out.map(r => r.item.id)).toEqual(['new', 'old'])
  })

  it('空输入返回空数组', () => {
    expect(rerankResults([], [])).toEqual([])
  })

  it('排序确定性：同分数保持稳定（原始顺序）', () => {
    const input = [
      { item: 'a', hints: { baseScore: 0.5, nowSec } },
      { item: 'b', hints: { baseScore: 0.5, nowSec } },
    ]
    const first = rerankResults(input, [])
    const second = rerankResults(input, [])
    expect(first.map(r => r.item)).toEqual(second.map(r => r.item))
  })
})
