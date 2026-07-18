import Database from 'better-sqlite3'
import fs from 'fs'
import PathService from './path.service'
import { createLogger } from './logger'
import { extractMessagePreview } from './common-utils'

const logger = createLogger('DB')

class DatabaseService {
  private db: Database.Database
  private static instance: DatabaseService

  private constructor() {
    const pathService = PathService.getInstance()
    const basePath = pathService.getDataDir()
    if (!fs.existsSync(basePath)) {
      fs.mkdirSync(basePath, { recursive: true })
    }
    const dbPath = pathService.getDbPath()
    this.db = new Database(dbPath, {
      readonly: false,
      timeout: 5000
    })

    this.db.pragma('journal_mode = WAL')
    this.db.pragma('foreign_keys = ON')

    this.initializeSchema()
    this.cleanupOldConversations()
  }

  /**
   * 启动时清理过期对话，防止 conversations.messages_json 无限增长。
   * - 30 天前的空对话（message_count = 0）：直接删除（用户创建但未发送任何消息的废弃对话）
   * - 180 天前且 messages_json > 2MB 的对话：保留最近 50 条消息，裁剪更早的历史
   */
  private cleanupOldConversations(): void {
    const now = Math.floor(Date.now() / 1000)

    // 1. 删除 30 天前的空对话（同步清理 FTS5 记录）
    try {
      const cutoff = now - 30 * 86400
      const emptyConvos = this.db.prepare(
        `SELECT id FROM conversations
         WHERE message_count = 0 AND messages_json = '[]' AND created_at < ?`
      ).all(cutoff) as any[]
      if (emptyConvos.length > 0) {
        const delTx = this.db.transaction(() => {
          for (const c of emptyConvos) {
            this.db.prepare('DELETE FROM conversations_fts WHERE conversation_id = ?').run(c.id)
            this.db.prepare('DELETE FROM conversations WHERE id = ?').run(c.id)
          }
        })
        delTx()
        logger.info(`启动清理：删除 ${emptyConvos.length} 条 30 天前空对话`)
      }
    } catch (err: any) {
      logger.warn('启动清理空对话失败:', err?.message || err)
    }

    // 2. 裁剪 180 天前的大对话（messages_json > 2MB），保留最近 50 条消息
    try {
      const cutoff = now - 180 * 86400
      const sizeThreshold = 2 * 1024 * 1024
      const oldConvos = this.db.prepare(
        `SELECT id, messages_json FROM conversations
         WHERE updated_at < ? AND length(messages_json) > ?`
      ).all(cutoff, sizeThreshold) as any[]

      let trimmed = 0
      const updateStmt = this.db.prepare(
        'UPDATE conversations SET messages_json = ?, message_count = ? WHERE id = ?'
      )
      const trimTx = this.db.transaction(() => {
        for (const c of oldConvos) {
          try {
            const messages = JSON.parse(c.messages_json)
            if (Array.isArray(messages) && messages.length > 50) {
              const trimmedMessages = messages.slice(-50)
              updateStmt.run(JSON.stringify(trimmedMessages), trimmedMessages.length, c.id)
              trimmed++
            }
          } catch { /* skip invalid JSON */ }
        }
      })
      trimTx()
      if (trimmed > 0) {
        logger.info(`启动清理：裁剪 ${trimmed} 条 180 天前大对话（保留最近 50 条消息）`)
      }
    } catch (err: any) {
      logger.warn('启动清理大对话失败:', err?.message || err)
    }
  }

  static getInstance(): DatabaseService {
    if (!DatabaseService.instance) {
      DatabaseService.instance = new DatabaseService()
    }
    return DatabaseService.instance
  }

