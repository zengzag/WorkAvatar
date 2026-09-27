/**
 * 记忆迁移集成测试（node:sqlite，复刻旧版真实库结构）。
 *
 * 覆盖风险最高的环节——表重建：
 * - 旧库（employee_id NOT NULL、无 scope、FTS 未分词）迁移后数据完整、scope 回填、
 *   允许写入 employee_id 为 NULL 的全局记忆、conversations 增加失败计数列、FTS 中文可命中
 * - 重复执行幂等
 * - scope 已存在但 employee_id 仍 NOT NULL 的半迁移状态也会被修正
 */
import { describe, it, expect } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { migrateMemorySchema, tableColumns, type MigrationDatabase } from '../../../electron/main/services/employee-memory-migrations'
import { buildMemoryFtsMatch } from '../../../electron/main/services/employee-memory-fts'

/** 复刻上一版（无 scope / 无 attempts）的库结构 */
function createLegacyDb(): DatabaseSync {
  const db = new DatabaseSync(':memory:')
  db.exec(`
    CREATE TABLE employees (id TEXT PRIMARY KEY, name TEXT);
    INSERT INTO employees VALUES ('e1', '员工');
    CREATE TABLE conversations (
      id TEXT PRIMARY KEY,
      employee_id TEXT NOT NULL,
      title TEXT DEFAULT '',
      summary TEXT DEFAULT '',
      messages_json TEXT NOT NULL DEFAULT '[]',
      message_count INTEGER DEFAULT 0,
      created_at INTEGER NOT NULL DEFAULT (unixepoch()),
      updated_at INTEGER NOT NULL DEFAULT (unixepoch())
    );
    CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL DEFAULT (unixepoch()));
    CREATE TABLE employee_memories (
      id TEXT PRIMARY KEY,
      employee_id TEXT NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
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
    CREATE VIRTUAL TABLE employee_memories_fts USING fts5(
      key, topic, content, memory_id UNINDEXED, employee_id UNINDEXED,
      tokenize='unicode61', prefix='2,3'
    );
  `)
  return db
}

function seedLegacyData(db: DatabaseSync): void {
  db.prepare(
    `INSERT INTO conversations (id, employee_id, title, message_count) VALUES (?, ?, ?, ?)`
  ).run('c1', 'e1', '历史对话', 3)
  // 一条有效记忆、一条已软删记忆（验证回收站数据在重建后仍保留）
  db.prepare(
    `INSERT INTO employee_memories (id, employee_id, key, topic, content, importance) VALUES (?, ?, ?, ?, ?, ?)`
  ).run('m1', 'e1', 'writing_style', '用户偏好', '用户偏好简洁回复', 'normal')
  db.prepare(
    `INSERT INTO employee_memories (id, employee_id, key, topic, content, deleted_at) VALUES (?, ?, ?, ?, ?, ?)`
  ).run('m2', 'e1', 'old_key', '决策结论', '旧结论', 100)
  // 旧 FTS：未分词
  db.prepare(
    'INSERT INTO employee_memories_fts (key, topic, content, memory_id, employee_id) VALUES (?, ?, ?, ?, ?)'
  ).run('writing_style', '用户偏好', '用户偏好简洁回复', 'm1', 'e1')
}

