/**
 * ANN 基准工具单元测试：
 * 合成向量生成（确定性/单位范数）、Recall@k 计算、
 * runAnnBenchmark 用伪 vec0 DB 驱动端到端流程（含插入/查询/清理）。
 */
import { describe, it, expect } from 'vitest'
import {
  generateSyntheticVectors,
  computeRecallAtK,
  cosineSimilarity,
  runAnnBenchmark,
} from '../../../electron/main/services/kms/kms-ann-benchmark'

describe('generateSyntheticVectors', () => {
  it('数量与维度正确且已归一化', () => {
    const vectors = generateSyntheticVectors(20, 8)
    expect(vectors).toHaveLength(20)
    for (const v of vectors) {
      expect(v.length).toBe(8)
      const sumSq = v.reduce((acc, x) => acc + x * x, 0)
      expect(Math.abs(sumSq - 1)).toBeLessThan(1e-5)
    }
  })

  it('同参数生成结果确定（可复现）', () => {
    const a = generateSyntheticVectors(5, 4)
    const b = generateSyntheticVectors(5, 4)
    for (let i = 0; i < 5; i++) {
      expect([...a[i]]).toEqual([...b[i]])
    }
  })
})

describe('computeRecallAtK', () => {
  it('完全重合 recall = 1', () => {
    expect(computeRecallAtK([1, 2, 3], [1, 2, 3])).toBe(1)
  })

  it('部分重合 recall = 重合比例', () => {
    expect(computeRecallAtK([1, 2], [1, 9])).toBe(0.5)
  })

  it('空真值 recall = 0', () => {
    expect(computeRecallAtK([1], [])).toBe(0)
  })
})

describe('cosineSimilarity', () => {
  it('单位向量的点积等于余弦相似度', () => {
    const a = new Float32Array([1, 0])
    const b = new Float32Array([0, 1])
    expect(cosineSimilarity(a, b)).toBeCloseTo(0)
    expect(cosineSimilarity(a, a)).toBeCloseTo(1)
  })
})

describe('runAnnBenchmark（伪 vec0 DB）', () => {
  function makeFakeVecDb(count: number, dimension: number) {
    const inserts = new Map<number, Float32Array>()
    const executed: string[] = []
    const db = {
      exec: (sql: string) => { executed.push(sql.trim()) },
      transaction: (fn: () => void) => () => { fn() },
      prepare: (sql: string) => {
        const normalized = sql.replace(/\s+/g, ' ').trim()
        if (normalized.startsWith('INSERT INTO ann_benchmark_vec')) {
          return {
            run: (rowid: number, buf: Buffer) => {
              const v = new Float32Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength))
              inserts.set(Number(rowid), v)
              return {}
            },
          }
        }
        if (normalized.startsWith('SELECT rowid, distance FROM ann_benchmark_vec')) {
          return {
            all: (buf: Buffer, limit: number) => {
              const q = new Float32Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength))
              const scored = [...inserts.entries()]
                .map(([rowid, v]) => ({ rowid, distance: 1 - cosineSimilarity(q, v) }))
                .sort((a, b) => a.distance - b.distance)
                .slice(0, limit)
              return scored
            },
          }
        }
        throw new Error(`unexpected sql: ${normalized}`)
      },
    }
    void count
    void dimension
    return { db, inserts, executed }
  }

  it('生成结果：插入计数、召回基于真值、执行了清理', () => {
    const { db, inserts, executed } = makeFakeVecDb(24, 6)
    const result = runAnnBenchmark(db, { dimension: 6, vectorCount: 24, queryCount: 3, topK: 5 })
    expect(inserts.size).toBe(24)
    expect(result.vectorCount).toBe(24)
    expect(result.recallAtK).toBeCloseTo(1) // 伪 vec0 是暴力扫描 → 与真值完全重合
    expect(result.insertMs).toBeGreaterThan(0)
    expect(result.jsQueryMs.mean).toBeGreaterThan(0)
    expect(result.vecQueryMs.mean).toBeGreaterThan(0)
    // 建表 + 清理 DROP
    expect(executed.some(s => s.includes('CREATE VIRTUAL TABLE'))).toBe(true)
    expect(executed.some(s => s.startsWith('DROP TABLE'))).toBe(true)
  })

  it('无效 SQL 会抛错（防止生产表泄漏到基准中）', () => {
    const badDb = {
      exec: () => undefined,
      transaction: (fn: () => void) => () => { fn() },
      prepare: () => { throw new Error('unexpected') },
    }
    expect(() => runAnnBenchmark(badDb, { dimension: 4, vectorCount: 4, queryCount: 1, topK: 2 })).toThrow('unexpected')
  })
})
