export type SourceType = 'file_title' | 'file_summary' | 'paragraph' | 'content_paragraph' | 'file_name'

export interface HighlightRange {
  start: number
  end: number
}

export interface SearchResult {
  file_id: string
  file_name: string
  file_path: string
  paragraph_id?: string
  paragraph_title?: string
  text: string
  match_type: SourceType | 'hybrid'
  start_offset?: number
  end_offset?: number
  start_line?: number
  end_line?: number
  score?: number
  highlights?: HighlightRange[]
  matched_keywords?: string[]
  modified_time?: number
}

export interface SearchOptions {
  topK?: number
  fileIds?: string[]
  sourceTypes?: SourceType[]
  useVector?: boolean
  timeRangeStart?: number
  timeRangeEnd?: number
  fileExtensions?: string[]
  collectionIds?: string[]
  dirIds?: string[]
}

export interface EmbeddingEntry {
  id: string
  sourceType: string
  sourceId: string
  fileId: string
  embedding: Float32Array
  model: string
  dimension: number
}
