import DatabaseService from './database.service'
import { SecureKeyStorage } from './secure-key-storage'
import { createLogger } from './logger'
import type { SearchApiProviderId, SearchApiStatus, WebSearchMode } from '../../shared/channels/tool'

const logger = createLogger('SearchApi')

/** settings 键：搜索后端（browser=本地浏览器抓取，api=搜索 API） */
export const WEB_SEARCH_MODE_KEY = 'web_search_mode'
/** settings 键：API 模式下使用的服务商 */
export const WEB_SEARCH_API_PROVIDER_KEY = 'web_search_api_provider'

export const SEARCH_API_PROVIDERS: SearchApiProviderId[] = ['deepseek', 'tavily', 'brave']

const PROVIDER_NAMES: Record<SearchApiProviderId, string> = {
  deepseek: 'DeepSeek',
  tavily: 'Tavily',
  brave: 'Brave Search'
}

const DEFAULT_PROVIDER: SearchApiProviderId = 'deepseek'
const REQUEST_TIMEOUT_MS = 20000
/** 单条摘要上限：避免超长正文把工具结果撑爆上下文 */
const MAX_SNIPPET_CHARS = 800

export interface SearchApiResult {
  title: string
  url: string
  snippet: string
  publishedAt?: string
  siteName?: string
}

export interface SearchApiSearchResult {
  provider: SearchApiProviderId
  providerName: string
  results: SearchApiResult[]
}

export function isWebSearchMode(value: unknown): value is WebSearchMode {
  return value === 'browser' || value === 'api'
}

export function isSearchApiProvider(value: unknown): value is SearchApiProviderId {
  return typeof value === 'string' && (SEARCH_API_PROVIDERS as string[]).includes(value)
}

function readSetting(key: string): string | null {
  try {
    const db = DatabaseService.getInstance().getDb()
    const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as any
    return row?.value ?? null
  } catch {
    return null
  }
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function truncate(value: string): string {
  return value.length > MAX_SNIPPET_CHARS ? `${value.slice(0, MAX_SNIPPET_CHARS)}…` : value
}

function stripHtml(value: string): string {
  return value
    .replace(/<[^>]*>/g, '')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim()
}

const HTTP_STATUS_HINTS: Record<number, string> = {
  400: '请求参数无效',
  401: 'API Key 无效或未授权',
  402: '账户余额不足',
  403: '访问被拒绝',
  404: '接口不存在',
  408: '请求超时',
  413: '请求体过大',
  429: '请求频率超限',
  500: '服务端错误',
  504: '上游请求超时'
}

function describeHttpError(status: number, body: string): string {
  let detail = ''
  try {
    const parsed = JSON.parse(body)
    const raw = parsed?.error?.message ?? parsed?.error ?? parsed?.detail?.error ?? parsed?.detail ?? parsed?.message
    detail = typeof raw === 'string' ? raw : ''
  } catch {
    detail = body.slice(0, 200)
  }
  const hint = HTTP_STATUS_HINTS[status]
  const head = hint ? `HTTP ${status}（${hint}）` : `HTTP ${status}`
  return detail ? `${head}: ${detail}` : head
}

/** 统一 JSON 请求：20s 超时、非 2xx 抛带服务商错误信息的异常 */
async function requestJson(url: string, init: RequestInit): Promise<any> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
  try {
    const response = await fetch(url, { ...init, signal: controller.signal })
    const body = await response.text()
    if (!response.ok) throw new Error(describeHttpError(response.status, body))
    if (!body) return {}
    try {
      return JSON.parse(body)
    } catch {
      throw new Error('响应不是合法的 JSON')
    }
  } catch (error: any) {
    if (error?.name === 'AbortError') throw new Error(`请求超时（${REQUEST_TIMEOUT_MS / 1000}s）`)
    throw error
  } finally {
    clearTimeout(timer)
  }
}

/** 结果归一化：过滤非法 URL、按 URL 去重、截断过长摘要 */
function normalizeResults(items: any[], map: (item: any) => SearchApiResult): SearchApiResult[] {
  if (!Array.isArray(items)) return []
  const seen = new Set<string>()
  const results: SearchApiResult[] = []
  for (const item of items) {
    if (!item || typeof item !== 'object') continue
    const mapped = map(item)
    if (!mapped.url.startsWith('http') || seen.has(mapped.url)) continue
    seen.add(mapped.url)
    results.push({
      ...mapped,
      title: mapped.title || mapped.url,
      snippet: truncate(mapped.snippet)
    })
  }
  return results
}

async function searchDeepSeek(query: string, count: number, apiKey: string): Promise<SearchApiResult[]> {
  const payload = await requestJson('https://api.deepseek.com/v1/tools/search', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      Accept: 'application/json'
    },
    body: JSON.stringify({ query, count })
  })
  return normalizeResults(payload?.results, (item) => {
    const result: SearchApiResult = {
      title: text(item.title),
      url: text(item.url),
      // summary 面向模型（更长），snippet 面向展示；优先使用 summary
      snippet: text(item.summary) || text(item.snippet)
    }
    if (text(item.date)) result.publishedAt = text(item.date)
    if (text(item.site_name)) result.siteName = text(item.site_name)
    return result
  })
}

