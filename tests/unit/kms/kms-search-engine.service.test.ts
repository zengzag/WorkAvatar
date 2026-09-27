/**
 * KMSSearchEngineService 真实实例化测试：
 * 标题/摘要索引（search_index + FTS）、FTS 检索、文件名检索、索引删除、
 * 向量存储与 JS 全扫描余弦检索（sqlite-vec 未加载时的 fallback 路径）、统计、search 分发。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'

const state = vi.hoisted(() => ({ root: '' }))

function openDb(dbPath: string): any {
  const db = new DatabaseSync(dbPath)
  db.pragma = (s: string) => {
    if (s.startsWith('wal_checkpoint')) return [{ busy: 0, log: 0, checkpointed: 0 }]
    db.exec('PRAGMA ' + s)
  }
  db.loadExtension = vi.fn()
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

import { DatabaseSync } from 'node:sqlite'
import KMSDatabaseService from '../../../electron/main/services/kms/kms-database.service'
import KMSSearchEngineService from '../../../electron/main/services/kms/kms-search-engine.service'

let mainDb: any
let engine: KMSSearchEngineService

beforeEach(async () => {
  state.root = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-kmsengine-'))
  ;(KMSDatabaseService as any).instance = undefined
  ;(KMSSearchEngineService as any).instance = undefined

  KMSDatabaseService.getInstance()
  await new Promise<void>(r => setImmediate(r)) // 构造函数安排的孤儿清理
  engine = KMSSearchEngineService.getInstance()
  mainDb = KMSDatabaseService.getInstance().getDb()

  mainDb.prepare("INSERT INTO kms_index_dirs (id, dir_path) VALUES ('d1', '/dir')").run()
})

afterEach(() => {
  try { KMSDatabaseService.getInstance().close() } catch { /* closed */ }
  ;(KMSDatabaseService as any).instance = undefined
  ;(KMSSearchEngineService as any).instance = undefined
  fs.rmSync(state.root, { recursive: true, force: true })
})

function seedFile(id: string, fileName: string): void {
  mainDb.prepare(`
    INSERT INTO kms_files (id, dir_id, file_path, file_name, file_hash)
    VALUES (?, 'd1', ?, ?, ?)
  `).run(id, path.join('/dir', fileName), fileName, 'hash-' + id)
}

describe('索引写入', () => {
  it('indexFileTitle：新增 search_index 与 FTS；重复调用走更新', () => {
    seedFile('f1', '报告.docx')
    engine.indexFileTitle('f1', '报告.docx', '/dir/报告.docx')

    expect(mainDb.prepare("SELECT COUNT(*) AS c FROM kms_search_index").get().c).toBe(1)
    expect(mainDb.prepare("SELECT COUNT(*) AS c FROM kms_fts").get().c).toBe(1)

    engine.indexFileTitle('f1', '报告.docx', '/dir/报告.docx')
    expect(mainDb.prepare("SELECT COUNT(*) AS c FROM kms_search_index").get().c).toBe(1)
    expect(mainDb.prepare("SELECT COUNT(*) AS c FROM kms_fts").get().c).toBe(1)
  })

  it('indexFileSummary：新增摘要索引', () => {
    seedFile('f1', 'f.docx')
    engine.indexFileSummary('f1', '这是摘要内容', ['关键词'])
    expect(mainDb.prepare("SELECT COUNT(*) AS c FROM kms_search_index WHERE source_type='file_summary'").get().c).toBe(1)
  })
})

describe('检索', () => {
  it('ftsSearch：索引后中文关键词命中', () => {
    seedFile('f1', '报告.docx')
    engine.indexFileTitle('f1', '报告.docx', '/dir/报告.docx')

    const results = engine.ftsSearch('报告')
    expect(results).toHaveLength(1)
    expect(results[0].file_id).toBe('f1')
    expect(results[0].file_name).toBe('报告.docx')
  })

  it('ftsSearch：无关键词返回空数组', () => {
    expect(engine.ftsSearch('')).toEqual([])
  })

  it('fileNameSearch：按文件名 LIKE 命中', () => {
    seedFile('f1', '季度报告.docx')
    seedFile('f2', '其它.docx')

    const results = engine.fileNameSearch('季度', { topK: 10 })
    expect(results).toHaveLength(1)
    expect(results[0].file_id).toBe('f1')
    expect(results[0].match_type).toBe('file_name')
  })

  it('fileNameSearch：无命中返回空', () => {
    seedFile('f1', 'a.docx')
    expect(engine.fileNameSearch('zzz', { topK: 10 })).toEqual([])
  })

  it('search：无 queryEmbedding 时走 ftsSearch', () => {
    seedFile('f1', '报告.docx')
    engine.indexFileTitle('f1', '报告.docx', '/dir/报告.docx')
    expect(engine.search('报告')).toHaveLength(1)
  })
})

describe('删除', () => {
  it('deleteIndexByFile：清理 search_index 与 FTS', () => {
    seedFile('f1', '报告.docx')
    engine.indexFileTitle('f1', '报告.docx', '/dir/报告.docx')

    engine.deleteIndexByFile('f1')
    expect(mainDb.prepare("SELECT COUNT(*) AS c FROM kms_search_index").get().c).toBe(0)
    expect(mainDb.prepare("SELECT COUNT(*) AS c FROM kms_fts").get().c).toBe(0)
  })
})

describe('向量', () => {
  it('storeEmbedding：写入向量库；同源重复走更新', () => {
    seedFile('f1', 'f.docx')
    engine.storeEmbedding('file_title', 'f1', 'f1', new Float32Array([1, 0]), 'test-model')

    const vectorDb = KMSDatabaseService.getInstance().getVectorDb()
    expect(vectorDb.prepare("SELECT COUNT(*) AS c FROM kms_embeddings").get().c).toBe(1)

    engine.storeEmbedding('file_title', 'f1', 'f1', new Float32Array([0, 1]), 'test-model')
    expect(vectorDb.prepare("SELECT COUNT(*) AS c FROM kms_embeddings").get().c).toBe(1)
  })

  it('vectorSearch：sqlite-vec 未就绪时 JS 全扫描，相同向量余弦≈1', () => {
    seedFile('f1', 'f.docx')
    engine.storeEmbedding('file_title', 'f1', 'f1', new Float32Array([1, 0]), 'm')

    const results = engine.vectorSearch(new Float32Array([1, 0]), { topK: 5 })
    expect(results).toHaveLength(1)
    expect(results[0]).toMatchObject({ sourceType: 'file_title', fileId: 'f1' })
    expect(results[0].score).toBeCloseTo(1, 5)
  })

  it('vectorSearch：库为空返回空', () => {
    expect(engine.vectorSearch(new Float32Array([1, 0]), { topK: 5 })).toEqual([])
  })
})

describe('统计', () => {
  it('getIndexStats：条目数与类型分组', () => {
    seedFile('f1', 'f.docx')
    engine.indexFileTitle('f1', 'f.docx', '/dir/f.docx')

    const stats = engine.getIndexStats()
    expect(stats.totalEntries).toBe(1)
    expect(stats.byType.file_title).toBe(1)
    expect(stats.embeddingCount).toBe(0)
  })
})
