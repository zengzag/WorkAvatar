/**
 * KMSStopWordsService 真实实例化测试（node:sqlite 内存库，FTS5 MATCH 真实执行）：
 * CRUD、分页钳制、IDF 自动判定（文档不足/零命中/低 IDF/高 IDF）、auto 清理。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import type { DatabaseSync as DbType } from 'node:sqlite'

function createDb(): DbType {
  const db = new DatabaseSync(':memory:')
  db.exec(`
    CREATE TABLE kms_stop_words (
      id TEXT PRIMARY KEY,
      word TEXT UNIQUE,
      source TEXT NOT NULL DEFAULT 'manual',
      created_at INTEGER NOT NULL DEFAULT (unixepoch())
    );
    CREATE TABLE kms_files (id TEXT PRIMARY KEY, index_status TEXT);
    CREATE VIRTUAL TABLE kms_fts USING fts5(content);
  `)
  const anyDb = db as unknown as {
    transaction<T extends (...args: any[]) => any>(fn: T): (...args: Parameters<T>) => ReturnType<T>
  }
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
  return db
}

vi.mock('../../../electron/main/services/kms/kms-database.service', () => ({
  default: { getInstance: () => ({ getDb: () => currentDb }) }
}))

let currentDb: DbType

import KMSStopWordsService from '../../../electron/main/services/kms/kms-stop-words.service'

beforeEach(() => {
  currentDb = createDb()
  ;(KMSStopWordsService as any).instance = undefined
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('KMSStopWordsService / CRUD', () => {
  it('初始无停用词；添加后 isStopWord 生效', () => {
    const svc = KMSStopWordsService.getInstance()
    expect(svc.isStopWord('的')).toBe(false)

    expect(svc.addStopWord('的')).toEqual({ success: true })
    expect(svc.isStopWord('的')).toBe(true)
  })

  it('空词/纯空白返回错误；重复词 INSERT OR IGNORE 仍成功但不新增', () => {
    const svc = KMSStopWordsService.getInstance()
    expect(svc.addStopWord('   ').success).toBe(false)
    svc.addStopWord('hello')
    expect(svc.addStopWord('hello')).toEqual({ success: true })

    const { total } = svc.listStopWords()
    expect(total).toBe(1)
  })

  it('批量添加跳过空白、统计实际新增', () => {
    const svc = KMSStopWordsService.getInstance()
    const result = svc.addStopWords(['a', ' ', 'b', 'a'])
    expect(result.added).toBe(2)
    expect(svc.listStopWords().total).toBe(2)
  })

  it('listStopWords：source 过滤与 total 一致', () => {
    const svc = KMSStopWordsService.getInstance()
    svc.addStopWord('m')
    svc.addStopWords(['x'], 'auto_idf')

    const manual = svc.listStopWords({ source: 'manual' })
    expect(manual.total).toBe(1)
    expect(manual.words[0].word).toBe('m')

    const auto = svc.listStopWords({ source: 'auto_idf' })
    expect(auto.total).toBe(1)
  })

  it('listStopWords：limit/offset 钳制到合法范围', () => {
    const svc = KMSStopWordsService.getInstance()
    svc.addStopWords(['w1', 'w2', 'w3'])

    // limit=0 被 || 100 兜底
    expect(svc.listStopWords({ limit: 0 }).words).toHaveLength(3)
    const paged = svc.listStopWords({ limit: 2, offset: 1 })
    expect(paged.words).toHaveLength(2)
    expect(paged.total).toBe(3)
    expect(svc.listStopWords({ limit: 999 }).words).toHaveLength(3) // 上限 500 但总数 3
  })

  it('deleteStopWord 按 id 删除；deleteStopWordByWord 按词删除', () => {
    const svc = KMSStopWordsService.getInstance()
    svc.addStopWords(['d1', 'd2'])
    const row = svc.listStopWords().words.find(w => w.word === 'd1')

    svc.deleteStopWord(row.id)
    expect(svc.isStopWord('d1')).toBe(false)

    svc.deleteStopWordByWord('d2')
    expect(svc.isStopWord('d2')).toBe(false)
    expect(svc.listStopWords().total).toBe(0)
  })

  it('clearAutoStopWords 仅删除 auto_idf 并返回删除数', () => {
    const svc = KMSStopWordsService.getInstance()
    svc.addStopWord('manual-word')
    svc.addStopWords(['auto-word'], 'auto_idf')

    expect(svc.clearAutoStopWords()).toBe(1)
    expect(svc.listStopWords().total).toBe(1)
  })
})

describe('KMSStopWordsService / evaluateIdfAndCache', () => {
  it('已在停用词表：返回 stop_word', () => {
    const svc = KMSStopWordsService.getInstance()
    svc.addStopWord('common')
    expect(svc.evaluateIdfAndCache('common')).toEqual({ shouldFilter: true, reason: 'stop_word' })
  })

  it('文档总数不足 50：不过滤', () => {
    const svc = KMSStopWordsService.getInstance()
    expect(svc.evaluateIdfAndCache('anything')).toEqual({ shouldFilter: false })
  })

  it('文档充足但零命中：不过滤', () => {
    for (let i = 0; i < 60; i++) {
      currentDb.prepare("INSERT INTO kms_files (id, index_status) VALUES (?, 'completed')").run('f' + i)
    }
    const svc = KMSStopWordsService.getInstance()
    expect(svc.evaluateIdfAndCache('不存在')).toEqual({ shouldFilter: false })
  })

  it('高频词低 IDF：自动加入停用词并返回 low_idf', () => {
    for (let i = 0; i < 60; i++) {
      currentDb.prepare("INSERT INTO kms_files (id, index_status) VALUES (?, 'completed')").run('f' + i)
    }
    const insFts = currentDb.prepare('INSERT INTO kms_fts (content) VALUES (?)')
    for (let i = 0; i < 50; i++) insFts.run('common text')

    const svc = KMSStopWordsService.getInstance()
    const result = svc.evaluateIdfAndCache('common')
    expect(result.shouldFilter).toBe(true)
    expect(result.reason).toBe('low_idf')
    expect(svc.isStopWord('common')).toBe(true)
    expect(svc.listStopWords({ source: 'auto_idf' }).total).toBe(1)
  })

  it('低频词高 IDF：不过滤', () => {
    for (let i = 0; i < 60; i++) {
      currentDb.prepare("INSERT INTO kms_files (id, index_status) VALUES (?, 'completed')").run('f' + i)
    }
    currentDb.prepare('INSERT INTO kms_fts (content) VALUES (?)').run('rare')

    const svc = KMSStopWordsService.getInstance()
    expect(svc.evaluateIdfAndCache('rare')).toEqual({ shouldFilter: false })
    expect(svc.isStopWord('rare')).toBe(false)
  })
})
