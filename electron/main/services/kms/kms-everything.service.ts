import path from 'path'
import { createLogger } from '../logger'
import { getKmsSettings, type KmsFileSearchSettings } from './kms-config-helpers'

const logger = createLogger('KMS-Everything')

/** 本地 HTTP 请求超时：Everything 未启动时连接会被立即拒绝，超时仅兜底服务无响应 */
const REQUEST_TIMEOUT_MS = 4000
/** Windows FILETIME：1601-01-01 起的 100ns 计数 */
const FILETIME_EPOCH_OFFSET = 116444736000000000n
const FILETIME_TICKS_PER_SECOND = 10000000n

/** 与内置文件搜索保持一致的分词规则 */
const QUERY_SPLIT_RE = /[\s,，。；;：:、？?！!/\\()（）【】\[\]{}'"]+/

export interface EverythingSearchScope {
  dirPath: string
  recursive: boolean
  /** 目录配置的扩展名限制，空集合表示不限制 */
  extensions: Set<string>
  /** 索引目录额外受内置支持的扩展名限制，保证与内置搜索范围一致 */
  allowedExtensions?: Set<string>
}

export interface EverythingSearchOptions {
  count: number
  scopes: EverythingSearchScope[]
  fileExtensions?: string[]
  timeRangeStart?: number
  timeRangeEnd?: number
}

export interface EverythingFileItem {
  file_path: string
  file_name: string
  file_ext: string
  file_size: number
  modified_time: number
}

export interface EverythingTestResult {
  available: boolean
  error?: string
  totalResults?: number
}

interface EverythingRawResponse {
  totalResults?: number
  results?: Array<{
    type?: string
    name?: string
    path?: string
    size?: number | string
    date_modified?: number | string
  }>
}

function normalizeConfig(config?: Partial<KmsFileSearchSettings['everything']>): { host: string; port: number } {
  const host = String(config?.host || '127.0.0.1').trim() || '127.0.0.1'
  const rawPort = Number(config?.port)
  const port = Number.isFinite(rawPort) && rawPort > 0 && rawPort <= 65535 ? Math.floor(rawPort) : 80
  return { host, port }
}

function formatQueryDate(ms: number): string {
  const d = new Date(ms)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

/** 引号内的一切操作符都按字面量处理，因此逐词加引号等价于内置搜索的 LIKE %term% */
function quoteTerm(term: string): string {
  return `"${term.replace(/"/g, '')}"`
}

function normalizeDirForQuery(dirPath: string): string {
  const p = dirPath.replace(/\//g, '\\')
  return p.endsWith('\\') ? p : p + '\\'
}

export function buildEverythingQuery(query: string, options: EverythingSearchOptions): string {
  const terms = query.split(QUERY_SPLIT_RE).map(t => t.trim()).filter(Boolean)
  if (terms.length === 0) return ''

  const parts = terms.map(quoteTerm)
  if (options.fileExtensions && options.fileExtensions.length > 0) {
    const exts = options.fileExtensions
      .map(e => e.trim().toLowerCase().replace(/^\./, ''))
      .filter(Boolean)
    if (exts.length > 0) parts.push(`ext:${exts.join(';')}`)
  }
  if (options.timeRangeStart !== undefined || options.timeRangeEnd !== undefined) {
    const start = options.timeRangeStart ?? 0
    const end = options.timeRangeEnd ?? Date.now()
    parts.push(`dm:${formatQueryDate(start)}..${formatQueryDate(end)}`)
  }
  if (options.scopes.length === 1) {
    parts.push(`"${normalizeDirForQuery(options.scopes[0].dirPath)}"`)
  } else if (options.scopes.length > 1) {
    // 用 < > 显式分组，避免依赖 Everything 的 AND/OR 优先级设置
    parts.push(`<${options.scopes.map(s => `"${normalizeDirForQuery(s.dirPath)}"`).join('|')}>`)
  }
  return parts.join(' ')
}

export function filetimeToUnixSeconds(value: number | string | null | undefined): number {
  if (value === undefined || value === null || value === '') return 0
  const raw = String(value)
  if (!/^\d+$/.test(raw)) {
    const parsed = Date.parse(raw)
    return Number.isFinite(parsed) ? Math.floor(parsed / 1000) : 0
  }
  try {
    const ticks = BigInt(raw)
    if (ticks <= FILETIME_EPOCH_OFFSET) return 0
    return Number((ticks - FILETIME_EPOCH_OFFSET) / FILETIME_TICKS_PER_SECOND)
  } catch {
    return 0
  }
}

/**
 * Everything 文件搜索（通过 Everything 内置 HTTP 服务器）
 *
 * 使用前提：Everything 已启动，并在 工具 → 选项 → HTTP 服务器 中启用 HTTP 服务器。
 * 默认只访问本机回环地址；任何失败都由调用方回退到内置文件搜索。
 */
class KMSEverythingService {
  private static instance: KMSEverythingService

  static getInstance(): KMSEverythingService {
    if (!KMSEverythingService.instance) {
      KMSEverythingService.instance = new KMSEverythingService()
    }
    return KMSEverythingService.instance
  }

  getConfig(): { host: string; port: number } {
    return normalizeConfig(getKmsSettings().fileSearch.everything)
  }

  async search(query: string, options: EverythingSearchOptions): Promise<EverythingFileItem[]> {
    const searchText = buildEverythingQuery(query, options)
    if (!searchText) return []

    const data = await this.request(this.getConfig(), {
      search: searchText,
      count: options.count,
      sort: 'date_modified',
      ascending: 0,
    })
    const rows = Array.isArray(data.results) ? data.results : []
    const items: EverythingFileItem[] = []
    for (const row of rows) {
      if (!row) continue
      if (row.type && row.type !== 'file') continue
      const name = typeof row.name === 'string' ? row.name : ''
      if (!name) continue
      const dir = typeof row.path === 'string' ? row.path : ''
      const filePath = dir ? path.join(dir, name) : name
      items.push({
        file_path: filePath,
        file_name: name,
        file_ext: path.extname(name).toLowerCase().slice(1),
        file_size: Number(row.size) || 0,
        modified_time: filetimeToUnixSeconds(row.date_modified),
      })
    }
    return items
  }

  async testConnection(config?: Partial<KmsFileSearchSettings['everything']>): Promise<EverythingTestResult> {
    const cfg = normalizeConfig(config)
    try {
      const data = await this.request(cfg, { search: '', count: 1 })
      return { available: true, totalResults: Number(data.totalResults) || 0 }
    } catch (err: any) {
      const message = String(err?.message || err)
      logger.warn(`Everything 连接检测失败 (${cfg.host}:${cfg.port}): ${message}`)
      return { available: false, error: message }
    }
  }

  private async request(
    config: { host: string; port: number },
    params: Record<string, string | number>,
  ): Promise<EverythingRawResponse> {
    const url = new URL(`http://${config.host}:${config.port}/`)
    url.searchParams.set('json', '1')
    url.searchParams.set('path_column', '1')
    url.searchParams.set('size_column', '1')
    url.searchParams.set('date_modified_column', '1')
    for (const [key, value] of Object.entries(params)) {
      url.searchParams.set(key, String(value))
    }

    const res = await fetch(url.toString(), { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) })
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}${res.status === 401 ? '（需要用户名/密码）' : ''}`)
    }
    const text = await res.text()
    let data: EverythingRawResponse
    try {
      data = JSON.parse(text) as EverythingRawResponse
    } catch {
      throw new Error('Everything 返回的不是 JSON，请确认 HTTP 服务器已启用')
    }
    if (!data || typeof data.totalResults === 'undefined') {
      throw new Error('Everything 响应格式不正确')
    }
    return data
  }
}

export default KMSEverythingService
