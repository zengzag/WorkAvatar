import type Database from 'better-sqlite3'
import KMSDatabaseService from './kms-database.service'
import { generateId } from '../common-utils'
import { createLogger } from '../logger'

const logger = createLogger('KMS-StopWords')

/** IDF 阈值：低于此值的词视为通用修饰词，自动加入停用词表 */
const IDF_THRESHOLD = 1.0
/** 最小文档数：文档总量不足时不做 IDF 过滤（结果不稳定） */
const MIN_DOCS_FOR_IDF = 50

class KMSStopWordsService {
  private db: Database.Database
  private static instance: KMSStopWordsService
  /** 内存缓存：停用词集合，避免每次搜索都查库 */
  private stopWordsCache: Set<string> | null = null

  private constructor() {
    this.db = KMSDatabaseService.getInstance().getDb()
    this.refreshCache()
  }

  static getInstance(): KMSStopWordsService {
    if (!KMSStopWordsService.instance) {
      KMSStopWordsService.instance = new KMSStopWordsService()
    }
    return KMSStopWordsService.instance
  }

  /** 刷新内存缓存 */
  private refreshCache(): void {
    try {
      const rows = this.db.prepare('SELECT word FROM kms_stop_words').all() as any[]
      this.stopWordsCache = new Set(rows.map(r => r.word))
    } catch {
      this.stopWordsCache = new Set()
    }
  }

  /** 判断词是否为停用词 */
  isStopWord(word: string): boolean {
    if (!this.stopWordsCache) this.refreshCache()
    return this.stopWordsCache!.has(word)
  }

  /** 获取所有停用词 */
  listStopWords(params?: { source?: 'manual' | 'auto_idf'; limit?: number; offset?: number }): { words: any[]; total: number } {
    const limit = Math.min(Math.max(params?.limit || 100, 1), 500)
    const offset = Math.max(params?.offset || 0, 0)

    let where = 'WHERE 1=1'
    const sqlParams: any[] = []
    if (params?.source) {
      where += ' AND source = ?'
      sqlParams.push(params.source)
    }

    const countRow = this.db.prepare(`SELECT COUNT(*) as cnt FROM kms_stop_words ${where}`).get(...sqlParams) as any
    const total = countRow?.cnt || 0

    const rows = this.db.prepare(
      `SELECT * FROM kms_stop_words ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`
    ).all(...sqlParams, limit, offset) as any[]

    return { words: rows, total }
  }

  /** 添加停用词（手动） */
  addStopWord(word: string, source: 'manual' | 'auto_idf' = 'manual'): { success: boolean; error?: string } {
    const trimmed = word.trim()
    if (!trimmed) return { success: false, error: 'EMPTY_WORD' }

    try {
      this.db.prepare('INSERT OR IGNORE INTO kms_stop_words (id, word, source) VALUES (?, ?, ?)').run(generateId(), trimmed, source)
      this.stopWordsCache?.add(trimmed)
      return { success: true }
    } catch (err: any) {
      logger.warn('addStopWord failed:', err?.message || err)
      return { success: false, error: err?.message || String(err) }
    }
  }

  /** 批量添加停用词 */
  addStopWords(words: string[], source: 'manual' | 'auto_idf' = 'manual'): { added: number } {
    const tx = this.db.transaction((ws: string[]) => {
      let added = 0
      for (const w of ws) {
        const trimmed = w.trim()
        if (!trimmed) continue
        const result = this.db.prepare('INSERT OR IGNORE INTO kms_stop_words (id, word, source) VALUES (?, ?, ?)').run(generateId(), trimmed, source)
        if (result.changes > 0) {
          this.stopWordsCache?.add(trimmed)
          added++
        }
      }
      return added
    })
    const added = tx(words)
    return { added }
  }

  /** 删除停用词 */
  deleteStopWord(id: string): void {
    this.db.prepare('DELETE FROM kms_stop_words WHERE id = ?').run(id)
    this.refreshCache()
  }

  /** 删除停用词（按词） */
  deleteStopWordByWord(word: string): void {
    this.db.prepare('DELETE FROM kms_stop_words WHERE word = ?').run(word)
    this.stopWordsCache?.delete(word)
  }

  /**
   * 基于 IDF 判断词是否应该被过滤：
   * 如果词在文档库中出现频率过高（IDF 过低），则自动加入停用词表并返回 true。
   * 文档量不足时跳过 IDF 过滤（结果不稳定）。
   */
  evaluateIdfAndCache(word: string): { shouldFilter: boolean; reason?: string } {
    // 已在停用词表中，直接过滤
    if (this.isStopWord(word)) {
      return { shouldFilter: true, reason: 'stop_word' }
    }

    const totalDocs = this.getTotalDocCount()
    if (totalDocs < MIN_DOCS_FOR_IDF) {
      // 文档量不足，不做 IDF 过滤
      return { shouldFilter: false }
    }

    const docFreq = this.getFtsDocFreq(word)
    if (docFreq === 0) return { shouldFilter: false }

    const idf = Math.log(totalDocs / (docFreq + 1))

    if (idf < IDF_THRESHOLD) {
      // IDF 过低 → 该词太常见，自动加入停用词表
      this.addStopWord(word, 'auto_idf')
      logger.info(`Word "${word}" auto-added to stop words (IDF=${idf.toFixed(2)}, docFreq=${docFreq}, totalDocs=${totalDocs})`)
      return { shouldFilter: true, reason: 'low_idf' }
    }

    return { shouldFilter: false }
  }

  /** 获取文档总数（kms_files 中已索引的） */
  private getTotalDocCount(): number {
    try {
      const row = this.db.prepare("SELECT COUNT(*) as cnt FROM kms_files WHERE index_status = 'completed'").get() as any
      return row?.cnt || 0
    } catch {
      return 0
    }
  }

  /**
   * 获取 FTS5 中包含指定词的文档频率
   * 使用 FTS5 的 count 语法
   */
  private getFtsDocFreq(word: string): number {
    try {
      // FTS5 MATCH 查询，对中文需要确保分词正确
      // 使用 phrase 查询避免被 FTS5 拆分为多个 token
      const escaped = word.replace(/["']/g, '')
      const row = this.db.prepare(
        `SELECT COUNT(*) as cnt FROM kms_fts WHERE kms_fts MATCH ?`
      ).get(`"${escaped}"`) as any
      return row?.cnt || 0
    } catch {
      return 0
    }
  }

  /** 清理所有 auto_idf 来源的停用词（供用户重置） */
  clearAutoStopWords(): number {
    const result = this.db.prepare("DELETE FROM kms_stop_words WHERE source = 'auto_idf'").run()
    this.refreshCache()
    return result.changes
  }
}

export default KMSStopWordsService
