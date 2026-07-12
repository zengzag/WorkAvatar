import type Database from 'better-sqlite3'
import KMSDatabaseService from './kms-database.service'
import { generateId } from '../common-utils'

/** 中文停用词 + 常见过短无意义词，避免生成无价值卡片 */
const STOP_WORDS = new Set([
  '的', '了', '是', '在', '我', '有', '和', '就', '不', '人', '都', '一', '上', '也', '很',
  '到', '说', '要', '去', '你', '会', '着', '没有', '看', '好', '自己', '这', '那',
  'the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
  'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could',
  'should', 'may', 'might', 'must', 'can', 'of', 'in', 'on', 'at', 'to',
  'for', 'with', 'by', 'from', 'as', 'into', 'about', 'what', 'how',
  'why', 'when', 'where', 'who', 'which', 'that', 'this', 'these', 'those',
])

class KMSKeywordStatsService {
  private db: Database.Database
  private static instance: KMSKeywordStatsService

  private constructor() {
    this.db = KMSDatabaseService.getInstance().getDb()
  }

  static getInstance(): KMSKeywordStatsService {
    if (!KMSKeywordStatsService.instance) {
      KMSKeywordStatsService.instance = new KMSKeywordStatsService()
    }
    return KMSKeywordStatsService.instance
  }

  /**
   * 关键词归一化：trim + 压缩空白 + 英文转小写（中文保留原样）
   * 用于唯一性比较，display_keyword 保留用户原始输入
   */
  normalizeKeyword(keyword: string): string {
    return keyword
      .trim()
      .replace(/[\u3000\u2002\u2003]/g, ' ')  // 全角/特殊空格转半角
      .replace(/\s+/g, ' ')                    // 压缩连续空白
      .replace(/[a-z]+/g, m => m.toLowerCase()) // 英文转小写（中文不动）
  }

  /** 判断关键词是否有效（非空、非停用词、长度>=2） */
  isValidKeyword(keyword: string): boolean {
    const normalized = this.normalizeKeyword(keyword)
    if (normalized.length < 2) return false
    if (STOP_WORDS.has(normalized.toLowerCase())) return false
    // 纯标点/符号
    if (/^[\s\p{P}\p{S}]+$/u.test(normalized)) return false
    return true
  }

  /**
   * 记录搜索关键词频次（同关键词累计计数，不存储搜索结果内容）
   * @param query 用户原始搜索词
   * @param hitFileIds 命中的文件ID列表（仅存ID，用于卡片生成时检索相关文件）
   */
  incrementKeywordStat(query: string, hitFileIds: string[] = []): void {
    const normalized = this.normalizeKeyword(query)
    if (!this.isValidKeyword(query)) return

    const now = Math.floor(Date.now() / 1000)
    const existing = this.db.prepare(
      'SELECT id, search_count FROM kms_keyword_stats WHERE keyword = ?'
    ).get(normalized) as any

    if (existing) {
      this.db.prepare(`
        UPDATE kms_keyword_stats
        SET search_count = search_count + 1,
            last_searched_at = ?,
            result_file_ids_json = ?,
            updated_at = unixepoch()
        WHERE id = ?
      `).run(now, JSON.stringify(hitFileIds.slice(0, 20)), existing.id)
    } else {
      this.db.prepare(`
        INSERT INTO kms_keyword_stats (id, keyword, display_keyword, search_count, first_searched_at, last_searched_at, result_file_ids_json)
        VALUES (?, ?, ?, 1, ?, ?, ?)
      `).run(generateId(), normalized, query.trim(), now, now, JSON.stringify(hitFileIds.slice(0, 20)))
    }
  }

  /** 获取关键词频次统计列表（按搜索次数降序） */
  getKeywordStats(params?: { limit?: number; minCount?: number; recentDays?: number }): any[] {
    const limit = Math.min(Math.max(params?.limit || 50, 1), 500)
    const minCount = params?.minCount ?? 1
    let sql = 'SELECT keyword, display_keyword, search_count, first_searched_at, last_searched_at FROM kms_keyword_stats WHERE search_count >= ?'
    const sqlParams: any[] = [minCount]

    if (params?.recentDays) {
      const threshold = Math.floor(Date.now() / 1000) - params.recentDays * 86400
      sql += ' AND last_searched_at >= ?'
      sqlParams.push(threshold)
    }

    sql += ' ORDER BY search_count DESC, last_searched_at DESC LIMIT ?'
    sqlParams.push(limit)
    return this.db.prepare(sql).all(...sqlParams)
  }

  /**
   * 找出达到阈值但还没有卡片的关键词
   * @param threshold 搜索次数阈值
   * @param recentDays 近 N 天内有搜索活动
   * @param recentBoostThreshold 近7天内搜索次数达到此值也可触发
   */
  findHotKeywordsWithoutCards(threshold: number, recentDays: number = 30, recentBoostThreshold: number = 3): Array<{
    keyword: string
    displayKeyword: string
    searchCount: number
    resultFileIds: string[]
  }> {
    const now = Math.floor(Date.now() / 1000)
    const recentCutoff = now - recentDays * 86400
    const boostCutoff = now - 7 * 86400

    const rows = this.db.prepare(`
      SELECT keyword, display_keyword, search_count, last_searched_at, result_file_ids_json
      FROM kms_keyword_stats
      WHERE last_searched_at >= ?
        AND search_count >= ?
        AND NOT EXISTS (SELECT 1 FROM kms_knowledge_cards WHERE keyword = kms_keyword_stats.keyword)
      ORDER BY search_count DESC
    `).all(recentCutoff, Math.min(threshold, recentBoostThreshold)) as any[]

    return rows
      .filter(r => {
        // 达到常规阈值，或7天内搜索次数达到 boost 阈值
        if (r.search_count >= threshold) return true
        if (r.last_searched_at >= boostCutoff && r.search_count >= recentBoostThreshold) return true
        return false
      })
      .map(r => ({
        keyword: r.keyword,
        displayKeyword: r.display_keyword,
        searchCount: r.search_count,
        resultFileIds: (() => { try { return JSON.parse(r.result_file_ids_json || '[]') } catch { return [] } })(),
      }))
  }

  /** 删除关键词统计记录（清理用） */
  deleteKeywordStat(keyword: string): void {
    this.db.prepare('DELETE FROM kms_keyword_stats WHERE keyword = ?').run(keyword)
  }
}

export default KMSKeywordStatsService
