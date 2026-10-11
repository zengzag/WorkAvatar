import { BrowserWindow } from 'electron'
import { createLogger } from './logger'

const logger = createLogger('InternetSearch')

export type SearchEngine = 'google' | 'bing' | 'baidu' | 'duckduckgo'

export interface SearchResult {
  title: string
  url: string
  snippet: string
}

export interface SearchEngineInfo {
  id: SearchEngine
  name: string
  urlTemplate: string
  homepage: string
}

export interface SearchOptions {
  /** 页面加载超时（毫秒），超时按失败处理，交由上层降级到其他引擎 */
  loadTimeoutMs?: number
  /** 加载完成后等待结果动态渲染的上限（毫秒） */
  renderWaitMs?: number
}

interface SearchEngineConfig {
  name: string
  urlTemplate: string
  homepage: string
  extractScript: string
}

/**
 * UA 必须与平台一致且版本号与真实 Chromium 相同：
 * 版本过旧或平台不符会被百度判定为机器流量，直接跳转安全验证页（实测复现）。
 */
function buildUserAgent(): string {
  const chrome = process.versions.chrome || '134.0.0.0'
  const platform =
    process.platform === 'darwin'
      ? 'Macintosh; Intel Mac OS X 10_15_7'
      : process.platform === 'linux'
        ? 'X11; Linux x86_64'
        : 'Windows NT 10.0; Win64; x64'
  return `Mozilla/5.0 (${platform}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chrome} Safari/537.36`
}

const USER_AGENT = buildUserAgent()
const ACCEPT_LANGUAGE = 'zh-CN,zh;q=0.9,en;q=0.8'

/**
 * 持久化会话：跨搜索复用 Cookie/缓存/连接，避免每次冷启动。
 * v2：旧分区曾被旧版 UA 触发的百度验证码/异常 Cookie 污染，重置一次。
 */
const SESSION_PARTITION = 'persist:internet-search-v2'
const DEFAULT_LOAD_TIMEOUT_MS = 6000
const DEFAULT_RENDER_WAIT_MS = 1200
const RENDER_POLL_INTERVAL_MS = 150
const CACHE_TTL_MS = 5 * 60 * 1000
const CACHE_MAX_ENTRIES = 50

