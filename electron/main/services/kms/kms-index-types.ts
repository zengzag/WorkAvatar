export type IndexPhase =
  | 'crawling'
  | 'parsing'
  | 'indexing'
  | 'toc'
  | 'paragraph_split'
  | 'paragraph_summary'
  | 'doc_summary'
  | 'collection_summary'
  | 'collection_embedding'
  | 'embedding'
  | 'done'
  | 'error'

export interface IndexProgress {
  phase: IndexPhase
  current: number
  total: number
  message: string
  fileId?: string
  fileName?: string
  collectionId?: string
  collectionName?: string
  startedAt?: number
  cancelled?: boolean
}

export type ProgressCallback = (progress: IndexProgress) => void

export interface AutoIndexConfig {
  enabled: boolean
  intervalMinutes: number
  stableThresholdSeconds: number
}

export interface AutoIndexStatus {
  running: boolean
  config: AutoIndexConfig
  lastRunAt: number | null
  nextRunAt: number | null
  lastResult: { newFiles: number; modifiedFiles: number; deletedFiles: number; skippedUnstableFiles: number } | null
}