async function searchTavily(query: string, count: number, apiKey: string): Promise<SearchApiResult[]> {
  const payload = await requestJson('https://api.tavily.com/search', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      Accept: 'application/json'
    },
    body: JSON.stringify({ query, max_results: count, search_depth: 'basic', include_answer: false })
  })
  return normalizeResults(payload?.results, (item) => {
    const result: SearchApiResult = {
      title: text(item.title),
      url: text(item.url),
      snippet: text(item.content)
    }
    if (text(item.published_date)) result.publishedAt = text(item.published_date)
    return result
  })
}

async function searchBrave(query: string, count: number, apiKey: string): Promise<SearchApiResult[]> {
  const url = new URL('https://api.search.brave.com/res/v1/web/search')
  url.searchParams.set('q', query)
  url.searchParams.set('count', String(count))
  const payload = await requestJson(url.toString(), {
    method: 'GET',
    headers: {
      'X-Subscription-Token': apiKey,
      Accept: 'application/json'
    }
  })
  return normalizeResults(payload?.web?.results, (item) => {
    const result: SearchApiResult = {
      title: text(item.title),
      url: text(item.url),
      snippet: stripHtml(text(item.description))
    }
    if (text(item.page_age)) result.publishedAt = text(item.page_age)
    if (text(item.profile?.name)) result.siteName = text(item.profile.name)
    return result
  })
}

async function callProvider(
  provider: SearchApiProviderId,
  query: string,
  count: number,
  apiKey: string
): Promise<SearchApiResult[]> {
  switch (provider) {
    case 'deepseek':
      return searchDeepSeek(query, count, apiKey)
    case 'tavily':
      return searchTavily(query, count, apiKey)
    case 'brave':
      return searchBrave(query, count, apiKey)
  }
}

/**
 * 搜索 API 服务：读取搜索后端配置、加密读写各服务商 API Key、调用对应搜索接口。
 * 与本地浏览器抓取（InternetSearchService）互斥，由 web_search 工具按设置选择。
 */
export class SearchApiService {
  private static instance: SearchApiService | null = null
  private keyStorage: SecureKeyStorage | null = null

  public static getInstance(): SearchApiService {
    if (!SearchApiService.instance) {
      SearchApiService.instance = new SearchApiService()
    }
    return SearchApiService.instance
  }

  public getMode(): WebSearchMode {
    const value = readSetting(WEB_SEARCH_MODE_KEY)
    return isWebSearchMode(value) ? value : 'browser'
  }

  public getProvider(): SearchApiProviderId {
    const value = readSetting(WEB_SEARCH_API_PROVIDER_KEY)
    return isSearchApiProvider(value) ? value : DEFAULT_PROVIDER
  }

  public getProviderName(provider: SearchApiProviderId): string {
    return PROVIDER_NAMES[provider] ?? provider
  }

  public async getApiKey(provider: SearchApiProviderId): Promise<string | null> {
    try {
      return await this.getKeyStorage().getSearchApiKey(provider)
    } catch (error: any) {
      logger.error(`读取 ${provider} 搜索 API Key 失败:`, error?.message || error)
      return null
    }
  }

  public async getStatus(): Promise<SearchApiStatus> {
    const providers = await Promise.all(
      SEARCH_API_PROVIDERS.map(async (id) => ({
        id,
        name: PROVIDER_NAMES[id],
        hasKey: (await this.getApiKey(id)) !== null
      }))
    )
    return { mode: this.getMode(), provider: this.getProvider(), providers }
  }

  public async saveApiKey(provider: string, apiKey: string): Promise<void> {
    if (!isSearchApiProvider(provider)) throw new Error('不支持的搜索服务商')
    const value = String(apiKey || '').trim()
    if (!value) throw new Error('API Key 不能为空')
    await this.getKeyStorage().saveSearchApiKey(provider, value)
    logger.info(`Saved search API key for ${provider}`)
  }

  public async clearApiKey(provider: string): Promise<void> {
    if (!isSearchApiProvider(provider)) throw new Error('不支持的搜索服务商')
    await this.getKeyStorage().deleteSearchApiKey(provider)
    logger.info(`Cleared search API key for ${provider}`)
  }

  public async search(query: string, count: number): Promise<SearchApiSearchResult> {
    const provider = this.getProvider()
    const providerName = this.getProviderName(provider)
    const apiKey = await this.getApiKey(provider)
    if (!apiKey) throw new Error(`未配置 ${providerName} 的 API Key`)
    const results = await callProvider(provider, query, count, apiKey)
    return { provider, providerName, results }
  }

  private getKeyStorage(): SecureKeyStorage {
    if (!this.keyStorage) {
      this.keyStorage = new SecureKeyStorage(DatabaseService.getInstance().getDb())
    }
    return this.keyStorage
  }
}

export const searchApiService = SearchApiService.getInstance()
