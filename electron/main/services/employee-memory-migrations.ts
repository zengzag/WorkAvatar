import { segmentMemoryText } from './employee-memory-fts'
import type { EmployeeMemory } from './employee-memory-types'
import { createLogger } from './logger'

const logger = createLogger('MemoryMigration')

/**
 * 迁移所需的最小数据库接口：
 * better-sqlite3（生产）与 node:sqlite（测试）都满足，迁移逻辑因此可以被集成测试覆盖。
 */
export interface MigrationDatabase {
  exec(sql: string): void
  prepare(sql: string): {
    run(...params: any[]): unknown
    all(...params: any[]): any[]
    get(...params: any[]): any
  }
}

interface ColumnInfo {
  name: string
  notnull: number
}

/** 读取表的列信息（PRAGMA table_info；表不存在时返回空数组） */
export function tableColumns(db: MigrationDatabase, table: string): ColumnInfo[] {
  return db.prepare(`PRAGMA table_info(${table})`).all() as ColumnInfo[]
}

/**
 * 记忆相关增量迁移入口（幂等，可在每次启动安全执行）：
 * 1. conversations.memory_extract_attempts：提取失败重试计数器
 * 2. employee_memories：补 scope 列并放开 employee_id 的 NOT NULL（全局记忆归属为 NULL）
 * 3. employee_memories_fts：按 jieba 预分词重建（旧索引把整段中文视作单 token，中文检索不可用）
 * 4. employee_memory_vectors：语义召回所需的向量表 + 删除清理触发器
 */
export function migrateMemorySchema(db: MigrationDatabase): void {
  migrateConversationMemoryAttempts(db)
  migrateEmployeeMemoriesScope(db)
  ensureMemoryFtsDeleteTrigger(db)
  ensureMemoryVectorTable(db)
  reindexMemoryFtsSegmented(db)
}

function migrateConversationMemoryAttempts(db: MigrationDatabase): void {
  if (tableColumns(db, 'conversations').some(c => c.name === 'memory_extract_attempts')) return
  db.exec('ALTER TABLE conversations ADD COLUMN memory_extract_attempts INTEGER NOT NULL DEFAULT 0')
  logger.info('迁移：conversations 增加 memory_extract_attempts 列')
}

function migrateEmployeeMemoriesScope(db: MigrationDatabase): void {
  const columns = tableColumns(db, 'employee_memories')
  if (columns.length === 0) return
  const hasScope = columns.some(c => c.name === 'scope')
  const employeeIdNotNull = columns.find(c => c.name === 'employee_id')?.notnull === 1
  if (hasScope && !employeeIdNotNull) return

  // SQLite 无法直接修改列的空值约束，需要重建表。
  // 重建 DDL 用显式事务包裹（exec 多语句默认逐条自动提交）：中途失败整体回滚，
  // 避免"DROP 后崩溃 → 下次启动建出空表、数据滞留 _migrated 表"的数据丢失。
  // PRAGMA foreign_keys 不能在事务内切换，必须留在事务外。
  db.exec('PRAGMA foreign_keys = OFF')
  try {
    const scopeExpr = hasScope ? 'scope' : "'employee'"
    db.exec('BEGIN IMMEDIATE')
    try {
      db.exec(`
        CREATE TABLE employee_memories_migrated (
          id TEXT PRIMARY KEY,
          employee_id TEXT REFERENCES employees(id) ON DELETE CASCADE,
          scope TEXT NOT NULL DEFAULT 'employee',
          key TEXT NOT NULL,
          topic TEXT NOT NULL,
          content TEXT NOT NULL DEFAULT '',
          is_pinned BOOLEAN NOT NULL DEFAULT 0,
          source TEXT NOT NULL DEFAULT 'auto',
          last_referenced_at INTEGER,
          importance TEXT NOT NULL DEFAULT 'normal',
          deleted_at INTEGER,
          created_at INTEGER NOT NULL DEFAULT (unixepoch()),
          updated_at INTEGER NOT NULL DEFAULT (unixepoch())
        );
        INSERT INTO employee_memories_migrated
          (id, employee_id, scope, key, topic, content, is_pinned, source, last_referenced_at, importance, deleted_at, created_at, updated_at)
          SELECT id, employee_id, ${scopeExpr}, key, topic, content, is_pinned, source, last_referenced_at, importance, deleted_at, created_at, updated_at
          FROM employee_memories;
        DROP TABLE employee_memories;
        ALTER TABLE employee_memories_migrated RENAME TO employee_memories;

        CREATE INDEX IF NOT EXISTS idx_employee_memories_employee ON employee_memories(employee_id);
        CREATE INDEX IF NOT EXISTS idx_employee_memories_scope ON employee_memories(scope, deleted_at);
        CREATE INDEX IF NOT EXISTS idx_employee_memories_pinned ON employee_memories(employee_id, is_pinned);
        CREATE INDEX IF NOT EXISTS idx_employee_memories_emp_key ON employee_memories(employee_id, key);
        CREATE INDEX IF NOT EXISTS idx_employee_memories_updated ON employee_memories(updated_at DESC);
        CREATE INDEX IF NOT EXISTS idx_employee_memories_emp_pin_updated ON employee_memories(employee_id, is_pinned, updated_at DESC);
        CREATE INDEX IF NOT EXISTS idx_employee_memories_last_ref ON employee_memories(last_referenced_at);
        CREATE INDEX IF NOT EXISTS idx_employee_memories_importance ON employee_memories(importance);
        CREATE INDEX IF NOT EXISTS idx_employee_memories_deleted ON employee_memories(employee_id, deleted_at);
      `)
      db.exec('COMMIT')
    } catch (err) {
      db.exec('ROLLBACK')
      throw err
    }
    logger.info('迁移：employee_memories 重建完成（新增 scope 列并放开 employee_id 约束）')
  } finally {
    db.exec('PRAGMA foreign_keys = ON')
  }
}

