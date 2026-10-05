export type QueryIntent =
  | 'filename'
  | 'exact_phrase'
  | 'keyword'
  | 'semantic'
  | 'latest'
  | 'file_type'
  | 'scoped_collection'
  | 'multi_doc_synthesis'

export interface RetrievalPlan {
  intent: QueryIntent
  normalizedQuery: string
  useSemantic: boolean
  useFilename: boolean
  usePhrase: boolean
  freshnessBoost: number
  fileExtensions?: string[]
  timeRangeStart?: number
  keywords: string[]
}

export interface QualityCase {
  id: string
  query: string
  expectedFileIds: string[]
  expectedSourceTypes?: string[]
  intent?: QueryIntent
  options?: Record<string, unknown>
}

export interface QualityScore {
  recallAt5: number
  recallAt20: number
  mrr: number
  ndcgAt10: number
}

const EXTENSION_HINTS: Record<string, string[]> = {
  pdf: ['pdf'],
  word: ['doc', 'docx'],
  excel: ['xls', 'xlsx', 'csv'],
  ppt: ['ppt', 'pptx'],
  markdown: ['md', 'markdown'],
}

const TIME_PATTERNS: Array<{ pattern: RegExp; intent: QueryIntent; days: number }> = [
  { pattern: /最新|最近|近期|当前版本|this week|latest|recent/i, intent: 'latest', days: 90 },
  { pattern: /本月|this month/i, intent: 'latest', days: 30 },
  { pattern: /今年|this year/i, intent: 'latest', days: 365 },
]

export function planRetrieval(query: string, options?: { collectionIds?: string[]; fileExtensions?: string[]; useSemantic?: boolean }): RetrievalPlan {
  const normalizedQuery = query.trim()
  let intent: QueryIntent = options?.useSemantic ? 'semantic' : 'keyword'
  let freshnessBoost = 0
  let timeRangeStart: number | undefined

  if (options?.collectionIds?.length) intent = 'scoped_collection'
  if (/[“""].+[”""]/.test(normalizedQuery)) intent = 'exact_phrase'

  for (const hint of TIME_PATTERNS) {
    if (hint.pattern.test(normalizedQuery)) {
      intent = 'latest'
      freshnessBoost = 2.5
      timeRangeStart = Date.now() - hint.days * 86400 * 1000
      break
    }
  }

  for (const [type, exts] of Object.entries(EXTENSION_HINTS)) {
    if (new RegExp(`${type}|${exts.join('|')}`, 'i').test(normalizedQuery)) {
      if (intent === 'keyword' || intent === 'semantic') intent = 'file_type'
    }
  }

  if (!normalizedQuery.includes(' ') && /\.[a-z0-9]{2,5}$/i.test(normalizedQuery)) {
    intent = 'filename'
  }

  const keywords = normalizedQuery
    .toLowerCase()
    .split(/[\s,，。；;：:、？?！!/\\()（）【】\[\]{}'"]+/)
    .filter(Boolean)

  return {
    intent,
    normalizedQuery,
    useSemantic: intent === 'semantic' || !!options?.useSemantic,
    useFilename: intent === 'filename' || /文件名|路径|file|document/i.test(normalizedQuery),
    usePhrase: intent === 'exact_phrase' || keywords.length >= 3,
    freshnessBoost,
    fileExtensions: options?.fileExtensions,
    timeRangeStart,
    keywords,
  }
}

export function scoreQualityCases(cases: QualityCase[], resultsById: Map<string, Array<{ file_id: string; match_type?: string }>>): QualityScore {
  let hitAt5 = 0
  let hitAt20 = 0
  let reciprocalRankSum = 0
  let dcgSum = 0
  let idcgSum = 0

  for (const testCase of cases) {
    const results = resultsById.get(testCase.id) || []
    const expected = new Set(testCase.expectedFileIds)
    let caseHit5 = false
    let caseHit20 = false
    let firstRank = 0

    for (let i = 0; i < results.length; i++) {
      if (expected.has(results[i].file_id)) {
        if (!firstRank) firstRank = i + 1
        if (i < 5) caseHit5 = true
        if (i < 20) caseHit20 = true
      }
    }

    if (caseHit5) hitAt5++
    if (caseHit20) hitAt20++
    if (firstRank) reciprocalRankSum += 1 / firstRank

    let dcg = 0
    for (let i = 0; i < Math.min(10, results.length); i++) {
      if (expected.has(results[i].file_id)) dcg += 1 / Math.log2(i + 2)
    }
    let idcg = 0
    for (let i = 0; i < Math.min(10, expected.size); i++) idcg += 1 / Math.log2(i + 2)
    dcgSum += dcg
    if (idcg > 0) idcgSum += idcg
  }

  const n = cases.length || 1
  return {
    recallAt5: hitAt5 / n,
    recallAt20: hitAt20 / n,
    mrr: reciprocalRankSum / n,
    ndcgAt10: idcgSum > 0 ? dcgSum / idcgSum : 0,
  }
}

export function foldResultsByFile<T extends { file_id: string; score?: number }>(results: T[], maxPerFile: number = 1): Array<T & { sibling_count?: number }> {
  return foldResultsByKey(results, r => r.file_id, maxPerFile)
}

export function foldResultsByContent<T extends { file_id: string; content_version_id?: string; score?: number }>(
  results: T[],
  maxPerKey: number = 1
): Array<T & { sibling_count?: number; duplicate_count?: number }> {
  const folded = foldResultsByKey(results, r => r.content_version_id || r.file_id, maxPerKey) as Array<T & { sibling_count?: number; duplicate_count?: number }>
  const groups = new Map<string, T[]>()
  for (const result of results) {
    const key = result.content_version_id || result.file_id
    const list = groups.get(key) || []
    list.push(result)
    groups.set(key, list)
  }
  for (const item of folded) {
    const key = item.content_version_id || item.file_id
    item.duplicate_count = Math.max(0, (groups.get(key)?.length || 1) - 1)
  }
  return folded
}

function foldResultsByKey<T extends { score?: number }>(
  results: T[],
  keyOf: (result: T) => string,
  maxPerKey: number
): Array<T & { sibling_count?: number }> {
  const groups = new Map<string, T[]>()
  for (const result of results) {
    const key = keyOf(result)
    const list = groups.get(key) || []
    list.push(result)
    groups.set(key, list)
  }

  const folded: Array<T & { sibling_count?: number }> = []
  for (const list of groups.values()) {
    list.sort((a, b) => (b.score || 0) - (a.score || 0))
    const [best, ...rest] = list
    folded.push({ ...best, sibling_count: rest.length })
    for (const extra of rest.slice(0, maxPerKey - 1)) folded.push(extra)
  }
  folded.sort((a, b) => (b.score || 0) - (a.score || 0))
  return folded
}
