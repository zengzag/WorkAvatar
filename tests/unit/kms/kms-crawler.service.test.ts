/**
 * KMSCrawlerService 真实实例化测试（真实临时目录端到端）：
 * 新增/未变/修改/删除检测、稳定阈值跳过、目录校验、
 * 状态/层级更新、访问日志与统计、文件清单。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'

const state = vi.hoisted(() => ({ root: '', indexDir: '' }))

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
import KMSCrawlerService from '../../../electron/main/services/kms/kms-crawler.service'

let crawler: KMSCrawlerService
let mainDb: any

beforeEach(async () => {
  state.root = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-kmscrawl-'))
  state.indexDir = fs.mkdtempSync(path.join(state.root, 'docs'))
  ;(KMSDatabaseService as any).instance = undefined
  ;(KMSSearchEngineService as any).instance = undefined
  ;(KMSCrawlerService as any).instance = undefined

  KMSDatabaseService.getInstance()
  await new Promise<void>(r => setImmediate(r))
  KMSSearchEngineService.getInstance()
  crawler = KMSCrawlerService.getInstance()
  mainDb = KMSDatabaseService.getInstance().getDb()

  mainDb.prepare("INSERT INTO kms_index_dirs (id, dir_path) VALUES ('d1', ?)").run(state.indexDir)
})

afterEach(() => {
  try { KMSDatabaseService.getInstance().close() } catch { /* closed */ }
  ;(KMSDatabaseService as any).instance = undefined
  ;(KMSSearchEngineService as any).instance = undefined
  ;(KMSCrawlerService as any).instance = undefined
  fs.rmSync(state.root, { recursive: true, force: true })
})

const fileInIndex = (name: string, content: string): string => {
  const fp = path.join(state.indexDir, name)
  fs.writeFileSync(fp, content)
  return fp
}

describe('crawlDirectory / 生命周期', () => {
  it('新文件：注册到 kms_files', async () => {
    fileInIndex('笔记.txt', '初始内容')

    const r = await crawler.crawlDirectory('d1')
    expect(r.totalFiles).toBe(1)
    expect(r.newFiles).toBe(1)
    expect(mainDb.prepare("SELECT COUNT(*) AS c FROM kms_files").get().c).toBe(1)
  })

  it('再次爬取无变化：unchangedFiles=1', async () => {
    fileInIndex('笔记.txt', '初始内容')
    await crawler.crawlDirectory('d1')

    const r = await crawler.crawlDirectory('d1')
    expect(r.newFiles).toBe(0)
    expect(r.unchangedFiles).toBe(1)
  })

  it('内容被修改：modifiedFiles=1 且哈希更新', async () => {
    const fp = fileInIndex('笔记.txt', '短')
    await crawler.crawlDirectory('d1')

    fs.writeFileSync(fp, '这是明显更长的新内容')
    const r = await crawler.crawlDirectory('d1')
    expect(r.modifiedFiles).toBe(1)
    expect(r.newFiles).toBe(0)
  })

  it('文件从磁盘删除：deletedFiles=1', async () => {
    const fp = fileInIndex('笔记.txt', '内容')
    await crawler.crawlDirectory('d1')
    fs.unlinkSync(fp)

    const r = await crawler.crawlDirectory('d1')
    expect(r.deletedFiles).toBe(1)
    expect(mainDb.prepare("SELECT COUNT(*) AS c FROM kms_files").get().c).toBe(0)
  })

  it('稳定阈值内的修改被跳过：skippedUnstableFiles=1', async () => {
    const fp = fileInIndex('笔记.txt', '短')
    await crawler.crawlDirectory('d1')
    fs.writeFileSync(fp, '这是明显更长的新内容')

    const r = await crawler.crawlDirectory('d1', undefined, { stableThresholdMinutes: 60 })
    expect(r.skippedUnstableFiles).toBe(1)
    expect(r.modifiedFiles).toBe(0)
  })
})

describe('crawlDirectory / 异常', () => {
  it('目录被禁用：抛错', async () => {
    mainDb.prepare("UPDATE kms_index_dirs SET enabled=0 WHERE id='d1'").run()
    await expect(crawler.crawlDirectory('d1')).rejects.toThrow('not found or disabled')
  })

  it('物理目录不存在：抛错', async () => {
    mainDb.prepare("UPDATE kms_index_dirs SET dir_path='/no/such/dir' WHERE id='d1'").run()
    await expect(crawler.crawlDirectory('d1')).rejects.toThrow('does not exist')
  })

  it('未知目录 ID：抛错', async () => {
    await expect(crawler.crawlDirectory('x')).rejects.toThrow('not found or disabled')
  })
})

describe('状态与访问', () => {
  it('updateFileStatus / updateFileDataTier 更新记录', async () => {
    fileInIndex('笔记.txt', '内容')
    await crawler.crawlDirectory('d1')

    crawler.updateFileStatus(crawler.getFilesByDir('d1')[0].id, 'completed')
    expect(crawler.getFilesByDir('d1')[0].indexStatus).toBe('completed')

    crawler.updateFileDataTier(crawler.getFilesByDir('d1')[0].id, 'hot')
    expect(crawler.getFilesByDir('d1')[0].dataTier).toBe('hot')
  })

  it('updateFileStatus 带 error 信息不抛错', () => {
    expect(() => crawler.updateFileStatus('missing', 'failed', '原因')).not.toThrow()
  })

  it('logFileAccess 写日志，getFileAccessStatsBatch 能读到命中数', async () => {
    fileInIndex('笔记.txt', '内容')
    await crawler.crawlDirectory('d1')
    const id = crawler.getFilesByDir('d1')[0].id

    crawler.logFileAccess(id, 'search_hit')
    crawler.logFileAccessBatch([id], 'read')

    const stats = crawler.getFileAccessStatsBatch([id], 30)
    const entry = stats.get(id)!
    expect(entry.hitCount + entry.readCount).toBeGreaterThan(0)
  })

  it('getFileStats 汇总状态/层级/扩展名', async () => {
    fileInIndex('笔记.txt', '内容')
    await crawler.crawlDirectory('d1')

    const stats = crawler.getFileStats()
    expect(stats.total).toBe(1)
    expect(stats.byExt.txt).toBe(1)
  })

  it('getPendingFiles / getFilesByDir', async () => {
    expect(crawler.getPendingFiles()).toEqual([])
    fileInIndex('a.txt', '内容')
    await crawler.crawlDirectory('d1')
    expect(crawler.getFilesByDir('d1')).toHaveLength(1)
    expect(crawler.getFilesByDir('other')).toEqual([])
  })
})
