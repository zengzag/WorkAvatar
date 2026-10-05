import { describe, expect, it } from 'vitest'
import {
  foldResultsByFile,
  planRetrieval,
  scoreQualityCases,
  type QualityCase,
} from '../../../electron/main/services/kms/kms-search-quality'

describe('planRetrieval', () => {
  it('识别最新资料意图', () => {
    const plan = planRetrieval('最新的付款规范')
    expect(plan.intent).toBe('latest')
    expect(plan.freshnessBoost).toBeGreaterThan(0)
    expect(plan.timeRangeStart).toBeDefined()
  })

  it('识别语义查询', () => {
    const plan = planRetrieval('如何评估供应商风险', { useSemantic: true })
    expect(plan.useSemantic).toBe(true)
  })

  it('识别合集作用域', () => {
    const plan = planRetrieval('付款', { collectionIds: ['c1'] })
    expect(plan.intent).toBe('scoped_collection')
  })
})

describe('scoreQualityCases', () => {
  it('计算 Recall、MRR 与 nDCG', () => {
    const cases: QualityCase[] = [
      { id: 'q1', query: 'a', expectedFileIds: ['f1', 'f2'] },
      { id: 'q2', query: 'b', expectedFileIds: ['f3'] },
    ]
    const results = new Map([
      ['q1', [{ file_id: 'f1' }, { file_id: 'f2' }]],
      ['q2', [{ file_id: 'x' }, { file_id: 'f3' }]],
    ])
    const score = scoreQualityCases(cases, results)
    expect(score.recallAt5).toBe(1)
    expect(score.recallAt20).toBe(1)
    expect(score.mrr).toBeCloseTo(0.75, 5)
    expect(score.ndcgAt10).toBeGreaterThan(0)
  })
})

describe('foldResultsByFile', () => {
  it('同文档默认只保留最佳结果并记录兄弟片段数', () => {
    const folded = foldResultsByFile([
      { file_id: 'f1', score: 0.2, text: 'a' },
      { file_id: 'f1', score: 0.8, text: 'b' },
      { file_id: 'f2', score: 0.5, text: 'c' },
    ])
    expect(folded).toHaveLength(2)
    expect(folded[0].file_id).toBe('f1')
    expect(folded[0].text).toBe('b')
    expect(folded[0].sibling_count).toBe(1)
  })
})
