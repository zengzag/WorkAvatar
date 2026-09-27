/**
 * DatabaseService 启动装配集成测试。
 *
 * 背景：employee-memory-migrations.test.ts 只直接测试 migrateMemorySchema 零件，
 * 从不实例化 DatabaseService；而旧库崩溃恰恰发生在"建索引 → 迁移"的调用顺序上
 * （idx_employee_memories_scope 在迁移补齐 scope 列之前创建）。本测试覆盖完整启动路径。
 *
 * better-sqlite3 原生模块按 Electron ABI 编译，无法在 Node 测试环境加载，
 * 故 mock 为 node:sqlite DatabaseSync + 接口适配器（pragma/transaction）。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { DatabaseSync } from 'node:sqlite'

/** 打开连接注册表：构造函数中途抛错时也能在 afterEach 强制关闭，避免 Windows 文件锁 */
const openConnections = vi.hoisted(() => new Set<DatabaseSync>())

vi.mock('better-sqlite3', async () => {
  const { DatabaseSync } = await import('node:sqlite')

  /** node:sqlite 补齐 better-sqlite3 使用到的 pragma/transaction 接口 */
  function createAdaptedDb(filename: string): DatabaseSync {
    const db = new DatabaseSync(filename)
    const anyDb = db as unknown as {
      pragma(s: string): void
      transaction<T extends (...args: any[]) => any>(fn: T): (...args: Parameters<T>) => ReturnType<T>
    }
    anyDb.pragma = (s: string) => db.exec(`PRAGMA ${s}`)
    anyDb.transaction = (fn) => (...args) => {
      db.exec('BEGIN')
      try {
        const result = fn(...args)
        db.exec('COMMIT')
        return result
      } catch (err) {
        db.exec('ROLLBACK')
        throw err
      }
    }
    openConnections.add(db)
    const rawClose = db.close.bind(db)
    ;(db as unknown as { close(): void }).close = () => {
      openConnections.delete(db)
      rawClose()
    }
    return db
  }

  return {
    default: function (this: unknown, filename: string) {
      return createAdaptedDb(filename)
    }
  }
})

vi.mock('../../../electron/main/services/path.service', () => ({
  default: class {
    static getInstance() {
      return new this()
    }
    getDataDir() {
      return (globalThis as any).__WA_DATA_DIR__ as string
    }
    getDbPath() {
      return path.join((globalThis as any).__WA_DATA_DIR__ as string, 'workavatar.db')
    }
  }
}))

import DatabaseService from '../../../electron/main/services/database.service'

/** 复刻用户真实旧库：employee_memories 无 scope 列、employee_id NOT NULL */
function createLegacyDbFile(dbPath: string): void {
  const db = new DatabaseSync(dbPath)
  db.exec(`
    CREATE TABLE employees (id TEXT PRIMARY KEY, name TEXT);
    INSERT INTO employees VALUES ('e1', '员工一');
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
    INSERT INTO employee_memories (id, employee_id, key, topic, content) VALUES
      ('m1', 'e1', 'writing_style', '用户偏好', '偏好简洁回复'),
      ('m2', 'e1', 'stack', '技术栈', 'Electron + Vue'),
      ('m3', 'e1', 'old_rule', '废弃结论', '旧结论');
  `)
  db.close()
}

let dataDir = ''

beforeEach(() => {
  openConnections.clear()
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-db-test-'))
  ;(globalThis as any).__WA_DATA_DIR__ = dataDir
  ;(DatabaseService as any).instance = undefined
})

afterEach(() => {
  for (const db of openConnections) {
    try { db.close() } catch { /* already closed */ }
  }
  openConnections.clear()
  ;(DatabaseService as any).instance = undefined
  try {
    fs.rmSync(dataDir, { recursive: true, force: true })
  } catch {
    // Windows 偶发文件句柄延迟释放；重试一次
    fs.rmSync(dataDir, { recursive: true, force: true })
  }
})

describe('DatabaseService 启动 / 旧库升级', () => {
  it('旧库（employee_memories 无 scope）启动不抛错，列与索引在迁移后补齐', () => {
    createLegacyDbFile(path.join(dataDir, 'workavatar.db'))

    let service: DatabaseService
    expect(() => {
      service = DatabaseService.getInstance()
    }).not.toThrow()

    const db = service!.getDb()
    const columns = db.prepare('PRAGMA table_info(employee_memories)').all() as Array<{ name: string; notnull: number }>

    expect(columns.some(c => c.name === 'scope')).toBe(true)
    expect(columns.find(c => c.name === 'employee_id')?.notnull).toBe(0)

    const scopeIndex = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='index' AND name='idx_employee_memories_scope'"
    ).get()
    expect(scopeIndex).toBeDefined()

    const rows = db.prepare('SELECT id, scope FROM employee_memories ORDER BY id').all() as Array<{ id: string; scope: string }>
    expect(rows).toHaveLength(3)
    expect(rows.every(r => r.scope === 'employee')).toBe(true)

    service!.close()
  })

  it('全新库启动：scope 索引随建表流程创建', () => {
    const service = DatabaseService.getInstance()
    const db = service.getDb()

    const scopeIndex = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='index' AND name='idx_employee_memories_scope'"
    ).get()
    expect(scopeIndex).toBeDefined()

    service.close()
  })

  it('同一旧库重复初始化幂等（模拟迁移后再次启动）', () => {
    createLegacyDbFile(path.join(dataDir, 'workavatar.db'))

    const first = DatabaseService.getInstance()
    first.close()
    ;(DatabaseService as any).instance = undefined

    expect(() => DatabaseService.getInstance()).not.toThrow()
    DatabaseService.getInstance().close()
  })
})
