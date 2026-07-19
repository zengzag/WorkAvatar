import type Database from 'better-sqlite3'
import KMSDatabaseService from './kms-database.service'
import KMSStopWordsService from './kms-stop-words.service'
import { generateId } from '../common-utils'

/** 基础停用词 + 搜索修饰词（内置，不可删除），用户可在 UI 中额外维护 */
const BUILT_IN_STOP_WORDS = new Set([
  '的', '了', '是', '在', '我', '有', '和', '就', '不', '人', '都', '一', '上', '也', '很',
  '到', '说', '要', '去', '你', '会', '着', '没有', '看', '好', '自己', '这', '那',
  'the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
  'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could',
  'should', 'may', 'might', 'must', 'can', 'of', 'in', 'on', 'at', 'to',
  'for', 'with', 'by', 'from', 'as', 'into', 'about', 'what', 'how',
  'why', 'when', 'where', 'who', 'which', 'that', 'this', 'these', 'those',
  // 搜索场景常见修饰词
  '如何', '怎么', '怎样', '方法', '方式', '使用', '利用', '关于', '相关',
  '什么', '为什么', '哪些', '最好', '比较', '区别', '不同', '区分',
  '介绍', '解释', '说明', '了解', '概述', '总结', '分析', '评估',
  '实现', '部署', '配置', '安装', '搭建', '原理', '机制',
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
    // 内置停用词
    if (BUILT_IN_STOP_WORDS.has(normalized.toLowerCase())) return false
    // 用户维护的停用词表（含 IDF 自动加入的）
    if (KMSStopWordsService.getInstance().isStopWord(normalized)) return false
    // 纯标点/符号
    if (/^[\s\p{P}\p{S}]+$/u.test(normalized)) return false
    return true
  }

  /**
   * 记录搜索关键词频次（同关键词累计计数，不存储搜索结果内容）
   *
   * 支持多关键词搜索：当 query 含空格时，拆分为多个子词分别记录频次。
   * 每个子词经过两层过滤：
   *   1. 内置停用词 + 用户停用词表（快速过滤）
   *   2. IDF 过滤（首次遇到时计算，不通过的自动加入停用词表，后续直接跳过）
   *
   * @param query 用户原始搜索词
   * @param hitFileIds 命中的文件ID列表（仅存ID，用于卡片生成时检索相关文件）
   */
  incrementKeywordStat(query: string, hitFileIds: string[] = []): void {
    const normalized = this.normalizeKeyword(query)
    if (!normalized) return

    // 按空格拆分为子词，每个子词独立处理
    const segments = normalized.split(/\s+/).filter(s => s.length > 0)

    // 如果没有空格，按整体处理
    if (segments.length <= 1) {
      this.recordSingleKeyword(normalized, query.trim(), hitFileIds)
      return
    }

    // 多关键词：对每个子词分别过滤和记录
    for (const seg of segments) {
      // 第一层：内置停用词 + 用户停用词表 快速过滤
      if (!this.isValidKeyword(seg)) continue

      // 第二层：IDF 过滤（首次计算，不通过的自动缓存到停用词表）
      const idfResult = KMSStopWordsService.getInstance().evaluateIdfAndCache(seg)
      if (idfResult.shouldFilter) continue

      // 通过两层过滤，记录该子词
      this.recordSingleKeyword(seg, seg, hitFileIds)
    }
  }

  /** 记录单个关键词的搜索频次 */
  private recordSingleKeyword(normalized: string, displayKeyword: string, hitFileIds: string[]): void {
    if (!this.isValidKeyword(normalized)) return

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
      `).run(generateId(), normalized, displayKeyword, now, now, JSON.stringify(hitFileIds.slice(0, 20)))
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
  findHotKeywordsWithoutCards(threshold: number, recentDays: number = 30, recentBoostThreshold: number = 6): Array<{
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
        AND NOT EXISTS (SELECT 1 FROM kms_stop_words WHERE word = kms_keyword_stats.keyword)
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

  /**
   * 清理低频关键词：删除 90 天未搜索且 search_count < 3 的记录。
   * 在 autoCleanup 中调用，防止 kms_keyword_stats 表无限增长。
   */
  cleanupStaleKeywordStats(): number {
    const cutoff = Math.floor(Date.now() / 1000) - 90 * 86400
    const result = this.db.prepare(
      'DELETE FROM kms_keyword_stats WHERE last_searched_at < ? AND search_count < 3'
    ).run(cutoff)
    return result.changes
  }
}

export default KMSKeywordStatsService