describe('memory migrations / 旧库迁移', () => {
  it('迁移前确认确实是旧结构', () => {
    const db = createLegacyDb()
    seedLegacyData(db)
    expect(tableColumns(db, 'employee_memories').some(c => c.name === 'scope')).toBe(false)
    expect(tableColumns(db, 'conversations').some(c => c.name === 'memory_extract_attempts')).toBe(false)
    db.close()
  })

  it('迁移后：结构升级且数据完整', () => {
    const db = createLegacyDb()
    seedLegacyData(db)

    migrateMemorySchema(db as unknown as MigrationDatabase)

    // 1) scope 列存在，所有旧行回填为 employee
    const memCols = tableColumns(db, 'employee_memories')
    expect(memCols.some(c => c.name === 'scope')).toBe(true)
    const rows = db.prepare('SELECT id, scope, content, deleted_at FROM employee_memories ORDER BY id').all()
    expect(rows).toEqual([
      { id: 'm1', scope: 'employee', content: '用户偏好简洁回复', deleted_at: null },
      { id: 'm2', scope: 'employee', content: '旧结论', deleted_at: 100 },
    ])

    // 2) employee_id 已可空 → 允许写入全局记忆（旧 NOT NULL 约束下会直接报错）
    db.prepare(
      'INSERT INTO employee_memories (id, employee_id, key, topic, content, scope) VALUES (?, ?, ?, ?, ?, ?)'
    ).run('g1', null, 'user_role', '事实知识', '用户是财务岗', 'global')
    const globalRow = db.prepare('SELECT employee_id, scope FROM employee_memories WHERE id = ?').get('g1')
    expect(globalRow).toEqual({ employee_id: null, scope: 'global' })

    // 3) conversations 增加失败计数列，存量行默认 0
    expect(tableColumns(db, 'conversations').some(c => c.name === 'memory_extract_attempts')).toBe(true)
    const conv = db.prepare('SELECT memory_extract_attempts FROM conversations WHERE id = ?').get('c1')
    expect(conv).toEqual({ memory_extract_attempts: 0 })

    // 4) FTS 已按 jieba 分词重建：中文子串可命中，且包含全部未删除记忆
    const match = buildMemoryFtsMatch('用户偏好')!
    const hit = db.prepare(
      `SELECT f.memory_id FROM employee_memories_fts f WHERE employee_memories_fts MATCH ? ORDER BY bm25(employee_memories_fts)`
    ).all(match) as Array<{ memory_id: string }>
    expect(hit.map(r => r.memory_id)).toEqual(['m1'])

    db.close()
  })

  it('迁移幂等：连续执行两次不报错且不丢数据', () => {
    const db = createLegacyDb()
    seedLegacyData(db)
    const first = migrateMemorySchema
    first(db as unknown as MigrationDatabase)
    expect(() => migrateMemorySchema(db as unknown as MigrationDatabase)).not.toThrow()

    const count = db.prepare('SELECT COUNT(*) n FROM employee_memories').get() as { n: number }
    expect(count.n).toBe(2)
    const flag = db.prepare("SELECT value FROM settings WHERE key = 'memory_fts_segmented_v2'").get() as { value: string }
    expect(flag.value).toBe('1')
    db.close()
  })
})

describe('memory migrations / 半迁移状态', () => {
  it('scope 已存在但 employee_id 仍 NOT NULL 时重建表', () => {
    const db = new DatabaseSync(':memory:')
    db.exec(`
      CREATE TABLE employees (id TEXT PRIMARY KEY);
      CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL DEFAULT (unixepoch()));
      CREATE TABLE conversations (id TEXT PRIMARY KEY, employee_id TEXT NOT NULL, messages_json TEXT DEFAULT '[]');
      CREATE TABLE employee_memories (
        id TEXT PRIMARY KEY,
        employee_id TEXT NOT NULL,
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
      CREATE VIRTUAL TABLE employee_memories_fts USING fts5(
        key, topic, content, memory_id UNINDEXED, employee_id UNINDEXED
      );
    `)
    db.prepare('INSERT INTO employee_memories (id, employee_id, key, topic, content) VALUES (?, ?, ?, ?, ?)')
      .run('m1', 'e1', 'writing_style', '用户偏好', '用户偏好简洁回复')

    migrateMemorySchema(db as unknown as MigrationDatabase)

    const employeeCol = tableColumns(db, 'employee_memories').find(c => c.name === 'employee_id')
    expect(employeeCol?.notnull).toBe(0)
    const row = db.prepare('SELECT scope, content FROM employee_memories WHERE id = ?').get('m1')
    expect(row).toEqual({ scope: 'employee', content: '用户偏好简洁回复' })
    db.close()
  })
})