  private addColumnIfNotExists(table: string, column: string, definition: string): void {
    const result = this.db.prepare(`PRAGMA table_info(${table})`).all() as any[]
    const columnExists = result.some((c) => c.name === column)
    if (!columnExists) {
      this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`)
    }
  }

  private initializeSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS employees (
        id TEXT PRIMARY KEY,
        workspace_path TEXT DEFAULT '',
        name TEXT NOT NULL,
        description TEXT DEFAULT '',
        avatar_type TEXT DEFAULT 'default',
        status TEXT NOT NULL DEFAULT 'draft',
        default_skill_id TEXT,
        profile_json TEXT DEFAULT '',
        arch_version INTEGER NOT NULL DEFAULT 1,
        total_tasks INTEGER DEFAULT 0,
        total_approvals INTEGER DEFAULT 0,
        memory_enabled BOOLEAN NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL DEFAULT (unixepoch()),
        updated_at INTEGER NOT NULL DEFAULT (unixepoch())
      );

      CREATE TABLE IF NOT EXISTS skills (
        id TEXT PRIMARY KEY,
        employee_id TEXT NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
        type TEXT NOT NULL,
        name TEXT NOT NULL,
        description TEXT DEFAULT '',
        config_json TEXT NOT NULL DEFAULT '{}',
        prompt_template TEXT,
        rules_json TEXT DEFAULT '[]',
        test_cases_json TEXT DEFAULT '[]',
        input_schema_json TEXT,
        output_schema_json TEXT,
        priority INTEGER NOT NULL DEFAULT 0,
        is_enabled BOOLEAN NOT NULL DEFAULT 1,
        created_at INTEGER NOT NULL DEFAULT (unixepoch())
      );

      CREATE TABLE IF NOT EXISTS conversations (
        id TEXT PRIMARY KEY,
        employee_id TEXT NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
        skill_id TEXT REFERENCES skills(id) ON DELETE SET NULL,
        title TEXT DEFAULT '',
        messages_json TEXT NOT NULL DEFAULT '[]',
        message_count INTEGER DEFAULT 0,
        status TEXT DEFAULT 'active',
        created_at INTEGER NOT NULL DEFAULT (unixepoch()),
        updated_at INTEGER NOT NULL DEFAULT (unixepoch())
      );

      CREATE TABLE IF NOT EXISTS feedbacks (
        id TEXT PRIMARY KEY,
        skill_id TEXT NOT NULL REFERENCES skills(id) ON DELETE CASCADE,
        conversation_id TEXT REFERENCES conversations(id) ON DELETE SET NULL,
        rating TEXT NOT NULL,
        note TEXT,
        original_output TEXT,
        corrected_output TEXT,
        is_used_for_training BOOLEAN DEFAULT 0,
        created_at INTEGER NOT NULL DEFAULT (unixepoch())
      );

      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at INTEGER NOT NULL DEFAULT (unixepoch())
      );

      CREATE TABLE IF NOT EXISTS llm_providers (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        provider_type TEXT NOT NULL,
        base_url TEXT,
        model TEXT NOT NULL,
        embedding_model TEXT DEFAULT 'text-embedding-3-small',
        temperature REAL DEFAULT 0.7,
        max_tokens INTEGER DEFAULT 4096,
        timeout_ms INTEGER DEFAULT 60000,
        extra_headers_json TEXT,
        extra_body_json TEXT,
        is_default BOOLEAN DEFAULT 0,
        models_json TEXT DEFAULT '[]',
        created_at INTEGER NOT NULL DEFAULT (unixepoch())
      );

      CREATE INDEX IF NOT EXISTS idx_employees_status ON employees(status);
      CREATE INDEX IF NOT EXISTS idx_skills_employee ON skills(employee_id);
      CREATE INDEX IF NOT EXISTS idx_conversations_employee ON conversations(employee_id);
      CREATE INDEX IF NOT EXISTS idx_feedbacks_skill ON feedbacks(skill_id);

      CREATE TABLE IF NOT EXISTS tools (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        description TEXT DEFAULT '',
        type TEXT NOT NULL DEFAULT 'builtin',
        config_json TEXT NOT NULL DEFAULT '{}',
        is_builtin BOOLEAN NOT NULL DEFAULT 0,
        is_enabled BOOLEAN NOT NULL DEFAULT 1,
        created_at INTEGER NOT NULL DEFAULT (unixepoch())
      );

      CREATE TABLE IF NOT EXISTS employee_tools (
        id TEXT PRIMARY KEY,
        employee_id TEXT NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
        tool_id TEXT NOT NULL,
        is_enabled BOOLEAN NOT NULL DEFAULT 1,
        config_json TEXT NOT NULL DEFAULT '{}',
        created_at INTEGER NOT NULL DEFAULT (unixepoch())
      );

      CREATE UNIQUE INDEX IF NOT EXISTS idx_employee_tools_unique ON employee_tools(employee_id, tool_id);

      CREATE INDEX IF NOT EXISTS idx_employee_tools_employee ON employee_tools(employee_id);
      CREATE INDEX IF NOT EXISTS idx_employee_tools_tool ON employee_tools(tool_id);

      CREATE TABLE IF NOT EXISTS installed_skills (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        description TEXT DEFAULT '',
        version TEXT DEFAULT '1.0.0',
        author TEXT DEFAULT '',
        tags_json TEXT DEFAULT '[]',
        install_path TEXT NOT NULL,
        manifest_json TEXT DEFAULT '{}',
        skill_md_content TEXT DEFAULT '',
        is_enabled BOOLEAN NOT NULL DEFAULT 1,
        created_at INTEGER NOT NULL DEFAULT (unixepoch())
      );

      CREATE TABLE IF NOT EXISTS employee_skills (
        id TEXT PRIMARY KEY,
        employee_id TEXT NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
        skill_id TEXT NOT NULL REFERENCES installed_skills(id) ON DELETE CASCADE,
        is_enabled BOOLEAN NOT NULL DEFAULT 1,
        config_json TEXT DEFAULT '{}',
        created_at INTEGER NOT NULL DEFAULT (unixepoch())
      );

      CREATE INDEX IF NOT EXISTS idx_employee_skills_employee ON employee_skills(employee_id);
      CREATE INDEX IF NOT EXISTS idx_employee_skills_skill ON employee_skills(skill_id);

      CREATE TABLE IF NOT EXISTS employee_memories (
        id TEXT PRIMARY KEY,
        employee_id TEXT NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
        key TEXT NOT NULL,
        topic TEXT NOT NULL,
        content TEXT NOT NULL DEFAULT '',
        is_pinned BOOLEAN NOT NULL DEFAULT 0,
        source TEXT NOT NULL DEFAULT 'auto',
        created_at INTEGER NOT NULL DEFAULT (unixepoch()),
        updated_at INTEGER NOT NULL DEFAULT (unixepoch())
      );

      CREATE INDEX IF NOT EXISTS idx_employee_memories_employee ON employee_memories(employee_id);
      CREATE INDEX IF NOT EXISTS idx_employee_memories_pinned ON employee_memories(employee_id, is_pinned);
      CREATE INDEX IF NOT EXISTS idx_employee_memories_emp_key ON employee_memories(employee_id, key);
      CREATE INDEX IF NOT EXISTS idx_employee_memories_updated ON employee_memories(updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_employee_memories_emp_pin_updated ON employee_memories(employee_id, is_pinned, updated_at DESC);
    `)

    this.addColumnIfNotExists('llm_providers', 'embedding_model', 'TEXT DEFAULT \'text-embedding-3-small\'')
    this.addColumnIfNotExists('llm_providers', 'models_json', 'TEXT DEFAULT \'[]\'')
    this.addColumnIfNotExists('llm_providers', 'extra_body_json', 'TEXT')
    this.addColumnIfNotExists('employees', 'profile_json', "TEXT DEFAULT ''")

    this.addColumnIfNotExists('employees', 'memory_enabled', 'BOOLEAN NOT NULL DEFAULT 0')

    this.addColumnIfNotExists('conversations', 'summary', "TEXT DEFAULT ''")
    this.addColumnIfNotExists('conversations', 'minimal_mode', 'BOOLEAN NOT NULL DEFAULT 0')
    this.addColumnIfNotExists('conversations', 'last_message_at', 'INTEGER')
    this.addColumnIfNotExists('conversations', 'system_prompt', "TEXT DEFAULT ''")
    this.addColumnIfNotExists('conversations', 'memory_extracted_at', 'INTEGER')
    this.addColumnIfNotExists('conversations', 'memory_extracted_message_count', 'INTEGER NOT NULL DEFAULT 0')

    this.migrateConversationLastMessageAt()

    this.addColumnIfNotExists('employee_memories', 'last_referenced_at', 'INTEGER')
    this.addColumnIfNotExists('employee_memories', 'importance', "TEXT NOT NULL DEFAULT 'normal'")

    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_conversations_emp_lastmsg ON conversations(employee_id, last_message_at);
      CREATE INDEX IF NOT EXISTS idx_employee_memories_last_ref ON employee_memories(last_referenced_at);
      CREATE INDEX IF NOT EXISTS idx_employee_memories_importance ON employee_memories(importance);
    `)

    this.migrateEmployeeAddWorkspacePath()

    this.db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS employee_memories_fts USING fts5(
        key,
        topic,
        content,
        memory_id UNINDEXED,
        employee_id UNINDEXED,
        tokenize='unicode61',
        prefix='2,3'
      );
    `)
    this.migrateEmployeeMemoriesFTS()

