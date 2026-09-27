/**
 * KMSDatabaseService 真实实例化测试：
 * 双库打开 + 全量 schema 落地、pragma 配置、孤儿清理、checkpoint、事务封装、
 * 数据库统计、FTS5 优化、cleanupDatabase 全链路、close。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'

const state = vi.hoisted(() => ({ root: '' }))

function openDb(dbPath: string): any {
  // node:sqlite 真实文件连接；补 better-sqlite3 风格 API
  const db = new DatabaseSync(dbPath)
  db.pragma = (s: string) => {
    if (s.startsWith('wal_checkpoint')) return [{ busy: 0, log: 0, checkpointed: 0 }]
    db.exec('PRAGMA ' + s)
  }
  db.loadExtension = vi.fn()
  // better-sqlite3 transaction API：用 SAVEPOINT 适配（支持嵌套调用）
  db.transaction = (fn: (...args: any[]) => any) => (...args: any[]) => {
    db.exec('SAVEPOINT wa_sp')
    try {
      const result = fn(...args)
      db.exec('RELEASE wa_sp')
      return result
    } catch (err) {
      db.exec('ROLLBACK TO wa_sp')
      throw err
    }
  }
  return db
}

vi.mock('better-sqlite3', () => ({ default: vi.fn().mockImplementation(openDb) }))
vi.mock('sqlite-vec', () => ({ getLoadablePath: () => '/fake/vec.ext' }))
vi.mock('../../../electron/main/services/path.service', () => ({
  default: {
    getInstance: () => ({
      getKMSDbPath: () => path.join(state.root, 'kms.db'),
      getKMSVectorDbPath: () => path.join(state.root, 'vectors.db'),
    }),
  },
}))
vi.mock('../../../electron/main/services/kms/kms-search-engine.service', () => ({
  default: { getInstance: () => ({ deleteIndexByFile: vi.fn() }) },
}))

import { DatabaseSync } from 'node:sqlite'
import KMSDatabaseService from '../../../electron/main/services/kms/kms-database.service'

beforeEach(() => {
  state.root = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-kmsdb-'))
  ;(KMSDatabaseService as any).instance = undefined
})

afterEach(() => {
  try { KMSDatabaseService.getInstance().close() } catch { /* already closed */ }
  ;(KMSDatabaseService as any).instance = undefined
  fs.rmSync(state.root, { recursive: true, force: true })
})

/** 等构造函数安排的 setImmediate(orphan cleanup) 执行完毕 */
async function flushImmediate(): Promise<void> {
  await new Promise<void>(r => setImmediate(r))
}

describe('KMSDatabaseService / 构造与 schema', () => {
  it('双库打开、核心表与 FTS 全部落地', async () => {
    const svc = KMSDatabaseService.getInstance()
    await flushImmediate()

    const db = svc.getDb()
    expect(db).toBeTruthy()
    expect(svc.getVectorDb()).toBeTruthy()

    const tables = db.prepare(
      "SELECT name FROM sqlite_master WHERE type IN ('table','index') AND name LIKE 'kms_%'"
    ).all() as Array<{ name: string }>
    const names = tables.map(t => t.name)
    for (const required of ['kms_files', 'kms_fts', 'kms_paragraphs', 'kms_stop_words', 'kms_keyword_stats']) {
      expect(names).toContain(required)
    }

    // 向量库
    const vecTables = svc.getVectorDb().prepare(
      "SELECT name FROM sqlite_master WHERE name='kms_embeddings'"
    ).all()
    expect(vecTables).toHaveLength(1)
  })
})

describe('KMSDatabaseService / 孤儿与自动清理', () => {
  it('孤儿 FTS 行在启动清理时被删除', async () => {
    const svc = KMSDatabaseService.getInstance()
    const db = svc.getDb()

    // 在 setImmediate 清理执行前插入一条 file_id 不存在的 FTS 行
    db.prepare("INSERT INTO kms_index_dirs (id, dir_path) VALUES ('d1','/x')").run()
    db.prepare("INSERT INTO kms_fts (title, content, file_id) VALUES ('t','orphan text','gone')").run()
    expect(db.prepare("SELECT COUNT(*) AS c FROM kms_fts").get().c).toBe(1)

    await flushImmediate()
    expect(db.prepare("SELECT COUNT(*) AS c FROM kms_fts").get().c).toBe(0)
  })
})

describe('KMSDatabaseService / 公开方法', () => {
  it('checkpoint 返回统计结构', async () => {
    const svc = KMSDatabaseService.getInstance()
    await flushImmediate()
    const r = svc.checkpoint('PASSIVE')
    expect(r).toEqual({ wal_pages: 0, wal_frames: 0, checkpointed: 0 })
  })

  it('runInTransaction：回调在事务内执行并返回结果', async () => {
    const svc = KMSDatabaseService.getInstance()
    await flushImmediate()
    const r = svc.runInTransaction(() => {
      svc.getDb().prepare("INSERT INTO kms_index_dirs (id, dir_path) VALUES ('a','/a')").run()
      return 42
    })
    expect(r).toBe(42)
    expect(svc.getDb().prepare("SELECT COUNT(*) AS c FROM kms_index_dirs").get().c).toBe(1)
  })

  it('getDatabaseStats：库大小与孤儿计数', async () => {
    const svc = KMSDatabaseService.getInstance()
    await flushImmediate()
    const stats = svc.getDatabaseStats()
    expect(stats.mainDbSize).toBeGreaterThan(0)
    expect(stats.vectorDbSize).toBeGreaterThan(0)
    expect(stats.orphanedFtsCount).toBe(0)
  })

  it('optimizeFts5Index：rebuild 不抛错', async () => {
    const svc = KMSDatabaseService.getInstance()
    await flushImmediate()
    expect(() => svc.optimizeFts5Index('rebuild')).not.toThrow()
  })

  it('cleanupDatabase：全流程不抛错并返回汇总', async () => {
    const svc = KMSDatabaseService.getInstance()
    await flushImmediate()
    const r = svc.cleanupDatabase()
    expect(r.cleanedFts).toBe(0)
    expect(r.after.mainDbSize).toBeGreaterThan(0)
  })
})
