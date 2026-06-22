import Database from 'better-sqlite3'
import fs from 'fs'
import path from 'path'
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

      -- 访问追踪表（用于冷热数据判定）
      CREATE TABLE IF NOT EXISTS kms_access_log (
        id TEXT PRIMARY KEY,
        file_id TEXT NOT NULL REFERENCES kms_files(id) ON DELETE CASCADE,
        access_type TEXT NOT NULL,
        accessed_at INTEGER NOT NULL DEFAULT (unixepoch())
      );

      CREATE INDEX IF NOT EXISTS idx_kms_access_log_file ON kms_access_log(file_id);
      CREATE INDEX IF NOT EXISTS idx_kms_access_log_time ON kms_access_log(accessed_at);
    `)

    this.recoverStuckFiles()
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
