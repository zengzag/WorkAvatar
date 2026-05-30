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

interface SearchEngineConfig {
  name: string
  urlTemplate: string
  homepage: string
  extractScript: string
}

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
    urlTemplate: 'https://cn.bing.com/search?q=%s&ensearch=1',
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
        var items = document.querySelectorAll('#content_left .result h3');
        items.forEach(function(item) {
          var linkEl = item.querySelector('a');
          if (!linkEl) return;
          var snippetEl = item.closest('.result') ? item.closest('.result').querySelector('.c-abstract, .c-span-last') : null;
          results.push({
            title: linkEl.textContent.trim(),
            url: linkEl.href,
            snippet: (snippetEl && snippetEl.textContent || '').trim()
          });
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

export class InternetSearchService {
  private static instance: InternetSearchService | null = null
  private searchWindows: Record<string, BrowserWindow> = {}

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

    window = new BrowserWindow({
      width: 1280,
      height: 768,
      show: true,
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true
      }
    })

    window.webContents.userAgent =
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'

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

  public async search(
    query: string,
    engine: SearchEngine,
    count: number = 5
  ): Promise<SearchResult[]> {
    const config = SEARCH_ENGINES[engine]
    if (!config) {
      throw new Error(`Unsupported search engine: ${engine}`)
    }

    const url = config.urlTemplate.replace('%s', encodeURIComponent(query))
    logger.info(`Searching with ${config.name}: ${url}`)

    let searchWindow: BrowserWindow | null = null

    try {
      searchWindow = new BrowserWindow({
        width: 1280,
        height: 768,
        show: false,
        webPreferences: {
          nodeIntegration: false,
          contextIsolation: true,
          sandbox: true
        }
      })

      searchWindow.webContents.userAgent =
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'

      await searchWindow.loadURL(url)

      await new Promise<void>((resolve) => {
        const timeout = setTimeout(() => resolve(), 15000)
        searchWindow!.webContents.once('did-finish-load', () => {
          clearTimeout(timeout)
          setTimeout(resolve, 800)
        })
      })

      const results: SearchResult[] = await searchWindow.webContents.executeJavaScript(
        `(${config.extractScript}).slice(0, ${count})`
      )

      const validResults = results
        .filter(r => r.url && (r.url.startsWith('http://') || r.url.startsWith('https://')))
        .slice(0, count)

      logger.info(`${config.name} search returned ${validResults.length} results for "${query}"`)
      return validResults
    } catch (error: any) {
      logger.error(`Search with ${config.name} failed: ${error.message}`)
      throw new Error(`${config.name}搜索失败: ${error.message}`)
    } finally {
      if (searchWindow && !searchWindow.isDestroyed()) {
        searchWindow.destroy()
      }
    }
  }

  public getEngineName(engine: SearchEngine): string {
    return SEARCH_ENGINES[engine]?.name || engine
  }
}

export const internetSearchService = InternetSearchService.getInstance()
