import Database from 'better-sqlite3'
import fs from 'fs'
import path from 'path'
import PathService from './path.service'
import DatabaseService from './database.service'
import { createLogger } from './logger'

const logger = createLogger('KB-DB')

class KBDatabaseService {
  private db: Database.Database
  private static instance: KBDatabaseService

  private constructor() {
    const pathService = PathService.getInstance()
    const kbDbPath = pathService.getKBDbPath()
    const dir = path.dirname(kbDbPath)
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true })
    }

    this.db = new Database(kbDbPath, {
      readonly: false,
      timeout: 5000
    })

    this.db.pragma('journal_mode = WAL')
    this.db.pragma('foreign_keys = ON')

    this.initializeSchema()
    this.migrateFromMainDb()
  }

  static getInstance(): KBDatabaseService {
    if (!KBDatabaseService.instance) {
      KBDatabaseService.instance = new KBDatabaseService()
    }
    return KBDatabaseService.instance
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
      CREATE TABLE IF NOT EXISTS knowledge_bases (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        description TEXT DEFAULT '',
        root_path TEXT NOT NULL,
        created_at INTEGER NOT NULL DEFAULT (unixepoch()),
        updated_at INTEGER NOT NULL DEFAULT (unixepoch())
      );

      CREATE TABLE IF NOT EXISTS kb_documents (
        id TEXT PRIMARY KEY,
        kb_id TEXT NOT NULL REFERENCES knowledge_bases(id) ON DELETE CASCADE,
        file_id TEXT,
        original_name TEXT NOT NULL,
        type TEXT NOT NULL,
        size INTEGER NOT NULL DEFAULT 0,
        hash TEXT NOT NULL,
        parsed_json_path TEXT,
        parse_status TEXT NOT NULL DEFAULT 'pending',
        parse_error TEXT,
        parse_progress REAL NOT NULL DEFAULT 0,
        parse_stage TEXT DEFAULT '',
        parse_detail TEXT DEFAULT '',
        processed_pages INTEGER DEFAULT 0,
        total_pages INTEGER DEFAULT 0,
        processed_chunks INTEGER DEFAULT 0,
        total_chunks INTEGER DEFAULT 0,
        parse_speed REAL DEFAULT 0,
        parse_eta INTEGER DEFAULT 0,
        parse_state_json TEXT,
        is_reused INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL DEFAULT (unixepoch()),
        updated_at INTEGER NOT NULL DEFAULT (unixepoch())
      );

      CREATE TABLE IF NOT EXISTS kb_project_links (
        id TEXT PRIMARY KEY,
        kb_id TEXT NOT NULL REFERENCES knowledge_bases(id) ON DELETE CASCADE,
        project_id TEXT NOT NULL,
        created_at INTEGER NOT NULL DEFAULT (unixepoch())
      );

      CREATE INDEX IF NOT EXISTS idx_kb_documents_kb ON kb_documents(kb_id);
      CREATE INDEX IF NOT EXISTS idx_kb_documents_hash ON kb_documents(hash);
      CREATE INDEX IF NOT EXISTS idx_kb_project_links_kb ON kb_project_links(kb_id);
      CREATE INDEX IF NOT EXISTS idx_kb_project_links_project ON kb_project_links(project_id);

      CREATE TABLE IF NOT EXISTS kb_chapters (
        id TEXT PRIMARY KEY,
        kb_id TEXT NOT NULL REFERENCES knowledge_bases(id) ON DELETE CASCADE,
        document_id TEXT NOT NULL REFERENCES kb_documents(id) ON DELETE CASCADE,
        title TEXT NOT NULL,
        chapter_index INTEGER NOT NULL DEFAULT 0,
        start_offset INTEGER NOT NULL DEFAULT 0,
        end_offset INTEGER NOT NULL DEFAULT 0,
        content TEXT NOT NULL DEFAULT '',
        summary TEXT,
        keywords_json TEXT DEFAULT '[]',
        entities_json TEXT DEFAULT '[]',
        vector_id TEXT,
        created_at INTEGER NOT NULL DEFAULT (unixepoch()),
        updated_at INTEGER NOT NULL DEFAULT (unixepoch())
      );

      CREATE INDEX IF NOT EXISTS idx_kb_chapters_document ON kb_chapters(document_id);
      CREATE INDEX IF NOT EXISTS idx_kb_chapters_kb ON kb_chapters(kb_id);

      CREATE TABLE IF NOT EXISTS kb_document_summaries (
        id TEXT PRIMARY KEY,
        kb_id TEXT NOT NULL REFERENCES knowledge_bases(id) ON DELETE CASCADE,
        document_id TEXT NOT NULL UNIQUE REFERENCES kb_documents(id) ON DELETE CASCADE,
        summary TEXT NOT NULL DEFAULT '',
        key_entities_json TEXT DEFAULT '[]',
        timeline_json TEXT DEFAULT '[]',
        keywords_json TEXT DEFAULT '[]',
        main_topics_json TEXT DEFAULT '[]',
        vector_id TEXT,
        created_at INTEGER NOT NULL DEFAULT (unixepoch()),
        updated_at INTEGER NOT NULL DEFAULT (unixepoch())
      );

      CREATE INDEX IF NOT EXISTS idx_kb_document_summaries_kb ON kb_document_summaries(kb_id);
      CREATE INDEX IF NOT EXISTS idx_kb_document_summaries_doc ON kb_document_summaries(document_id);

      CREATE TABLE IF NOT EXISTS kb_global_summaries (
        id TEXT PRIMARY KEY,
        kb_id TEXT NOT NULL UNIQUE REFERENCES knowledge_bases(id) ON DELETE CASCADE,
        summary TEXT NOT NULL DEFAULT '',
        key_topics_json TEXT DEFAULT '[]',
        key_entities_json TEXT DEFAULT '[]',
        global_timeline_json TEXT DEFAULT '[]',
        vector_id TEXT,
        created_at INTEGER NOT NULL DEFAULT (unixepoch()),
        updated_at INTEGER NOT NULL DEFAULT (unixepoch())
      );

      CREATE INDEX IF NOT EXISTS idx_kb_global_summaries_kb ON kb_global_summaries(kb_id);

      CREATE TABLE IF NOT EXISTS kb_entities (
        id TEXT PRIMARY KEY,
        kb_id TEXT NOT NULL REFERENCES knowledge_bases(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        type TEXT NOT NULL DEFAULT 'other',
        description TEXT DEFAULT '',
        aliases_json TEXT DEFAULT '[]',
        attributes_json TEXT DEFAULT '{}',
        mention_count INTEGER NOT NULL DEFAULT 0,
        first_seen_doc_id TEXT REFERENCES kb_documents(id) ON DELETE SET NULL,
        created_at INTEGER NOT NULL DEFAULT (unixepoch()),
        updated_at INTEGER NOT NULL DEFAULT (unixepoch())
      );

      CREATE INDEX IF NOT EXISTS idx_kb_entities_kb ON kb_entities(kb_id);
      CREATE INDEX IF NOT EXISTS idx_kb_entities_name ON kb_entities(kb_id, name);

      CREATE TABLE IF NOT EXISTS kb_entity_relations (
        id TEXT PRIMARY KEY,
        kb_id TEXT NOT NULL REFERENCES knowledge_bases(id) ON DELETE CASCADE,
        source_entity_id TEXT NOT NULL REFERENCES kb_entities(id) ON DELETE CASCADE,
        target_entity_id TEXT NOT NULL REFERENCES kb_entities(id) ON DELETE CASCADE,
        relation_type TEXT NOT NULL DEFAULT 'related_to',
        description TEXT DEFAULT '',
        source_document_id TEXT REFERENCES kb_documents(id) ON DELETE SET NULL,
        confidence REAL NOT NULL DEFAULT 1.0,
        created_at INTEGER NOT NULL DEFAULT (unixepoch())
      );

      CREATE INDEX IF NOT EXISTS idx_kb_entity_relations_source ON kb_entity_relations(source_entity_id);
      CREATE INDEX IF NOT EXISTS idx_kb_entity_relations_target ON kb_entity_relations(target_entity_id);
      CREATE INDEX IF NOT EXISTS idx_kb_entity_relations_kb ON kb_entity_relations(kb_id);

      CREATE TABLE IF NOT EXISTS kb_entity_mentions (
        id TEXT PRIMARY KEY,
        entity_id TEXT NOT NULL REFERENCES kb_entities(id) ON DELETE CASCADE,
        document_id TEXT NOT NULL REFERENCES kb_documents(id) ON DELETE CASCADE,
        chapter_id TEXT REFERENCES kb_chapters(id) ON DELETE SET NULL,
        context_text TEXT DEFAULT '',
        start_offset INTEGER NOT NULL DEFAULT 0,
        end_offset INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL DEFAULT (unixepoch())
      );

      CREATE INDEX IF NOT EXISTS idx_kb_entity_mentions_entity ON kb_entity_mentions(entity_id);
      CREATE INDEX IF NOT EXISTS idx_kb_entity_mentions_document ON kb_entity_mentions(document_id);
      CREATE INDEX IF NOT EXISTS idx_kb_entity_mentions_chapter ON kb_entity_mentions(chapter_id);

      CREATE TABLE IF NOT EXISTS kb_processing_jobs (
        id TEXT PRIMARY KEY,
        kb_id TEXT NOT NULL REFERENCES knowledge_bases(id) ON DELETE CASCADE,
        document_id TEXT REFERENCES kb_documents(id) ON DELETE CASCADE,
        job_type TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        progress INTEGER NOT NULL DEFAULT 0,
        total_steps INTEGER NOT NULL DEFAULT 0,
        current_step TEXT DEFAULT '',
        error_message TEXT,
        started_at INTEGER,
        completed_at INTEGER,
        paused_at INTEGER,
        resume_state_json TEXT,
        created_at INTEGER NOT NULL DEFAULT (unixepoch()),
        updated_at INTEGER NOT NULL DEFAULT (unixepoch())
      );

      CREATE INDEX IF NOT EXISTS idx_kb_processing_jobs_kb ON kb_processing_jobs(kb_id);
      CREATE INDEX IF NOT EXISTS idx_kb_processing_jobs_status ON kb_processing_jobs(status);

      CREATE TABLE IF NOT EXISTS wiki_compile_cache (
        id TEXT PRIMARY KEY,
        source_hash TEXT NOT NULL,
        source_slug TEXT NOT NULL,
        analysis_json TEXT NOT NULL,
        kb_id TEXT,
        created_at INTEGER NOT NULL DEFAULT (unixepoch()),
        updated_at INTEGER NOT NULL DEFAULT (unixepoch())
      );

      CREATE INDEX IF NOT EXISTS idx_wiki_compile_cache_hash ON wiki_compile_cache(source_hash);

      CREATE TABLE IF NOT EXISTS kb_search_index (
        id TEXT PRIMARY KEY,
        kb_id TEXT NOT NULL REFERENCES knowledge_bases(id) ON DELETE CASCADE,
        source_type TEXT NOT NULL,
        source_id TEXT NOT NULL,
        document_id TEXT REFERENCES kb_documents(id) ON DELETE CASCADE,
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

      CREATE INDEX IF NOT EXISTS idx_kb_search_index_kb ON kb_search_index(kb_id);
      CREATE INDEX IF NOT EXISTS idx_kb_search_index_source ON kb_search_index(source_type, source_id);
      CREATE INDEX IF NOT EXISTS idx_kb_search_index_doc ON kb_search_index(document_id);
      CREATE INDEX IF NOT EXISTS idx_kb_search_index_type ON kb_search_index(kb_id, source_type);

      CREATE VIRTUAL TABLE IF NOT EXISTS kb_fts USING fts5(
        title,
        content,
        keywords,
        kb_id UNINDEXED,
        source_type UNINDEXED,
        source_id UNINDEXED,
        document_id UNINDEXED,
        index_id UNINDEXED,
        tokenize='unicode61'
      );

      CREATE TABLE IF NOT EXISTS kb_embeddings (
        id TEXT PRIMARY KEY,
        kb_id TEXT NOT NULL REFERENCES knowledge_bases(id) ON DELETE CASCADE,
        source_type TEXT NOT NULL,
        source_id TEXT NOT NULL,
        document_id TEXT REFERENCES kb_documents(id) ON DELETE CASCADE,
        embedding BLOB NOT NULL,
        model TEXT NOT NULL DEFAULT '',
        dimension INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL DEFAULT (unixepoch()),
        updated_at INTEGER NOT NULL DEFAULT (unixepoch())
      );

      CREATE INDEX IF NOT EXISTS idx_kb_embeddings_kb ON kb_embeddings(kb_id);
      CREATE INDEX IF NOT EXISTS idx_kb_embeddings_source ON kb_embeddings(source_type, source_id);
      CREATE INDEX IF NOT EXISTS idx_kb_embeddings_doc ON kb_embeddings(document_id);
    `)

    this.recoverStuckDocs()
  }

  private recoverStuckDocs(): void {
    const parsingResult = this.db.prepare(`
      UPDATE kb_documents
      SET parse_status = 'paused'
      WHERE parse_status = 'parsing'
    `).run()
    if (parsingResult.changes > 0) {
      logger.info(`Recovered ${parsingResult.changes} document(s) from parsing to paused status`)
    }

    this.db.prepare(`
      UPDATE kb_processing_jobs
      SET status = 'paused'
      WHERE status = 'running'
    `).run()
  }

  private migrateFromMainDb(): void {
    try {
      const mainDb = DatabaseService.getInstance().getDb()

      const mainHasKBTables = (mainDb.prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='knowledge_bases'"
      ).get() as any)

      if (!mainHasKBTables) return

      const mainKBCount = (mainDb.prepare('SELECT COUNT(*) as count FROM knowledge_bases').get() as any)?.count || 0
      if (mainKBCount === 0) return

      const kbCount = (this.db.prepare('SELECT COUNT(*) as count FROM knowledge_bases').get() as any)?.count || 0
      if (kbCount > 0) return

      logger.info(`Migrating ${mainKBCount} knowledge bases from main database...`)

      const KB_TABLES = [
        'knowledge_bases',
        'kb_project_links',
        'kb_documents',
        'kb_chapters',
        'kb_document_summaries',
        'kb_global_summaries',
        'kb_entities',
        'kb_entity_relations',
        'kb_entity_mentions',
        'kb_processing_jobs',
        'wiki_compile_cache',
        'kb_search_index',
        'kb_embeddings',
      ]

      const SKIPPED_COLS = new Set(['content_text', 'parsed_json', 'content_path'])

      const transaction = this.db.transaction(() => {
        for (const table of KB_TABLES) {
          try {
            const mainHasTable = (mainDb.prepare(
              "SELECT name FROM sqlite_master WHERE type='table' AND name=?"
            ).get(table) as any)

            if (!mainHasTable) continue

            const rows = mainDb.prepare(`SELECT * FROM ${table}`).all() as any[]
            if (rows.length === 0) continue

            const columns = Object.keys(rows[0]).filter(c => !SKIPPED_COLS.has(c))
            const colList = columns.join(', ')
            const placeholders = columns.map(() => '?').join(', ')

            const insertStmt = this.db.prepare(
              `INSERT OR IGNORE INTO ${table} (${colList}) VALUES (${placeholders})`
            )

            for (const row of rows) {
              insertStmt.run(...columns.map(c => row[c]))
            }

            logger.info(`Migrated ${rows.length} rows from ${table}`)
          } catch (err) {
            logger.warn(`Failed to migrate table ${table}:`, err)
          }
        }

        try {
          const ftsRows = mainDb.prepare("SELECT * FROM kb_fts").all() as any[]
          if (ftsRows.length > 0) {
            const ftsCols = Object.keys(ftsRows[0])
            const ftsInsertStmt = this.db.prepare(
              `INSERT INTO kb_fts (${ftsCols.join(', ')}) VALUES (${ftsCols.map(() => '?').join(', ')})`
            )
            for (const row of ftsRows) {
              ftsInsertStmt.run(...ftsCols.map(c => row[c]))
            }
            logger.info(`Migrated ${ftsRows.length} rows from kb_fts`)
          }
        } catch (err) {
          logger.warn('Failed to migrate kb_fts:', err)
        }
      })

      transaction()
      logger.info('Migration completed successfully')
    } catch (err) {
      logger.error('Migration failed:', err)
    }
  }

  public getDb(): Database.Database {
    return this.db
  }

  public close(): void {
    this.db.close()
  }
}

export default KBDatabaseService
