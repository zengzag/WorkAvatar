import Database from 'better-sqlite3'
import fs from 'fs'
import path from 'path'
import * as sqliteVec from 'sqlite-vec'
import PathService from '../path.service'
import { createLogger } from '../logger'

const logger = createLogger('KMS-DB')

/**
 * KMS 独立数据库服务
 * 管理搜索引擎的所有数据：索引目录、文件注册、FTS5全文索引、向量嵌入、冷热数据、访问追踪
 */
class KMSDatabaseService {
  private db: Database.Database
  private static instance: KMSDatabaseService

  private constructor() {
    const pathService = PathService.getInstance()
    const kmsDbPath = pathService.getKMSDbPath()
    const dir = path.dirname(kmsDbPath)
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true })
    }

    this.db = new Database(kmsDbPath, {
      readonly: false,
      timeout: 5000
    })

    this.db.pragma('journal_mode = WAL')
    this.db.pragma('foreign_keys = ON')

    // 加载 sqlite-vec 向量搜索扩展
    try {
      sqliteVec.load(this.db)
      logger.info('sqlite-vec 扩展加载成功')
    } catch (err: any) {
      logger.error('sqlite-vec 扩展加载失败:', err?.message || err)
    }

    this.initializeSchema()
  }

  static getInstance(): KMSDatabaseService {
    if (!KMSDatabaseService.instance) {
      KMSDatabaseService.instance = new KMSDatabaseService()
    }
    return KMSDatabaseService.instance
  }

  public addColumnIfNotExists(table: string, column: string, definition: string): void {
    const result = this.db.prepare(`PRAGMA table_info(${table})`).all() as any[]
    const columnExists = result.some((c) => c.name === column)
    if (!columnExists) {
      this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`)
    }
  }

  private initializeSchema(): void {
    this.db.exec(`
      -- 索引目录配置表
      CREATE TABLE IF NOT EXISTS kms_index_dirs (
        id TEXT PRIMARY KEY,
        dir_path TEXT NOT NULL UNIQUE,
        display_name TEXT NOT NULL DEFAULT '',
        enabled INTEGER NOT NULL DEFAULT 1,
        recursive INTEGER NOT NULL DEFAULT 1,
        file_extensions TEXT DEFAULT '',
        created_at INTEGER NOT NULL DEFAULT (unixepoch()),
        updated_at INTEGER NOT NULL DEFAULT (unixepoch())
      );

      -- 文件注册表
      CREATE TABLE IF NOT EXISTS kms_files (
        id TEXT PRIMARY KEY,
        dir_id TEXT NOT NULL REFERENCES kms_index_dirs(id) ON DELETE CASCADE,
        file_path TEXT NOT NULL UNIQUE,
        file_name TEXT NOT NULL,
        file_ext TEXT NOT NULL DEFAULT '',
        file_size INTEGER NOT NULL DEFAULT 0,
        file_hash TEXT NOT NULL,
        modified_time INTEGER NOT NULL DEFAULT 0,
        index_status TEXT NOT NULL DEFAULT 'pending',
        data_tier TEXT NOT NULL DEFAULT 'cold',
        parse_error TEXT,
        created_at INTEGER NOT NULL DEFAULT (unixepoch()),
        updated_at INTEGER NOT NULL DEFAULT (unixepoch())
      );

      CREATE INDEX IF NOT EXISTS idx_kms_files_dir ON kms_files(dir_id);
      CREATE INDEX IF NOT EXISTS idx_kms_files_hash ON kms_files(file_hash);
      CREATE INDEX IF NOT EXISTS idx_kms_files_status ON kms_files(index_status);
      CREATE INDEX IF NOT EXISTS idx_kms_files_tier ON kms_files(data_tier);
      CREATE INDEX IF NOT EXISTS idx_kms_files_modified ON kms_files(modified_time);
      CREATE INDEX IF NOT EXISTS idx_kms_files_ext ON kms_files(file_ext);
      CREATE INDEX IF NOT EXISTS idx_kms_files_updated ON kms_files(updated_at DESC);

      -- 文件内容段落表（热数据：深度摘要和向量化后的段落）
      CREATE TABLE IF NOT EXISTS kms_paragraphs (
        id TEXT PRIMARY KEY,
        file_id TEXT NOT NULL REFERENCES kms_files(id) ON DELETE CASCADE,
        title TEXT NOT NULL DEFAULT '',
        title_path TEXT NOT NULL DEFAULT '',
        level INTEGER NOT NULL DEFAULT 1,
        paragraph_index INTEGER NOT NULL DEFAULT 0,
        start_offset INTEGER NOT NULL DEFAULT 0,
        end_offset INTEGER NOT NULL DEFAULT 0,
        content TEXT NOT NULL DEFAULT '',
        summary TEXT,
        keywords_json TEXT DEFAULT '[]',
        vector_id TEXT,
        created_at INTEGER NOT NULL DEFAULT (unixepoch()),
        updated_at INTEGER NOT NULL DEFAULT (unixepoch())
      );

      CREATE INDEX IF NOT EXISTS idx_kms_paragraphs_file ON kms_paragraphs(file_id);

      -- 文件摘要表（热数据）
      CREATE TABLE IF NOT EXISTS kms_file_summaries (
        id TEXT PRIMARY KEY,
        file_id TEXT NOT NULL UNIQUE REFERENCES kms_files(id) ON DELETE CASCADE,
        summary TEXT NOT NULL DEFAULT '',
        toc_json TEXT DEFAULT '[]',
        keywords_json TEXT DEFAULT '[]',
        main_topics_json TEXT DEFAULT '[]',
        vector_id TEXT,
        created_at INTEGER NOT NULL DEFAULT (unixepoch()),
        updated_at INTEGER NOT NULL DEFAULT (unixepoch())
      );

      CREATE INDEX IF NOT EXISTS idx_kms_file_summaries_file ON kms_file_summaries(file_id);

      -- 搜索索引表
      CREATE TABLE IF NOT EXISTS kms_search_index (
        id TEXT PRIMARY KEY,
        file_id TEXT NOT NULL REFERENCES kms_files(id) ON DELETE CASCADE,
        source_type TEXT NOT NULL,
        source_id TEXT NOT NULL,
        paragraph_index INTEGER DEFAULT 0,
        title TEXT DEFAULT '',
        content TEXT NOT NULL DEFAULT '',
        start_offset INTEGER DEFAULT 0,
        end_offset INTEGER DEFAULT 0,
        start_line INTEGER DEFAULT 0,
        end_line INTEGER DEFAULT 0,
        keywords_json TEXT DEFAULT '[]',
        metadata_json TEXT DEFAULT '{}',
        created_at INTEGER NOT NULL DEFAULT (unixepoch()),
        updated_at INTEGER NOT NULL DEFAULT (unixepoch())
      );

      CREATE INDEX IF NOT EXISTS idx_kms_search_index_file ON kms_search_index(file_id);
      CREATE INDEX IF NOT EXISTS idx_kms_search_index_source ON kms_search_index(source_type, source_id);
      CREATE INDEX IF NOT EXISTS idx_kms_search_index_type ON kms_search_index(source_type);
      -- 复合索引：支持 deleteIndexByFileAndType 的 WHERE file_id = ? AND source_type = ?
      CREATE INDEX IF NOT EXISTS idx_kms_search_index_file_type ON kms_search_index(file_id, source_type);

      -- FTS5 全文检索虚拟表
      CREATE VIRTUAL TABLE IF NOT EXISTS kms_fts USING fts5(
        title,
        content,
        keywords,
        file_id UNINDEXED,
        source_type UNINDEXED,
        source_id UNINDEXED,
        index_id UNINDEXED,
        tokenize='unicode61'
      );

      -- 向量嵌入表
      CREATE TABLE IF NOT EXISTS kms_embeddings (
        id TEXT PRIMARY KEY,
        source_type TEXT NOT NULL,
        source_id TEXT NOT NULL,
        file_id TEXT NOT NULL REFERENCES kms_files(id) ON DELETE CASCADE,
        embedding BLOB NOT NULL,
        model TEXT NOT NULL DEFAULT '',
        dimension INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL DEFAULT (unixepoch()),
        updated_at INTEGER NOT NULL DEFAULT (unixepoch())
      );

      CREATE INDEX IF NOT EXISTS idx_kms_embeddings_source ON kms_embeddings(source_type, source_id);
      CREATE INDEX IF NOT EXISTS idx_kms_embeddings_file ON kms_embeddings(file_id);
      -- 覆盖索引：支持 anti-join 查询的 index-only scan（避免回表取 id）
      CREATE INDEX IF NOT EXISTS idx_kms_embeddings_source_covering ON kms_embeddings(source_type, source_id, id);

      -- 访问追踪表（用于冷热数据判定）
      CREATE TABLE IF NOT EXISTS kms_access_log (
        id TEXT PRIMARY KEY,
        file_id TEXT NOT NULL REFERENCES kms_files(id) ON DELETE CASCADE,
        access_type TEXT NOT NULL,
        accessed_at INTEGER NOT NULL DEFAULT (unixepoch())
      );

      CREATE INDEX IF NOT EXISTS idx_kms_access_log_file ON kms_access_log(file_id);
      CREATE INDEX IF NOT EXISTS idx_kms_access_log_time ON kms_access_log(accessed_at);
      -- 复合索引：支持 getFileAccessStats 的 WHERE file_id = ? AND access_type = ? AND accessed_at >= ?
      CREATE INDEX IF NOT EXISTS idx_kms_access_log_file_type_time ON kms_access_log(file_id, access_type, accessed_at);

      -- 目录摘要表（冷热数据渐进沉淀：基于文件名+轻量摘要生成目录级摘要）
      CREATE TABLE IF NOT EXISTS kms_dir_summaries (
        id TEXT PRIMARY KEY,
        dir_id TEXT NOT NULL UNIQUE REFERENCES kms_index_dirs(id) ON DELETE CASCADE,
        dir_path TEXT NOT NULL DEFAULT '',
        summary TEXT NOT NULL DEFAULT '',
        file_count INTEGER NOT NULL DEFAULT 0,
        keywords_json TEXT DEFAULT '[]',
        updated_at INTEGER NOT NULL DEFAULT (unixepoch())
      );

      CREATE INDEX IF NOT EXISTS idx_kms_dir_summaries_dir ON kms_dir_summaries(dir_id);

      -- 搜索历史表（记录关键词搜索和AI搜索的历史）
      CREATE TABLE IF NOT EXISTS kms_search_history (
        id TEXT PRIMARY KEY,
        query TEXT NOT NULL,
        search_mode TEXT NOT NULL,
        result_count INTEGER NOT NULL DEFAULT 0,
        result_data TEXT,
        filters_json TEXT DEFAULT '{}',
        created_at INTEGER NOT NULL DEFAULT (unixepoch())
      );

      CREATE INDEX IF NOT EXISTS idx_kms_search_history_time ON kms_search_history(created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_kms_search_history_mode ON kms_search_history(search_mode);

      -- ==================== 合集（Collection）相关表 ====================
      -- 合集：手动挑选文件组成的稳定资料集
      CREATE TABLE IF NOT EXISTS kms_collections (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        created_at INTEGER NOT NULL DEFAULT (unixepoch()),
        updated_at INTEGER NOT NULL DEFAULT (unixepoch())
      );

      -- 文件-合集多对多关系表（一个文件可属于多个合集）
      CREATE TABLE IF NOT EXISTS kms_file_collections (
        file_id TEXT NOT NULL REFERENCES kms_files(id) ON DELETE CASCADE,
        collection_id TEXT NOT NULL REFERENCES kms_collections(id) ON DELETE CASCADE,
        added_at INTEGER NOT NULL DEFAULT (unixepoch()),
        PRIMARY KEY (file_id, collection_id)
      );

      CREATE INDEX IF NOT EXISTS idx_kms_file_collections_file ON kms_file_collections(file_id);
      CREATE INDEX IF NOT EXISTS idx_kms_file_collections_collection ON kms_file_collections(collection_id);

      -- 合集级摘要表（对应原 KB 的 kb_global_summaries）
      CREATE TABLE IF NOT EXISTS kms_collection_summaries (
        id TEXT PRIMARY KEY,
        collection_id TEXT NOT NULL UNIQUE REFERENCES kms_collections(id) ON DELETE CASCADE,
        summary TEXT NOT NULL DEFAULT '',
        key_topics_json TEXT DEFAULT '[]',
        vector_id TEXT,
        created_at INTEGER NOT NULL DEFAULT (unixepoch()),
        updated_at INTEGER NOT NULL DEFAULT (unixepoch())
      );

      CREATE INDEX IF NOT EXISTS idx_kms_collection_summaries_collection ON kms_collection_summaries(collection_id);
    `)

    // 增量迁移：为已有表添加新字段
    this.migrateSchema()

    this.recoverStuckFiles()
  }

  /**
   * 增量迁移：安全添加新字段（兼容已有数据库）
   */
  private migrateSchema(): void {
    // kms_file_summaries 增加 light_summary（冷数据轻量摘要，不调用LLM）
    const cols = this.db.prepare("PRAGMA table_info(kms_file_summaries)").all() as any[]
    const colNames = cols.map(c => c.name)
    if (!colNames.includes('light_summary')) {
      this.db.exec("ALTER TABLE kms_file_summaries ADD COLUMN light_summary TEXT DEFAULT ''")
    }
    if (!colNames.includes('preview_text')) {
      this.db.exec("ALTER TABLE kms_file_summaries ADD COLUMN preview_text TEXT DEFAULT ''")
    }

    // kms_collection_summaries 增加 embedding/dimension/model 字段（合集摘要向量化）
    const collCols = this.db.prepare("PRAGMA table_info(kms_collection_summaries)").all() as any[]
    const collColNames = collCols.map(c => c.name)
    if (!collColNames.includes('embedding')) {
      this.db.exec("ALTER TABLE kms_collection_summaries ADD COLUMN embedding BLOB")
    }
    if (!collColNames.includes('dimension')) {
      this.db.exec("ALTER TABLE kms_collection_summaries ADD COLUMN dimension INTEGER DEFAULT 0")
    }
    if (!collColNames.includes('embedding_model')) {
      this.db.exec("ALTER TABLE kms_collection_summaries ADD COLUMN embedding_model TEXT DEFAULT ''")
    }
  }

  private recoverStuckFiles(): void {
    const result = this.db.prepare(`
      UPDATE kms_files
      SET index_status = 'pending'
      WHERE index_status = 'indexing'
    `).run()
    if (result.changes > 0) {
      logger.info(`Recovered ${result.changes} file(s) from indexing to pending status`)
    }
  }

  public getDb(): Database.Database {
    return this.db
  }

  public close(): void {
    this.db.close()
  }
}

export default KMSDatabaseService