/**
 * FTS 行删除兜底触发器：员工删除级联清记忆、purgeMemory 等未手动同步 FTS 的路径，
 * 删除主表行后同步清掉对应 FTS 行，避免孤儿索引累积。
 */
function ensureMemoryFtsDeleteTrigger(db: MigrationDatabase): void {
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS trg_employee_memories_fts_cleanup
    AFTER DELETE ON employee_memories
    BEGIN
      DELETE FROM employee_memories_fts WHERE memory_id = OLD.id;
    END
  `)
}

/**
 * 记忆向量表：与 employee_memories 1:1，存放语义召回所需的 embedding。
 * - content_hash 用于检测"内容已变但向量未更新"，支撑回填自愈
 * - 删除触发器兜底：员工级联清理 / purgeMemory / emptyTrash 等直接删主表行的路径
 */
function ensureMemoryVectorTable(db: MigrationDatabase): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS employee_memory_vectors (
      memory_id TEXT PRIMARY KEY,
      model TEXT NOT NULL DEFAULT '',
      content_hash TEXT NOT NULL DEFAULT '',
      embedding BLOB NOT NULL,
      updated_at INTEGER NOT NULL DEFAULT (unixepoch())
    );
    CREATE TRIGGER IF NOT EXISTS trg_employee_memory_vectors_cleanup
    AFTER DELETE ON employee_memories
    BEGIN
      DELETE FROM employee_memory_vectors WHERE memory_id = OLD.id;
    END
  `)
}

/** 一次性重建记忆 FTS 索引：索引侧改用 jieba 预分词，使中文可按词命中 */
function reindexMemoryFtsSegmented(db: MigrationDatabase): void {
  const flag = db.prepare(
    "SELECT value FROM settings WHERE key = 'memory_fts_segmented_v2'"
  ).get() as { value: string } | undefined
  if (flag?.value === '1') return

  const rows = db.prepare(
    'SELECT id, employee_id, key, topic, content FROM employee_memories'
  ).all() as Array<Pick<EmployeeMemory, 'id' | 'employee_id' | 'key' | 'topic' | 'content'>>

  // 整体重建用事务包裹：中途失败全部回滚，避免应用带着空索引运行到下次重启
  db.exec('BEGIN IMMEDIATE')
  try {
    db.exec('DELETE FROM employee_memories_fts')
    const insert = db.prepare(
      'INSERT INTO employee_memories_fts (key, topic, content, memory_id, employee_id) VALUES (?, ?, ?, ?, ?)'
    )
    for (const r of rows) {
      insert.run(
        segmentMemoryText(r.key),
        segmentMemoryText(r.topic),
        segmentMemoryText(r.content),
        r.id,
        r.employee_id ?? ''
      )
    }
    db.prepare(
      `INSERT INTO settings (key, value, updated_at) VALUES ('memory_fts_segmented_v2', '1', unixepoch())
       ON CONFLICT(key) DO UPDATE SET value = '1', updated_at = unixepoch()`
    ).run()
    db.exec('COMMIT')
  } catch (err) {
    db.exec('ROLLBACK')
    throw err
  }
  logger.info(`迁移：记忆 FTS 索引按 jieba 分词重建完成（${rows.length} 条）`)
}