    this.db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS conversations_fts USING fts5(
        title,
        summary,
        content_preview,
        conversation_id UNINDEXED,
        employee_id UNINDEXED,
        tokenize='unicode61',
        prefix='2,3'
      );
    `)
    this.migrateConversationsFTS()
  }

  private migrateEmployeeMemoriesFTS(): void {
    const count = this.db.prepare('SELECT COUNT(*) AS n FROM employee_memories_fts').get() as { n: number }
    if (count.n > 0) return
    const rows = this.db.prepare('SELECT id, employee_id, key, topic, content FROM employee_memories').all() as any[]
    if (rows.length === 0) return
    const insert = this.db.prepare(
      'INSERT INTO employee_memories_fts (key, topic, content, memory_id, employee_id) VALUES (?, ?, ?, ?, ?)'
    )
    const tx = this.db.transaction((items: any[]) => {
      for (const r of items) insert.run(r.key, r.topic, r.content, r.id, r.employee_id)
    })
    tx(rows)
    logger.info(`Migrated ${rows.length} employee_memories rows to FTS5 table`)
  }

  private migrateConversationsFTS(): void {
    const count = this.db.prepare('SELECT COUNT(*) AS n FROM conversations_fts').get() as { n: number }
    if (count.n > 0) return
    const rows = this.db.prepare('SELECT id, employee_id, title, summary, messages_json FROM conversations').all() as any[]
    if (rows.length === 0) return
    const insert = this.db.prepare(
      'INSERT INTO conversations_fts (title, summary, content_preview, conversation_id, employee_id) VALUES (?, ?, ?, ?, ?)'
    )
    const tx = this.db.transaction((items: any[]) => {
      for (const r of items) {
        const preview = extractMessagePreview(r.messages_json)
        insert.run(r.title || '', r.summary || '', preview, r.id, r.employee_id)
      }
    })
    tx(rows)
    logger.info(`Migrated ${rows.length} conversations to FTS5 table`)
  }

  private migrateEmployeeAddWorkspacePath(): void {
    this.addColumnIfNotExists('employees', 'workspace_path', "TEXT DEFAULT ''")
    const tableInfo = this.db.prepare('PRAGMA table_info(employees)').all() as any[]
    const hasProjectId = tableInfo.some((c) => c.name === 'project_id')
    if (hasProjectId) {
      logger.info('Migrating employees: removing project_id column...')
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS employees_new (
          id TEXT PRIMARY KEY,
          workspace_path TEXT DEFAULT '',
          name TEXT NOT NULL,
          description TEXT DEFAULT '',
          avatar_type TEXT DEFAULT 'default',
          status TEXT NOT NULL DEFAULT 'draft',
          default_skill_id TEXT,
          profile_json TEXT DEFAULT '',
          arch_version INTEGER NOT NULL DEFAULT 1,
          total_tasks INTEGER DEFAULT 0,
          total_approvals INTEGER DEFAULT 0,
          memory_enabled BOOLEAN NOT NULL DEFAULT 0,
          created_at INTEGER NOT NULL DEFAULT (unixepoch()),
          updated_at INTEGER NOT NULL DEFAULT (unixepoch())
        );
        INSERT INTO employees_new (id, workspace_path, name, description, avatar_type, status, default_skill_id, profile_json, arch_version, total_tasks, total_approvals, memory_enabled, created_at, updated_at)
          SELECT id, '', name, description, avatar_type, status, default_skill_id, profile_json, arch_version, total_tasks, total_approvals, memory_enabled, created_at, updated_at FROM employees;
        DROP TABLE employees;
        ALTER TABLE employees_new RENAME TO employees;
        CREATE INDEX IF NOT EXISTS idx_employees_status ON employees(status);
      `)
      logger.info('Migration completed: employees.project_id removed, workspace_path added')
    }
  }

  private migrateConversationLastMessageAt(): void {
    const result = this.db.prepare('UPDATE conversations SET last_message_at = updated_at WHERE last_message_at IS NULL').run()
    if (result.changes > 0) {
      logger.info(`Migration: set last_message_at for ${result.changes} conversations`)
    }
  }

  public getDb(): Database.Database {
    return this.db
  }

  public close(): void {
    this.db.close()
  }
}

export default DatabaseService
