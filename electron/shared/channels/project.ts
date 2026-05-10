import type { Project, File, ParseResult } from '../types'

export const PROJECT_CHANNELS = {
  PROJECT_LIST: 'project:list',
  PROJECT_GET: 'project:get',
  PROJECT_CREATE: 'project:create',
  PROJECT_UPDATE: 'project:update',
  PROJECT_DELETE: 'project:delete',

  FILE_LIST: 'file:list',
  FILE_GET: 'file:get',
  FILE_IMPORT: 'file:import',
  FILE_DELETE: 'file:delete',
  FILE_PARSE: 'file:parse',
  FILE_GET_CONTENT: 'file:get-content',
} as const

export interface ProjectListParams {
  limit?: number
  offset?: number
}

export interface ProjectListResult {
  projects: Project[]
  total: number
}

export interface ProjectCreateParams {
  name: string
  description?: string
  root_path: string
}

export interface ProjectUpdateParams {
  id: string
  name?: string
  description?: string
  root_path?: string
  llm_provider_id?: string
}

export interface FileListParams {
  project_id: string
  status?: string
}

export interface FileListResult {
  files: File[]
  total: number
}

export interface FileImportParams {
  project_id: string
  paths: string[]
}

export interface FileImportResult {
  success: boolean
  imported: Array<{ id: string; path: string; original_name: string }>
  errors: Array<{ path: string; error: string }>
}

export interface FileParseParams {
  file_id: string
}

export interface FileParseResult {
  success: boolean
  result?: ParseResult
  error?: string
}

export interface FileGetContentParams {
  file_id: string
}

export interface FileGetContentResult {
  success: boolean
  content?: string
  error?: string
}