const SEARCH_ENGINES: Record<SearchEngine, SearchEngineConfig> = {
  google: {
    name: 'Google',
    urlTemplate: 'https://www.google.com/search?q=%s',
    homepage: 'https://www.google.com',
    extractScript: `
      (function() {
        var results = [];
        var items = document.querySelectorAll('#search .MjjYud');
        items.forEach(function(item) {
          var titleEl = item.querySelector('h3');
          var linkEl = item.querySelector('a');
          var snippetEl = item.querySelector('.VwiC3b, [data-sncf], .lEBKkf span');
          if (titleEl && linkEl) {
            results.push({
              title: titleEl.textContent.trim(),
              url: linkEl.href,
              snippet: (snippetEl && snippetEl.textContent || '').trim()
            });
          }
        });
        return results;
      })()
    `
  },
  bing: {
    name: 'Bing',
    // 不要附加 &ensearch=1（会让中文查询返回无关英文结果）；mkt=zh-CN 固定中国市场，
    // 防止分区 Cookie 漂移导致中文长查询 0 结果时自动降级为部分词匹配
    urlTemplate: 'https://cn.bing.com/search?q=%s&mkt=zh-CN',
    homepage: 'https://cn.bing.com',
    extractScript: `
      (function() {
        var results = [];
        var items = document.querySelectorAll('#b_results h2');
        items.forEach(function(item) {
          var linkEl = item.querySelector('a');
          if (!linkEl) return;
          var snippetEl = item.closest('li') ? item.closest('li').querySelector('.b_caption p, .b_algoSlug') : null;
          var href = linkEl.href;
          try {
            var u = new URL(href);
            var encoded = u.searchParams.get('u');
            if (encoded && encoded.substring(0, 2) === 'a1') {
              href = atob(encoded.substring(2));
              if (!href.startsWith('http')) href = linkEl.href;
            }
          } catch(e) {}
          results.push({
            title: linkEl.textContent.trim(),
            url: href,
            snippet: (snippetEl && snippetEl.textContent || '').trim()
          });
        });
        return results;
      })()
    `
  },
  baidu: {
    name: '百度',
    urlTemplate: 'https://www.baidu.com/s?wd=%s',
    homepage: 'https://www.baidu.com',
    extractScript: `
      (function() {
        var results = [];
        // 百度结果块：普通结果 .result 与结构化结果 .result-op（均已排除 .u2a6nht 等广告块）
        var blocks = document.querySelectorAll('#content_left > div.result, #content_left > div.result-op');
        blocks.forEach(function(el) {
          var linkEl = el.querySelector('h3 a');
          if (!linkEl) return;
          var title = linkEl.textContent.trim();
          // 结果块上的 mu 属性即真实目标地址，比 baidu.com/link?url= 跳转链更可靠
          var href = el.getAttribute('mu') || linkEl.href;
          if (!href || href.indexOf('nourl.') !== -1) return;
          var snippet = '';
          var cands = el.querySelectorAll('.c-abstract, [class*="abstract"], [class*="line-clamp-2"], [class*="content-right"]');
          for (var i = 0; i < cands.length; i++) {
            var t = cands[i].textContent.trim();
            if (t && t !== title) { snippet = t; break; }
          }
          results.push({ title: title, url: href, snippet: snippet });
        });
        return results;
      })()
    `
  },
  duckduckgo: {
    name: 'DuckDuckGo',
    urlTemplate: 'https://html.duckduckgo.com/html/?q=%s',
    homepage: 'https://duckduckgo.com',
    extractScript: `
      (function() {
        var results = [];
        var items = document.querySelectorAll('.result__body');
        items.forEach(function(item) {
          var linkEl = item.querySelector('.result__a');
          var snippetEl = item.querySelector('.result__snippet');
          if (linkEl) {
            var href = linkEl.getAttribute('href') || '';
            if (href.startsWith('//')) href = 'https:' + href;
            else if (href.startsWith('/')) href = 'https://duckduckgo.com' + href;
            results.push({
              title: (linkEl.textContent || '').trim(),
              url: href,
              snippet: (snippetEl && snippetEl.textContent || '').trim()
            });
          }
        });
        return results;
      })()
    `
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export class InternetSearchService {
  private static instance: InternetSearchService | null = null
  private searchWindows: Record<string, BrowserWindow> = {}
  private cache = new Map<string, { at: number; results: SearchResult[] }>()

  public static getInstance(): InternetSearchService {
    if (!InternetSearchService.instance) {
      InternetSearchService.instance = new InternetSearchService()
    }
    return InternetSearchService.instance
  }

  public getAvailableEngines(): SearchEngineInfo[] {
    return Object.entries(SEARCH_ENGINES).map(([id, config]) => ({
      id: id as SearchEngine,
      name: config.name,
      urlTemplate: config.urlTemplate,
      homepage: config.homepage
    }))
  }

  public async openSearchWindow(engine: SearchEngine): Promise<void> {
    const config = SEARCH_ENGINES[engine]
    if (!config) {
      throw new Error(`Unsupported search engine: ${engine}`)
    }

    let window = this.searchWindows[engine]
    if (window && !window.isDestroyed()) {
      window.show()
      window.focus()
      return
    }

    window = this.createWindow(true)

    window.on('closed', () => {
      delete this.searchWindows[engine]
    })

    this.searchWindows[engine] = window
    await window.loadURL(config.homepage)
    logger.info(`Opened visible search window for ${config.name}`)
  }

  public closeSearchWindow(engine: SearchEngine): void {
    const window = this.searchWindows[engine]
    if (window && !window.isDestroyed()) {
      window.close()
    }
    delete this.searchWindows[engine]
  }

  /** 清空结果缓存（测试或用户手动刷新时使用） */
  public clearCache(): void {
    this.cache.clear()
  }

  public async search(
    query: string,
    engine: SearchEngine,
    count: number = 5,
    options: SearchOptions = {}
  ): Promise<SearchResult[]> {
    const config = SEARCH_ENGINES[engine]
    if (!config) {
      throw new Error(`Unsupported search engine: ${engine}`)
    }

    const cacheKey = `${engine}\u0000${count}\u0000${query}`
    const cached = this.readCache(cacheKey)
    if (cached) {
      logger.info(`Cache hit for ${config.name}: "${query}"`)
      return cached
    }

    const url = config.urlTemplate.replace('%s', encodeURIComponent(query))
    const loadTimeoutMs = options.loadTimeoutMs ?? DEFAULT_LOAD_TIMEOUT_MS
    const renderWaitMs = options.renderWaitMs ?? DEFAULT_RENDER_WAIT_MS
    logger.info(`Searching with ${config.name}: ${url}`)

    let searchWindow: BrowserWindow | null = null

    try {
      searchWindow = this.createWindow(false)

      // 事件监听必须在 loadURL 之前注册：did-finish-load 会先于 loadURL 的 resolve 触发，
      // 晚注册会永远等不到事件，只能白等超时（旧实现的性能问题根源）
      await this.waitForLoad(searchWindow, url, loadTimeoutMs)
      const validResults = await this.extractResults(searchWindow, config.extractScript, count, renderWaitMs)

      if (validResults.length === 0 && engine === 'baidu') {
        // 空结果 + 安全验证标题 = 被反爬拦截，按失败处理以便上层降级到其他引擎
        const title = await searchWindow.webContents
          .executeJavaScript('document.title')
          .catch(() => '')
        if (typeof title === 'string' && title.includes('安全验证')) {
          throw new Error('触发安全验证，请求被百度拦截')
        }
      }

      logger.info(`${config.name} search returned ${validResults.length} results for "${query}"`)
      if (validResults.length > 0) {
        this.writeCache(cacheKey, validResults)
      }
      return validResults
    } catch (error: any) {
      logger.error(`Search with ${config.name} failed: ${error?.message || error}`)
      throw new Error(`${config.name}搜索失败: ${error?.message || error}`)
    } finally {
      if (searchWindow && !searchWindow.isDestroyed()) {
        searchWindow.destroy()
      }
    }
  }

  public getEngineName(engine: SearchEngine): string {
    return SEARCH_ENGINES[engine]?.name || engine
  }

  private createWindow(show: boolean): BrowserWindow {
    const window = new BrowserWindow({
      width: 1280,
      height: 768,
      show,
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
        partition: SESSION_PARTITION
      }
    })
    try {
      window.webContents.session?.setUserAgent?.(USER_AGENT, ACCEPT_LANGUAGE)
    } catch {}
    window.webContents.userAgent = USER_AGENT
    return window
  }

  /** 等待页面主框架加载完成，超时或失败均中止 */
  private waitForLoad(window: BrowserWindow, url: string, timeoutMs: number): Promise<void> {
    const wc: any = window.webContents
    return new Promise<void>((resolve, reject) => {
      let settled = false

      const cleanup = () => {
        clearTimeout(timer)
        wc.removeListener?.('did-finish-load', onFinish)
        wc.removeListener?.('did-fail-load', onFail)
      }

      const finish = (err?: Error) => {
        if (settled) return
        settled = true
        cleanup()
        if (err) reject(err)
        else resolve()
      }

      const onFinish = () => finish()
      const onFail = (
        _event: unknown,
        errorCode: number,
        errorDescription: string,
        _validatedURL: string,
        isMainFrame?: boolean
      ) => {
        if (isMainFrame === false) return
        finish(new Error(errorDescription || `加载失败(${errorCode})`))
      }

      const timer = setTimeout(() => finish(new Error(`加载超时(${timeoutMs}ms)`)), timeoutMs)

      wc.once('did-finish-load', onFinish)
      wc.once('did-fail-load', onFail)

      window.loadURL(url).catch((err: any) => finish(err instanceof Error ? err : new Error(String(err))))
    })
  }

  /** 提取结果：加载完成后按小间隔轮询，命中即返回，避免固定空等 */
  private async extractResults(
    window: BrowserWindow,
    script: string,
    count: number,
    renderWaitMs: number
  ): Promise<SearchResult[]> {
    const expression = `(${script}).slice(0, ${count})`
    const deadline = Date.now() + renderWaitMs
    let raw: any = []

    for (;;) {
      raw = await window.webContents.executeJavaScript(expression)
      if (Array.isArray(raw) && raw.length > 0) break
      if (Date.now() >= deadline) break
      await delay(RENDER_POLL_INTERVAL_MS)
    }

    return (Array.isArray(raw) ? raw : [])
      .filter((r: any) => r && typeof r.url === 'string' && (r.url.startsWith('http://') || r.url.startsWith('https://')))
      .slice(0, count)
  }

  private readCache(key: string): SearchResult[] | null {
    const entry = this.cache.get(key)
    if (!entry) return null
    if (Date.now() - entry.at > CACHE_TTL_MS) {
      this.cache.delete(key)
      return null
    }
    return entry.results.map((r) => ({ ...r }))
  }

  private writeCache(key: string, results: SearchResult[]): void {
    if (this.cache.size >= CACHE_MAX_ENTRIES) {
      const oldest = this.cache.keys().next().value
      if (oldest !== undefined) this.cache.delete(oldest)
    }
    this.cache.set(key, { at: Date.now(), results: results.map((r) => ({ ...r })) })
  }
}

export const internetSearchService = InternetSearchService.getInstance()
