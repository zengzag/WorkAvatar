/**
 * 规则重排器（Rule-based Reranker）
 *
 * 在 RRF 混合搜索之后、最终排序之前执行的第二阶段重排。
 * 不依赖外部模型（为未来接入 cross-encoder 预留接口），仅使用已在
 * SearchResult 上可得的廉价信号：
 *
 * 1. 基础分：RRF sortKey（多来源融合排名，已由 hybridSearch 计算）
 * 2. 词覆盖：查询词在 text/file_name 中的命中率（覆盖越多越相关）
 * 3. 新鲜度：按文档年龄做指数半衰期衰减，始终生效（新文档加成、旧文档降权）
 * 4. 版本约束：非最新 content_version 的结果降权，优先展示当前版本
 * 5. 文件名前缀：文件名列首命中（权重最高的传统信号）小幅加成
 *
 * 全部为线性/乘法组合，常量集中定义便于调参与测试。
 */

/** 最新文档（age=0）的新鲜度加成乘数 */
export const FRESHNESS_MAX_MULTIPLIER = 1.2
/** 极旧文档（age→∞）的新鲜度下限乘数 */
export const FRESHNESS_FLOOR = 0.85
/** 新鲜度指数衰减半衰期（天）：每过该天数，加成幅度减半 */
export const FRESHNESS_HALF_LIFE_DAYS = 180
/** 非最新版本的降权乘数（保留召回，避免旧版本完全消失） */
export const STALE_VERSION_PENALTY = 0.85
/** 词覆盖每 25% 的加成乘数 */
export const TERM_COVERAGE_STEP = 0.05
/** 文件名前缀命中加成乘数 */
export const FILENAME_PREFIX_BOOST = 0.08

export interface RerankHints {
  /** RRF 融合后的基础分 */
  baseScore: number
  /** 文档修改时间（unix 秒） */
  modifiedTime?: number
  /** 该结果的 content_version_id（缺省视为最新） */
  contentVersionId?: string
  /** 该文件的最新 content_version_id（用于新旧版本判别） */
  latestVersionId?: string
  /** 命中文本（用于词覆盖计算） */
  text?: string
  /** 文件名（用于词覆盖与前缀计算） */
  fileName?: string
  /** 当前时间戳（unix 秒，可注入用于测试） */
  nowSec?: number
}

export interface RerankResult<T> {
  item: T
  rerankScore: number
  freshnessScore: number
  termCoverage: number
  staleVersion: boolean
}

function computeTermCoverage(terms: string[], haystacks: (string | undefined)[]): number {
  const meaningful = terms.filter(t => t.length > 0)
  if (meaningful.length === 0) return 0
  let hit = 0
  for (const term of meaningful) {
    if (haystacks.some(h => h?.includes(term))) hit++
  }
  return hit / meaningful.length
}

/**
 * 对单个结果计算重排乘数分（multiplicative rerank score）
 */
export function rerankOne<T>(
  item: T,
  hints: RerankHints,
  queryTerms: string[]
): RerankResult<T> {
  const nowSec = hints.nowSec ?? Math.floor(Date.now() / 1000)

  // 新鲜度：指数半衰期衰减，始终生效。age=0 时 FRESHNESS_MAX_MULTIPLIER，
  // 每过 FRESHNESS_HALF_LIFE_DAYS 天加成幅度减半，长期收敛到 FRESHNESS_FLOOR。
  let freshnessScore = 1
  if (hints.modifiedTime && hints.modifiedTime > 0) {
    const ageDays = Math.max(0, (nowSec - hints.modifiedTime) / 86400)
    const span = FRESHNESS_MAX_MULTIPLIER - FRESHNESS_FLOOR
    freshnessScore = FRESHNESS_FLOOR + span * Math.pow(2, -ageDays / FRESHNESS_HALF_LIFE_DAYS)
  }

  // 词覆盖：查询词在 text/file_name 的命中率
  const termCoverage = computeTermCoverage(queryTerms, [hints.text, hints.fileName])
  const coverageBoost = 1 + termCoverage * (TERM_COVERAGE_STEP / 0.25)

  // 版本约束：有 content_version 且并非该文件最新版本时降权
  const staleVersion = !!hints.contentVersionId && !!hints.latestVersionId
    && hints.contentVersionId !== hints.latestVersionId
  const versionMultiplier = staleVersion ? STALE_VERSION_PENALTY : 1

  // 文件名前缀命中：文件名以词开头（ Traditional prefix signal ）
  const fileNameLower = (hints.fileName || '').toLowerCase()
  const prefixHit = queryTerms.some(t => fileNameLower.startsWith(t))
  const prefixBoost = prefixHit ? 1 + FILENAME_PREFIX_BOOST : 1

  const rerankScore = (hints.baseScore || 0) * freshnessScore * coverageBoost * versionMultiplier * prefixBoost
  return { item, rerankScore, freshnessScore, termCoverage, staleVersion }
}

/**
 * 批量重排：按 rerankScore 降序返回
 */
export function rerankResults<T>(
  items: Array<{ item: T; hints: RerankHints }>,
  queryTerms: string[]
): Array<RerankResult<T>> {
  return items
    .map(({ item, hints }) => rerankOne(item, hints, queryTerms))
    .sort((a, b) => b.rerankScore - a.rerankScore)
}

/**
 * Cross-encoder 重排预留接口：未来接入外部 reranker 模型时实现此签名，
 * 由调用方按需替换 rerankResults（信号字段已在 hints 中齐备）。
 */
export type RerankingModelAdapter = (
  query: string,
  candidates: Array<{ text: string; fileName?: string }>
) => Promise<number[]>
