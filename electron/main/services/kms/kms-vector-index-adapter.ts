import KMSSearchEngineService from './kms-search-engine.service'
import type { SearchOptions } from './kms-search-types'

export type VectorIndexBackend = 'sqlite-vec' | 'hnsw-sidecar' | 'lancedb'

export interface VectorRecord {
  sourceType: string
  sourceId: string
  fileId: string
  embedding: Float32Array
  model: string
}

export interface VectorQuery {
  embedding: Float32Array
  topK: number
  embeddingModel?: string
  fileIds?: string[]
  sourceTypes?: string[]
  timeRangeStart?: number
  timeRangeEnd?: number
  fileExtensions?: string[]
  collectionIds?: string[]
  dirIds?: string[]
}

export interface VectorQueryResult {
  sourceType: string
  sourceId: string
  fileId: string
  score: number
}

export interface VectorIndexAdapter {
  readonly backend: VectorIndexBackend
  upsertMany(records: VectorRecord[]): void
  deleteByFiles(fileIds: string[]): void
  search(query: VectorQuery): VectorQueryResult[]
  stats(): Record<string, unknown>
}

export class SqliteVecIndexAdapter implements VectorIndexAdapter {
  readonly backend: VectorIndexBackend = 'sqlite-vec'

  constructor(private readonly engine: {
    storeEmbeddingsBatch: KMSSearchEngineService['storeEmbeddingsBatch']
    deleteEmbeddingsByFilesPublic: KMSSearchEngineService['deleteEmbeddingsByFilesPublic']
    vectorSearch: (embedding: Float32Array, options?: SearchOptions) => VectorQueryResult[]
    getIndexStats: KMSSearchEngineService['getIndexStats']
  } = KMSSearchEngineService.getInstance()) {}

  upsertMany(records: VectorRecord[]): void {
    this.engine.storeEmbeddingsBatch(records)
  }

  deleteByFiles(fileIds: string[]): void {
    this.engine.deleteEmbeddingsByFilesPublic(fileIds)
  }

  search(query: VectorQuery): VectorQueryResult[] {
    return this.engine.vectorSearch(query.embedding, {
      topK: query.topK,
      fileIds: query.fileIds,
      sourceTypes: query.sourceTypes as any,
      timeRangeStart: query.timeRangeStart,
      timeRangeEnd: query.timeRangeEnd,
      fileExtensions: query.fileExtensions,
      collectionIds: query.collectionIds,
      dirIds: query.dirIds,
      embeddingModel: query.embeddingModel,
    })
  }

  stats(): Record<string, unknown> {
    return this.engine.getIndexStats()
  }
}
