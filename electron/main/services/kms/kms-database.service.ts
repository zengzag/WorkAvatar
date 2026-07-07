import Database from 'better-sqlite3'
import fs from 'fs'
import path from 'path'
import * as sqliteVec from 'sqlite-vec'
import PathService from '../path.service'
import { createLogger } from '../logger'

const logger = createLogger('KMS-DB')

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
      timeout: 10000
    })

    // ===== 性能 PRAGMA 配置（针对大库 2GB+ / 3000+ 文件场景优化） =====
    // WAL 模式：写入走 WAL 文件，读不阻塞写，写不阻塞读
    this.db.pragma('journal_mode = WAL')
    // 外键约束
    this.db.pragma('foreign_keys = ON')
    // synchronous=NORMAL：WAL 模式下事务提交不强制 fsync（只在 checkpoint 时刷盘），
    // 既保证事务安全又避免每次 commit 等磁盘同步（默认 FULL 会卡死大库写入）
    this.db.pragma('synchronous = NORMAL')
    // 临时表/索引/排序中间结果放内存，避免写 temp.db
    this.db.pragma('temp_store = MEMORY')
    // 页缓存 200MB（默认仅 2MB，对 2GB 库远远不够）
    this.db.pragma('cache_size = -200000')
    // mmap 256MB，用内存映射替代 read 系统调用，减少用户态/内核态切换
    this.db.pragma('mmap_size = 268435456')
    // WAL 自动 checkpoint 阈值提高到 8MB（默认 4MB），减少 checkpoint 频率
    this.db.pragma('wal_autocheckpoint = 2000')
    // busy_timeout 10s：多线程/进程争用时等待而不是立即抛 SQLITE_BUSY
    this.db.pragma('busy_timeout = 10000')
    // WAL 文件大小硬上限 512MB，避免无限膨胀（超过后自动 checkpoint）
    this.db.pragma('journal_size_limit = 536870912')

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
      -- file_hash 唯一索引由 enforceUniqueFileHash() 迁移建立
      CREATE INDEX IF NOT EXISTS idx_kms_files_status ON kms_files(index_status);
      CREATE INDEX IF NOT EXISTS idx_kms_files_tier ON kms_files(data_tier);
      CREATE INDEX IF NOT EXISTS idx_kms_files_modified ON kms_files(modified_time);
      CREATE INDEX IF NOT EXISTS idx_kms_files_ext ON kms_files(file_ext);
      CREATE INDEX IF NOT EXISTS idx_kms_files_updated ON kms_files(updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_kms_files_name ON kms_files(file_name);
      CREATE INDEX IF NOT EXISTS idx_kms_files_dir_status_name ON kms_files(dir_id, index_status, file_name);

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
      CREATE INDEX IF NOT EXISTS idx_kms_paragraphs_file_index ON kms_paragraphs(file_id, paragraph_index DESC);

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
      -- tokenize='unicode61'：索引侧由 kmsTokenizer.segment() 预分词（jieba），
      --   将连续中文切分为空格分隔的词序列，使 unicode61 按空格建立正确 token 边界
      -- prefix='2,3'：预建 2/3 字符前缀索引，加速英文前缀匹配与中文子词召回
      CREATE VIRTUAL TABLE IF NOT EXISTS kms_fts USING fts5(
        title,
        content,
        keywords,
        file_id UNINDEXED,
        source_type UNINDEXED,
        source_id UNINDEXED,
        index_id UNINDEXED,
        tokenize='unicode61',
        prefix='2,3'
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
      CREATE INDEX IF NOT EXISTS idx_kms_embeddings_dimension ON kms_embeddings(dimension);
      CREATE INDEX IF NOT EXISTS idx_kms_embeddings_updated ON kms_embeddings(updated_at DESC);
      -- 覆盖索引：支持 anti-join 查询的 index-only scan（避免回表取 id）
      CREATE INDEX IF NOT EXISTS idx_kms_embeddings_source_covering ON kms_embeddings(source_type, source_id, id);

      -- 访问追踪表（用于冷热数据判定）
      CREATE TABLE IF NOT EXISTS kms_access_log (
        id TEXT PRIMARY KEY,
        file_id TEXT NOT NULL REFERENCES kms_files(id) ON DELETE CASCADE,
        access_type TEXT NOT NULL,
        accessed_at INTEGER NOT NULL DEFAULT (unixepoch())
      );

      CREATE INDEX IF NOT EXISTS idx_kms_access_log_time ON kms_access_log(accessed_at);
      -- 复合索引：支持 getFileAccessStatsBatch 的 WHERE file_id IN (...) AND access_type = ? AND accessed_at >= ?
      -- 同时覆盖单列 file_id 查询（最左前缀），无需再单独建 idx_kms_access_log_file
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

    this.migrateSchema()

    this.recoverStuckFiles()
  }

  private migrateSchema(): void {
    const cols = this.db.prepare("PRAGMA table_info(kms_file_summaries)").all() as any[]
    const colNames = cols.map(c => c.name)
    if (!colNames.includes('light_summary')) {
      this.db.exec("ALTER TABLE kms_file_summaries ADD COLUMN light_summary TEXT DEFAULT ''")
    }
    if (!colNames.includes('preview_text')) {
      this.db.exec("ALTER TABLE kms_file_summaries ADD COLUMN preview_text TEXT DEFAULT ''")
    }
    if (!colNames.includes('parse_mode')) {
      this.db.exec("ALTER TABLE kms_file_summaries ADD COLUMN parse_mode TEXT DEFAULT ''")
    }

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

    this.enforceUniqueFileHash()

    this.db.exec('DROP INDEX IF EXISTS idx_kms_access_log_file')
  }

  private enforceUniqueFileHash(): void {
    const idxExists = this.db.prepare(
      "SELECT name FROM sqlite_master WHERE type='index' AND name='idx_kms_files_hash_unique'"
    ).get() as any
    if (idxExists) return

    const dupes = this.db.prepare(`
      SELECT file_hash, COUNT(*) as cnt FROM kms_files GROUP BY file_hash HAVING cnt > 1
    `).all() as any[]

    if (dupes.length > 0) {
      const keepIds = this.db.prepare(`
        SELECT id FROM kms_files WHERE file_hash = ? ORDER BY created_at ASC LIMIT 1
      `)
      const findDupes = this.db.prepare(`
        SELECT id FROM kms_files WHERE file_hash = ? AND id != ? ORDER BY created_at ASC
      `)
      const migrateRefs = this.db.transaction((dupeIds: string[], keepId: string) => {
        const placeholders = dupeIds.map(() => '?').join(',')
        this.db.prepare(
          `INSERT OR IGNORE INTO kms_file_collections (file_id, collection_id, added_at)
           SELECT ?, collection_id, added_at FROM kms_file_collections WHERE file_id IN (${placeholders})`
        ).run(keepId, ...dupeIds)
        this.db.prepare(
          `DELETE FROM kms_file_collections WHERE file_id IN (${placeholders})`
        ).run(...dupeIds)
        this.db.prepare(
          `UPDATE kms_access_log SET file_id = ? WHERE file_id IN (${placeholders})`
        ).run(keepId, ...dupeIds)
      })
      for (const dup of dupes) {
        const keepRow = keepIds.get(dup.file_hash) as any
        if (!keepRow) continue
        const dupeRows = findDupes.all(dup.file_hash, keepRow.id) as any[]
        const dupeIds = dupeRows.map(r => r.id)
        if (dupeIds.length > 0) migrateRefs(dupeIds, keepRow.id)
        const delPlaceholders = dupeIds.map(() => '?').join(',')
        this.db.prepare(
          `DELETE FROM kms_files WHERE id IN (${delPlaceholders})`
        ).run(...dupeIds)
      }
      logger.info(`Deduplicated ${dupes.length} file_hash group(s) before enforcing unique constraint`)
    }

    this.db.exec('DROP INDEX IF EXISTS idx_kms_files_hash')
    this.db.exec('DROP INDEX IF EXISTS idx_kms_files_hash_unique')
    this.db.exec('CREATE INDEX IF NOT EXISTS idx_kms_files_hash_unique ON kms_files(file_hash)')
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

  /**
   * 手动触发 WAL checkpoint。
   *
   * 默认 PASSIVE 模式：不等待读者，把 WAL 内容合并回主库文件后返回。
   * 适合在以下时机调用：
   * - 大批量索引完成后
   * - 应用退出前
   * - 用户空闲时（如定时任务）
   *
   * @param mode 'PASSIVE'|'FULL'|'RESTART'|'TRUNCATE'
   * @returns { wal_pages, wal_frames, checkpointed } 信息
   */
  public checkpoint(mode: 'PASSIVE' | 'FULL' | 'RESTART' | 'TRUNCATE' = 'PASSIVE'): { wal_pages: number; wal_frames: number; checkpointed: number } {
    const result = this.db.pragma(`wal_checkpoint(${mode})`) as any[]
    const row = result[0] || {}
    return {
      wal_pages: Number(row.busy ?? 0),
      wal_frames: Number(row.log ?? 0),
      checkpointed: Number(row.checkpointed ?? 0),
    }
  }

  /**
   * 在已存在的事务外执行回调，回调内所有数据库操作作为一个事务提交。
   * 用于上层合并多个小事务为单个大事务，减少 fsync 次数。
   */
  public runInTransaction<T>(fn: () => T): T {
    const tx = this.db.transaction(fn)
    return tx()
  }

  public close(): void {
    // 关闭前执行 TRUNCATE checkpoint，确保 WAL 内容写回主库文件
    try {
      this.checkpoint('TRUNCATE')
    } catch (err: any) {
      logger.warn('关闭前 checkpoint 失败:', err?.message || err)
    }
    this.db.close()
  }
}

export default KMSDatabaseService
