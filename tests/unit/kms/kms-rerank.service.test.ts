/**
 * 规则重排器单元测试：
 * 新鲜度意图识别、新鲜度加权排序、非最新版本降权、词覆盖加成、
 * 文件名前缀加成、批量排序稳定性与确定性注入时钟。
 */
import { describe, it, expect } from 'vitest'
import {
  isFreshnessIntent,
  rerankOne,
  rerankResults,
  DEFAULT_FRESHNESS_BOOST,
  STALE_VERSION_PENALTY,
} from '../../../electron/main/services/kms/kms-rerank.service'

const nowSec = 1_700_000_000

describe('isFreshnessIntent', () => {
  it('识别中文与英文新鲜度意图', () => {
    expect(isFreshnessIntent('最新版本说明')).toBe(true)
    expect(isFreshnessIntent('最近的通知')).toBe(true)
    expect(isFreshnessIntent('latest release')).toBe(true)
    expect(isFreshnessIntent('RECENT updates')).toBe(true)
  })

  it('普通查询不触发新鲜度意图', () => {
    expect(isFreshnessIntent('项目计划')).toBe(false)
    expect(isFreshnessIntent('contract terms')).toBe(false)
  })
})

describe('rerankOne / 新鲜度', () => {
  it('非新鲜度意图时 freshnessScore = 1', () => {
    const result = rerankOne(
      { id: 'a' },
      { baseScore: 0.5, freshnessIntent: false, modifiedTime: nowSec, nowSec },
      ['term']
    )
    expect(result.freshnessScore).toBe(1)
    expect(result.rerankScore).toBe(0.5)
  })

  it('新鲜度意图：当天文档获得 35% 加成', () => {
    const result = rerankOne(
      { id: 'a' },
      { baseScore: 1, freshnessIntent: true, modifiedTime: nowSec, nowSec },
      []
    )
    expect(result.freshnessScore).toBeCloseTo(1 + DEFAULT_FRESHNESS_BOOST)
  })

  it('新鲜度意图：恰好 365 天文档无加成', () => {
    const result = rerankOne(
      { id: 'a' },
      { baseScore: 1, freshnessIntent: true, modifiedTime: nowSec - 365 * 86400, nowSec },
      []
    )
    expect(result.freshnessScore).toBeCloseTo(1)
  })

  it('新鲜度意图：超过 365 天文档无加成', () => {
    const result = rerankOne(
      { id: 'a' },
      { baseScore: 1, freshnessIntent: true, modifiedTime: nowSec - 400 * 86400, nowSec },
      []
    )
    expect(result.freshnessScore).toBe(1)
  })

  it('新鲜度意图：更近的文档权重更高', () => {
    const fresh = rerankOne({ id: 'a' }, { baseScore: 1, freshnessIntent: true, modifiedTime: nowSec - 10 * 86400, nowSec }, [])
    const stale = rerankOne({ id: 'b' }, { baseScore: 1, freshnessIntent: true, modifiedTime: nowSec - 300 * 86400, nowSec }, [])
    expect(fresh.rerankScore).toBeGreaterThan(stale.rerankScore)
  })
})

describe('rerankOne / 版本与词覆盖', () => {
  it('非最新版本被降权乘 STALE_VERSION_PENALTY', () => {
    const stale = rerankOne(
      { id: 'a' },
      { baseScore: 1, contentVersionId: 'v1', latestVersionId: 'v2', freshnessIntent: false, nowSec },
      []
    )
    const fresh = rerankOne(
      { id: 'b' },
      { baseScore: 1, contentVersionId: 'v2', latestVersionId: 'v2', freshnessIntent: false, nowSec },
      []
    )
    expect(stale.staleVersion).toBe(true)
    expect(stale.rerankScore).toBeCloseTo(STALE_VERSION_PENALTY)
    expect(fresh.staleVersion).toBe(false)
    expect(fresh.rerankScore).toBe(1)
  })

  it('无版本信息不受影响（缺省视为最新）', () => {
    const result = rerankOne({ id: 'a' }, { baseScore: 0.8, freshnessIntent: false, nowSec }, [])
    expect(result.staleVersion).toBe(false)
    expect(result.rerankScore).toBe(0.8)
  })

  it('词覆盖率越高加成越大：全部命中高于 0 命中', () => {
    const all = rerankOne(
      { id: 'a' },
      { baseScore: 1, text: 'alpha beta', fileName: '', freshnessIntent: false, nowSec },
      ['alpha', 'beta']
    )
    const none = rerankOne(
      { id: 'b' },
      { baseScore: 1, text: 'nothing here', fileName: '', freshnessIntent: false, nowSec },
      ['alpha', 'beta']
    )
    expect(all.termCoverage).toBe(1)
    expect(none.termCoverage).toBe(0)
    expect(all.rerankScore).toBeGreaterThan(none.rerankScore)
  })

  it('文件名前缀命中加成', () => {
    const prefix = rerankOne({ id: 'a' }, { baseScore: 1, fileName: 'alpha-report', freshnessIntent: false, nowSec }, ['alpha'])
    const contains = rerankOne({ id: 'b' }, { baseScore: 1, fileName: 'the-alpha-report', freshnessIntent: false, nowSec }, ['alpha'])
    expect(prefix.rerankScore).toBeGreaterThan(contains.rerankScore)
  })
})

describe('rerankResults 批量', () => {
  it('baseScore 相同、新鲜度不同时按新鲜度重排', () => {
    const out = rerankResults(
      [
        { item: { id: 'old' }, hints: { baseScore: 1, freshnessIntent: true, modifiedTime: nowSec - 300 * 86400, nowSec } },
        { item: { id: 'new' }, hints: { baseScore: 1, freshnessIntent: true, modifiedTime: nowSec - 5 * 86400, nowSec } },
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
      { item: 'a', hints: { baseScore: 0.5, freshnessIntent: false, nowSec } },
      { item: 'b', hints: { baseScore: 0.5, freshnessIntent: false, nowSec } },
    ]
    const first = rerankResults(input, [])
    const second = rerankResults(input, [])
    expect(first.map(r => r.item)).toEqual(second.map(r => r.item))
  })
})
