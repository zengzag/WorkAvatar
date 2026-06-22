export const KMS_CHANNELS = {
  KMS_LIST_DIRS: 'kms:list-dirs',
  KMS_ADD_DIR: 'kms:add-dir',
  KMS_UPDATE_DIR: 'kms:update-dir',
  KMS_DELETE_DIR: 'kms:delete-dir',
  KMS_SEARCH: 'kms:search',
  KMS_GET_FILE_CONTENT: 'kms:get-file-content',
  KMS_GET_FILE_SUMMARY: 'kms:get-file-summary',
  KMS_BUILD_INDEX: 'kms:build-index',
  KMS_INCREMENTAL_INDEX: 'kms:incremental-index',
  KMS_REBUILD_DIR_INDEX: 'kms:rebuild-dir-index',
  KMS_CANCEL_INDEX: 'kms:cancel-index',
  KMS_GET_STATS: 'kms:get-stats',
  KMS_INDEX_PROGRESS: 'kms:index-progress',
} as const

export interface KMSAddDirParams {
  dirPath: string
  displayName?: string
  recursive?: boolean
  fileExtensions?: string[]
}

export interface KMSUpdateDirParams {
  id: string
  displayName?: string
  enabled?: boolean
  recursive?: boolean
  fileExtensions?: string[]
}

export interface KMSSearchParams {
  query: string
  topK?: number
  fileIds?: string[]
  sourceTypes?: string[]
  useSemantic?: boolean
  timeRangeStart?: number
  timeRangeEnd?: number
  fileExtensions?: string[]
}

export interface KMSGetFileContentParams {
  fileId: string
  paragraphId?: string
  startOffset?: number
  endOffset?: number
  startLine?: number
  maxChars?: number
}
