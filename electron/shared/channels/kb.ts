export const KB_CHANNELS = {
  KB_LIST: 'kb:list',
  KB_GET: 'kb:get',
  KB_CREATE: 'kb:create',
  KB_UPDATE: 'kb:update',
  KB_DELETE: 'kb:delete',
  KB_DOC_UPLOAD: 'kb:doc-upload',
  KB_DOC_PARSE: 'kb:doc-parse',
  KB_DOC_DELETE: 'kb:doc-delete',
  KB_DOC_LIST: 'kb:doc-list',
  KB_PARSE_ALL: 'kb:parse-all',
  KB_PROCESS_DOCUMENT: 'kb:process-document',
  KB_PROCESS_ALL: 'kb:process-all',
  KB_BUILD_GLOBAL: 'kb:build-global',
  KB_GET_STATS: 'kb:get-stats',
  KB_GET_PARAGRAPHS: 'kb:get-paragraphs',
  KB_GET_DOC_SUMMARY: 'kb:get-doc-summary',
  KB_GET_ALL_DOC_SUMMARIES: 'kb:get-all-doc-summaries',
  KB_GET_GLOBAL_SUMMARY: 'kb:get-global-summary',
  KB_SEARCH_PARAGRAPHS: 'kb:search-paragraphs',
  KB_GET_DOC_CONTENT: 'kb:get-doc-content',
  KB_UPLOAD_PROGRESS: 'kb:upload-progress',
  KB_PARSE_PROGRESS: 'kb:parse-progress',
  KB_PARSE_ALL_PROGRESS: 'kb:parse-all-progress',
  KB_PROCESS_PROGRESS: 'kb:process-progress',
  KB_PROCESS_ALL_PROGRESS: 'kb:process-all-progress',
  KB_BUILD_GLOBAL_PROGRESS: 'kb:build-global-progress',
  KB_PAUSE_PARSE: 'kb:pause-parse',
  KB_RESUME_PARSE: 'kb:resume-parse',
  KB_RETRY_PARSE: 'kb:retry-parse',
  KB_GET_PARSE_DETAIL: 'kb:get-parse-detail',
  KB_PAUSE_ALL_PARSES: 'kb:pause-all-parses',
  KB_RESUME_ALL_PARSES: 'kb:resume-all-parses',
  KB_CANCEL_ALL_PARSES: 'kb:cancel-all-parses',
  KB_EXPORT_FULL: 'kb:export-full',
  KB_EXPORT_SUMMARY: 'kb:export-summary',
  KB_EXPORT_DOCUMENTS: 'kb:export-documents',
  KB_SCAN_FOLDER: 'kb:scan-folder',
  KB_IMPORT_FULL: 'kb:import-full',
  KB_EXPORT_PROGRESS: 'kb:export-progress',
  KB_IMPORT_PROGRESS: 'kb:import-progress',
  KB_SEARCH: 'kb:search',
  KB_ADVANCED_SEARCH: 'kb:advanced-search',
  KB_SEARCH_WITH_EMBEDDING: 'kb:search-with-embedding',
  KB_SEARCH_INDEX_STATS: 'kb:search-index-stats',
  KB_REBUILD_SEARCH_INDEX: 'kb:rebuild-search-index',
} as const

export interface KBCreateParams {
  name: string
  description?: string
}

export interface KBUpdateParams {
  id: string
  name?: string
  description?: string
}

export interface KBDocParseParams {
  doc_id: string
  provider_id?: string
}

export interface KBProcessDocumentParams {
  doc_id: string
  provider_id?: string
  model_id?: string
  enable_thinking?: boolean
}

export interface KBProcessAllParams {
  kb_id: string
  provider_id?: string
  model_id?: string
  enable_thinking?: boolean
}

export interface KBBuildGlobalParams {
  kb_id: string
  provider_id?: string
  model_id?: string
  enable_thinking?: boolean
}

export interface KBExportFullParams {
  kb_id: string
  export_path: string
}

export interface KBExportSummaryParams {
  kb_id: string
  export_path: string
  format: 'json-ld' | 'csv'
}

export interface KBExportDocumentsParams {
  kb_id: string
  export_path: string
  doc_ids?: string[]
}

export interface KBImportFullParams {
  import_path: string
  kb_name?: string
  conflict_strategy: 'skip' | 'overwrite' | 'rename'
}

