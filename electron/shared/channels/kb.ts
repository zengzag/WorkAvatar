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
  KB_LINK_PROJECT: 'kb:link-project',
  KB_UNLINK_PROJECT: 'kb:unlink-project',
  KB_GET_PROJECTS: 'kb:get-projects',
  KB_PARSE_ALL: 'kb:parse-all',
  KB_GET_FILE_BY_HASH: 'kb:get-file-by-hash',
  KB_IMPORT_DOCS_TO_PROJECT: 'kb:import-docs-to-project',
  KB_PROCESS_DOCUMENT: 'kb:process-document',
  KB_PROCESS_ALL: 'kb:process-all',
  KB_BUILD_GLOBAL: 'kb:build-global',
  KB_GET_STATS: 'kb:get-stats',
  KB_GET_CHAPTERS: 'kb:get-chapters',
  KB_GET_DOC_SUMMARY: 'kb:get-doc-summary',
  KB_GET_GLOBAL_SUMMARY: 'kb:get-global-summary',
  KB_GET_ENTITIES: 'kb:get-entities',
  KB_GET_ENTITY: 'kb:get-entity',
  KB_GET_ENTITY_RELATIONS: 'kb:get-entity-relations',
  KB_GET_ENTITY_MENTIONS: 'kb:get-entity-mentions',
  KB_SEARCH_CHAPTERS: 'kb:search-chapters',
  KB_SEARCH_DOC_SUMMARIES: 'kb:search-doc-summaries',
  KB_GENERATE_TIMELINE: 'kb:generate-timeline',
  KB_GET_PROCESSING_JOBS: 'kb:get-processing-jobs',
  KB_GET_KBS_FOR_PROJECT: 'kb:get-kbs-for-project',
  KB_GET_DOC_CONTENT: 'kb:get-doc-content',
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

export interface KBDocUploadParams {
  kb_id: string
  paths: string[]
}

export interface KBDocParseParams {
  doc_id: string
  provider_id?: string
}

export interface KBLinkProjectParams {
  kb_id: string
  project_id: string
}

export interface KBGetFileByHashParams {
  hash: string
}

export interface KBProcessDocumentParams {
  doc_id: string
  provider_id?: string
  model_id?: string
}

export interface KBProcessAllParams {
  kb_id: string
  provider_id?: string
  model_id?: string
}

export interface KBBuildGlobalParams {
  kb_id: string
  provider_id?: string
  model_id?: string
}

export interface KBGetEntitiesParams {
  kb_id: string
  type?: string
}

export interface KBGetEntityParams {
  kb_id: string
  name: string
}

export interface KBGetEntityRelationsParams {
  entity_id: string
  depth?: number
}

export interface KBSearchChaptersParams {
  kb_id: string
  query: string
  top_k?: number
}

export interface KBSearchDocSummariesParams {
  kb_id: string
  query: string
  top_k?: number
}

export interface KBGenerateTimelineParams {
  kb_id: string
  topic?: string
}

export interface KBGetDocContentParams {
  doc_id: string
}
