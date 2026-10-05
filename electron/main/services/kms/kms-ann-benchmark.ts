/**
 * ANN 后端基准测试（kms_ann_spike_report 的后续验证工具）
 *
 * 对比两个后端在同一批合成向量上的表现：
 * - vec0（sqlite-vec 虚表）：插入 + 近似最近邻查询
 * - JS 全扫描：暴力余弦相似度
 *
 * 指标：插入耗时、前 k 命中召回率 Recall@k（以暴力扫描为基准）、P50/P95 查询延迟。
 * 用法：在开发环境脚本或测试中调用 runAnnBenchmark(vectorDb, options)。
 */

export interface AnnBenchmarkOptions {
  dimension: number
  vectorCount: number
  queryCount: number
  topK: number
}

export interface AnnBenchmarkResult {
  insertMs: number
  vecQueryMs: { p50: number; p95: number; mean: number }
  jsQueryMs: { p50: number; p95: number; mean: number }
  recallAtK: number
  vectorCount: number
}

/** 生成可复现（LCG 伪随机）的合成单位向量集，embedding = vectors[0] 是全部查询的 doc 集合 */
export function generateSyntheticVectors(count: number, dimension: number): Float32Array[] {
  let seed = 42
  const next = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff
    return (seed / 0x7fffffff) * 2 - 1
  }
  const vectors: Float32Array[] = []
  for (let i = 0; i < count; i++) {
    const v = new Float32Array(dimension)
    let norm = 0
    for (let j = 0; j < dimension; j++) {
      v[j] = next()
      norm += v[j] * v[j]
    }
    norm = Math.sqrt(norm) || 1
    for (let j = 0; j < dimension; j++) v[j] /= norm
    vectors.push(v)
  }
  return vectors
}

export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  let dot = 0
  for (let i = 0; i < a.length; i++) dot += a[i] * b[i]
  return dot
}

/** Recall@k：ANN 结果与暴力扫描结果的重合比例 */
export function computeRecallAtK(annTopK: number[], bruteTopK: number[]): number {
  const bruteSet = new Set(bruteTopK)
  let hit = 0
  for (const id of annTopK) if (bruteSet.has(id)) hit++
  return bruteTopK.length > 0 ? hit / bruteTopK.length : 0
}

function percentile(sortedValues: number[], p: number): number {
  if (sortedValues.length === 0) return 0
  const idx = Math.min(sortedValues.length - 1, Math.max(0, Math.ceil((p / 100) * sortedValues.length) - 1))
  return sortedValues[idx]
}

/**
 * 在给定 vectorDb（需已加载 sqlite-vec 扩展）上运行基准。
 * 表名 ann_benchmark_vec，运行后清理。
 */
export function runAnnBenchmark(
  db: {
    prepare: (sql: string) => { run: (...args: any[]) => any; all: (...args: any[]) => any[]; get: (...args: any[]) => any }
    exec: (sql: string) => void
    transaction: (fn: () => void) => () => void
  },
  options: AnnBenchmarkOptions
): AnnBenchmarkResult {
  const { dimension, vectorCount, queryCount, topK } = options
  const vectors = generateSyntheticVectors(vectorCount, dimension)
  const vecTableName = 'ann_benchmark_vec'

  // 建 vec0 表 + 计时插入（分批 500，同生产代码）
  const startedInsert = performance.now()
  db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS ${vecTableName} USING vec0(embedding float[${dimension}] distance_metric=cosine)`)
  db.exec(`DELETE FROM ${vecTableName}`)
  const insert = db.transaction(() => {
    const stmt = db.prepare(`INSERT INTO ${vecTableName}(rowid, embedding) VALUES (?, ?)`)
    for (let i = 0; i < vectors.length; i++) {
      stmt.run(i + 1, Buffer.from(vectors[i].buffer, vectors[i].byteOffset, vectors[i].byteLength))
    }
  })
  insert()
  const insertMs = performance.now() - startedInsert

  // 暴力扫描基准真值（全向量内存扫描）
  const queries = vectors.slice(0, queryCount)
  const bruteTopK = queries.map((q, qIdx) => {
    const scores: Array<{ id: number; score: number }> = []
    for (let i = 0; i < vectors.length; i++) {
      if (i === qIdx) continue
      scores.push({ id: i + 1, score: cosineSimilarity(q, vectors[i]) })
    }
    scores.sort((a, b) => b.score - a.score)
    return scores.slice(0, topK).map(s => s.id)
  })

  // JS 全扫描（含查询计时），模拟 vectorSearch fallback 路径
  const jsTimings: number[] = []
  const jsTopK: number[][] = []
  for (const q of queries) {
    const t0 = performance.now()
    const scores: Array<{ id: number; score: number }> = []
    for (let i = 0; i < vectors.length; i++) {
      if (i === queries.indexOf(q)) continue
      scores.push({ id: i + 1, score: cosineSimilarity(q, vectors[i]) })
    }
    scores.sort((a, b) => b.score - a.score)
    jsTopK.push(scores.slice(0, topK).map(s => s.id))
    jsTimings.push(performance.now() - t0)
  }

  // vec0 查询计时
  const vecTimings: number[] = []
  const vecTopK: number[][] = []
  const queryStmt = db.prepare(
    `SELECT rowid, distance FROM ${vecTableName} WHERE embedding = ? ORDER BY distance LIMIT ?`
  )
  for (let qIdx = 0; qIdx < queries.length; qIdx++) {
    const t0 = performance.now()
    const rows = queryStmt.all(
      Buffer.from(queries[qIdx].buffer, queries[qIdx].byteOffset, queries[qIdx].byteLength),
      topK + 1
    ) as Array<{ rowid: number; distance: number }>
    vecTimings.push(performance.now() - t0)
    vecTopK.push(rows.filter(r => Number(r.rowid) !== qIdx + 1).slice(0, topK).map(r => Number(r.rowid)))
  }

  // 清理基准表，避免污染向量库
  db.exec(`DROP TABLE IF EXISTS ${vecTableName}`)

  const stats = (arr: number[]) => {
    const sorted = [...arr].sort((a, b) => a - b)
    return {
      p50: percentile(sorted, 50),
      p95: percentile(sorted, 95),
      mean: arr.length > 0 ? arr.reduce((a, b) => a + b, 0) / arr.length : 0,
    }
  }
  const recalls = vecTopK.map((top, i) => computeRecallAtK(top, bruteTopK[i]))
  return {
    insertMs,
    vecQueryMs: stats(vecTimings),
    jsQueryMs: stats(jsTimings),
    recallAtK: recalls.length > 0 ? recalls.reduce((a, b) => a + b, 0) / recalls.length : 0,
    vectorCount,
  }
}
