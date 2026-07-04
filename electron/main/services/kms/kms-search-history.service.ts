import type Database from 'better-sqlite3'
import KMSDatabaseService from './kms-database.service'
import { generateId } from '../common-utils'

/**
 * KMS 搜索历史服务
 * 负责搜索历史的记录、查询、清除与单条删除
 */
class KMSSearchHistoryService {
  private db: Database.Database
  private static instance: KMSSearchHistoryService

  private constructor() {
    this.db = KMSDatabaseService.getInstance().getDb()
  }

  static getInstance(): KMSSearchHistoryService {
    if (!KMSSearchHistoryService.instance) {
      KMSSearchHistoryService.instance = new KMSSearchHistoryService()
    }
    return KMSSearchHistoryService.instance
  }

  /**
   * 记录搜索历史（相同 query 去重：更新已有记录而非重复插入）
   */
  recordSearchHistory(params: {
    query: string
    searchMode: string
    resultCount: number
    filters?: any
  }): void {
    // 查找是否已有相同 query 的历史记录
    const existing = this.db.prepare(
      'SELECT id FROM kms_search_history WHERE query = ? ORDER BY created_at DESC LIMIT 1'
    ).get(params.query) as any

    if (existing) {
      // 更新已有记录，刷新搜索模式、结果数和时间为当前
      this.db.prepare(`
        UPDATE kms_search_history SET search_mode = ?, result_count = ?, filters_json = ?, created_at = unixepoch()
        WHERE id = ?
      `).run(
        params.searchMode,
        params.resultCount,
        params.filters ? JSON.stringify(params.filters) : '{}',
        existing.id
      )
    } else {
      const id = generateId()
      this.db.prepare(`
        INSERT INTO kms_search_history (id, query, search_mode, result_count, filters_json)
        VALUES (?, ?, ?, ?, ?)
      `).run(
        id,
        params.query,
        params.searchMode,
        params.resultCount,
        params.filters ? JSON.stringify(params.filters) : '{}'
      )
    }
  }

  /**
   * 获取搜索历史列表
   */
  getSearchHistory(params?: { limit?: number; searchMode?: string }): any[] {
    const limit = Math.min(Math.max(params?.limit || 50, 1), 500)
    let sql = 'SELECT id, query, search_mode, result_count, created_at FROM kms_search_history'
    const sqlParams: any[] = []
    if (params?.searchMode) {
      sql += ' WHERE search_mode = ?'
      sqlParams.push(params.searchMode)
    }
    sql += ' ORDER BY created_at DESC LIMIT ?'
    sqlParams.push(limit)
    return this.db.prepare(sql).all(...sqlParams)
  }

  /**
   * 清空搜索历史
   */
  clearSearchHistory(searchMode?: string): void {
    if (searchMode) {
      this.db.prepare('DELETE FROM kms_search_history WHERE search_mode = ?').run(searchMode)
    } else {
      this.db.prepare('DELETE FROM kms_search_history').run()
    }
  }

  /**
   * 删除单条搜索历史
   */
  deleteSearchHistory(id: string): void {
    this.db.prepare('DELETE FROM kms_search_history WHERE id = ?').run(id)
  }
}

export default KMSSearchHistoryService
