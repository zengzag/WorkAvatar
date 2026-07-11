import kmsTokenizer from './kms-tokenizer.service'
import type { SearchOptions, SearchResult, EmbeddingEntry } from './kms-search-types'

export type { SearchOptions, SearchResult, EmbeddingEntry, HighlightRange, SourceType } from './kms-search-types'

export function computeEmbeddingEntriesBytes(entries: EmbeddingEntry[]): number {
  let total = 0
  for (const e of entries) {
    total += e.embedding.byteLength
    total += e.id.length * 2
    total += e.sourceType.length * 2
    total += e.sourceId.length * 2
    total += e.fileId.length * 2
    total += e.model.length * 2
  }
  return total
}

export function extractQueryKeywords(query: string): string[] {
  const lower = query.toLowerCase().trim()
  if (!lower) return []
  return kmsTokenizer.segmentForSearch(lower)
}

export function buildFtsQuery(keywords: string[]): string {
  const escaped = keywords.map(k => {
    const clean = k.replace(/"/g, '""').replace(/[*()^\-+]/g, '')
    if (!clean) return null
    return `"${clean}"*`
  }).filter(Boolean) as string[]
  if (escaped.length === 0) return '""*'
  return escaped.join(' OR ')
}

export function buildLikeWhereClause(options?: SearchOptions): { whereClause: string; params: any[] } {
  let whereClause = '1=1'
  const params: any[] = []

  if (options?.fileIds && options.fileIds.length > 0) {
    const placeholders = options.fileIds.map(() => '?').join(',')
    whereClause += ` AND si.file_id IN (${placeholders})`
    params.push(...options.fileIds)
  }

  if (options?.sourceTypes && options.sourceTypes.length > 0) {
    const placeholders = options.sourceTypes.map(() => '?').join(',')
    whereClause += ` AND si.source_type IN (${placeholders})`
    params.push(...options.sourceTypes)
  }

  if (options?.timeRangeStart || options?.timeRangeEnd) {
    if (options.timeRangeStart) {
      whereClause += ' AND f.modified_time >= ?'
      params.push(options.timeRangeStart)
    }
    if (options.timeRangeEnd) {
      whereClause += ' AND f.modified_time <= ?'
      params.push(options.timeRangeEnd)
    }
  }

  if (options?.fileExtensions && options.fileExtensions.length > 0) {
    const placeholders = options.fileExtensions.map(() => '?').join(',')
    whereClause += ` AND f.file_ext IN (${placeholders})`
    params.push(...options.fileExtensions)
  }

  if (options?.collectionIds && options.collectionIds.length > 0) {
    const placeholders = options.collectionIds.map(() => '?').join(',')
    whereClause += ` AND si.file_id IN (SELECT file_id FROM kms_file_collections WHERE collection_id IN (${placeholders}))`
    params.push(...options.collectionIds)
  }

  if (options?.dirIds && options.dirIds.length > 0) {
    const placeholders = options.dirIds.map(() => '?').join(',')
    whereClause += ` AND si.file_id IN (SELECT id FROM kms_files WHERE dir_id IN (${placeholders}))`
    params.push(...options.dirIds)
  }

  return { whereClause, params }
}

export function buildFtsWhereClause(options?: SearchOptions): { whereClause: string; params: any[] } {
  let whereClause = '1=1'
  const params: any[] = []

  if (options?.fileIds && options.fileIds.length > 0) {
    const placeholders = options.fileIds.map(() => '?').join(',')
    whereClause += ` AND kms_fts.file_id IN (${placeholders})`
    params.push(...options.fileIds)
  }

  if (options?.sourceTypes && options.sourceTypes.length > 0) {
    const placeholders = options.sourceTypes.map(() => '?').join(',')
    whereClause += ` AND kms_fts.source_type IN (${placeholders})`
    params.push(...options.sourceTypes)
  }

  if (options?.timeRangeStart || options?.timeRangeEnd) {
    whereClause += ' AND f.id = kms_fts.file_id'
    if (options.timeRangeStart) {
      whereClause += ' AND f.modified_time >= ?'
      params.push(options.timeRangeStart)
    }
    if (options.timeRangeEnd) {
      whereClause += ' AND f.modified_time <= ?'
      params.push(options.timeRangeEnd)
    }
  }

  if (options?.fileExtensions && options.fileExtensions.length > 0) {
    const placeholders = options.fileExtensions.map(() => '?').join(',')
    whereClause += ` AND f.file_ext IN (${placeholders})`
    params.push(...options.fileExtensions)
  }

  if (options?.collectionIds && options.collectionIds.length > 0) {
    const placeholders = options.collectionIds.map(() => '?').join(',')
    whereClause += ` AND kms_fts.file_id IN (SELECT file_id FROM kms_file_collections WHERE collection_id IN (${placeholders}))`
    params.push(...options.collectionIds)
  }

  if (options?.dirIds && options.dirIds.length > 0) {
    const placeholders = options.dirIds.map(() => '?').join(',')
    whereClause += ` AND kms_fts.file_id IN (SELECT id FROM kms_files WHERE dir_id IN (${placeholders}))`
    params.push(...options.dirIds)
  }

  return { whereClause, params }
}

export function cosineSimilarity(a: Float32Array, b: Float32Array, normA?: number): number {
  // 防御性检查：a 或 b 为 null/undefined/空数组时直接返回 0，
  // 避免下游 norm() 或 Math.min() 抛出 "Cannot read properties of null (reading 'length')"
  if (!a || !b || a.length === 0 || b.length === 0) return 0
  const na = normA ?? norm(a)
  const nb = norm(b)
  if (na === 0 || nb === 0) return 0

  let dot = 0
  const len = Math.min(a.length, b.length)
  for (let i = 0; i < len; i++) {
    dot += a[i] * b[i]
  }
  return dot / (na * nb)
}

export function norm(vec: Float32Array): number {
  if (!vec || vec.length === 0) return 0
  let sum = 0
  for (let i = 0; i < vec.length; i++) {
    sum += vec[i] * vec[i]
  }
  return Math.sqrt(sum)
}

export function getResultKey(result: SearchResult): string {
  if (result.paragraph_id) return `paragraph-${result.paragraph_id}`
  if (result.match_type === 'content_paragraph' && result.start_offset !== undefined) {
    return `content-${result.file_id}-${result.start_offset}`
  }
  return `${result.match_type}-${result.file_id}`
}
