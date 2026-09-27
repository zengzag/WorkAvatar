/**
 * KMSService（外观）真实实例化测试：
 * 索引目录 CRUD、目录删除（空目录/合集迁移/非合集移除）、合集 CRUD、
 * 合集文件添加/移除与游离文件清理、文件名搜索、合集统计与摘要搜索。
 * 重型子服务（索引管理器/Worker 客户端/目录监听）做边界 mock。
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

// ── 重型子服务边界 mock ──
vi.mock('../../../electron/main/services/kms/kms-index-manager.service', () => ({
  default: { getInstance: () => ({ setAutoIndexProgressCallback: vi.fn() }) },
}))
vi.mock('../../../electron/main/services/kms/kms-index-worker-client.service', () => ({
  default: {
    getInstance: () => ({
      setProgressCallback: vi.fn(),
      // runTask 不执行降级回调（回调内的 indexManager 是 mock）
      runTask: vi.fn(async () => undefined),
    }),
  },
}))
vi.mock('../../../electron/main/services/kms/kms-search-dir-watcher.service', () => ({
  default: {
    getInstance: () => ({ setRescanCallback: vi.fn(), watchDir: vi.fn(), unwatchDir: vi.fn() }),
  },
}))
vi.mock('../../../electron/main/services/kms/kms-keyword-stats.service', () => ({
  default: { getInstance: () => ({ incrementKeywordStat: vi.fn() }) },
}))
vi.mock('../../../electron/main/services/kms/kms-knowledge-card.service', () => ({
  default: { getInstance: () => ({ evaluateCards: vi.fn(async () => {}) }) },
}))

import { DatabaseSync } from 'node:sqlite'
import KMSDatabaseService from '../../../electron/main/services/kms/kms-database.service'
import KMSSearchEngineService from '../../../electron/main/services/kms/kms-search-engine.service'
import KMSService from '../../../electron/main/services/kms/kms.service'

let kms: KMSService
let mainDb: any
let docsDir: string

beforeEach(async () => {
  state.root = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-kms-'))
  docsDir = fs.mkdtempSync(path.join(state.root, 'docs'))
  ;(KMSDatabaseService as any).instance = undefined
  ;(KMSSearchEngineService as any).instance = undefined
  ;(KMSService as any).instance = undefined

  KMSDatabaseService.getInstance()
  await new Promise<void>(r => setImmediate(r))
  KMSSearchEngineService.getInstance()
  kms = KMSService.getInstance()
  mainDb = KMSDatabaseService.getInstance().getDb()
})

afterEach(() => {
  try { KMSDatabaseService.getInstance().close() } catch { /* closed */ }
  ;(KMSDatabaseService as any).instance = undefined
  ;(KMSSearchEngineService as any).instance = undefined
  ;(KMSService as any).instance = undefined
  fs.rmSync(state.root, { recursive: true, force: true })
})

describe('索引目录', () => {
  it('addIndexDir：目录不存在抛错', () => {
    expect(() => kms.addIndexDir('/no/such/dir')).toThrow('目录不存在')
  })

  it('addIndexDir：新增并可按 id 取回', () => {
    const dir = kms.addIndexDir(docsDir, '我的文档')
    expect(dir.dir_path).toBe(docsDir)
    expect(kms.getIndexDir(dir.id).display_name).toBe('我的文档')
  })

  it('重复添加相同路径：更新而非新增', () => {
    const first = kms.addIndexDir(docsDir)
    const again = kms.addIndexDir(docsDir, '新名字')
    expect(again.id).toBe(first.id)
    expect(kms.listIndexDirs()).toHaveLength(1)
  })

  it('updateIndexDir：更新启用状态', () => {
    const dir = kms.addIndexDir(docsDir)
    kms.updateIndexDir(dir.id, { enabled: false })
    expect(kms.getIndexDir(dir.id).enabled).toBe(0)
  })

  it('listIndexDirs 排除手动文件源虚拟目录', () => {
    kms.addIndexDir(docsDir)
    const dirs = kms.listIndexDirs()
    expect(dirs).toHaveLength(1)
    expect(dirs[0].dir_path).not.toBe('__manual_files__')
  })

  it('deleteIndexDir：空目录直接删除目录记录', () => {
    const dir = kms.addIndexDir(docsDir)
    const r = kms.deleteIndexDir(dir.id)
    expect(r).toEqual({ migrated: 0, removed: 0 })
    expect(kms.getIndexDir(dir.id)).toBeUndefined()
  })
})

describe('deleteIndexDir / 文件分类', () => {
  function seedFileInDir(id: string): string {
    const fp = path.join(docsDir, id + '.txt')
    fs.writeFileSync(fp, '内容-' + id)
    return fp
  }

  it('非合集文件被移除记录', async () => {
    const dir = kms.addIndexDir(docsDir)
    const fp = seedFileInDir('f1')
    // 通过 crawler 注册文件：直接借助 addIndexDir 后手工 insert 更可控
    mainDb.prepare(`
      INSERT INTO kms_files (id, dir_id, file_path, file_name, file_hash)
      VALUES ('file1', ?, ?, 'f1.txt', 'h1')
    `).run(dir.id, fp)

    const r = kms.deleteIndexDir(dir.id)
    expect(r.removed).toBe(1)
    expect(mainDb.prepare("SELECT COUNT(*) AS c FROM kms_files").get().c).toBe(0)
  })

  it('属于合集的文件迁移到手动目录', async () => {
    const dir = kms.addIndexDir(docsDir)
    const fp = seedFileInDir('f2')
    mainDb.prepare(`
      INSERT INTO kms_files (id, dir_id, file_path, file_name, file_hash)
      VALUES ('file2', ?, ?, 'f2.txt', 'h2')
    `).run(dir.id, fp)
    const coll = kms.createCollection('合集')
    mainDb.prepare("INSERT INTO kms_file_collections (file_id, collection_id) VALUES ('file2', ?)").run(coll.id)

    const r = kms.deleteIndexDir(dir.id)
    expect(r.migrated).toBe(1)
    const moved = mainDb.prepare("SELECT dir_id FROM kms_files WHERE id='file2'").get()
    const manual = mainDb.prepare("SELECT id FROM kms_index_dirs WHERE dir_path='__manual_files__'").get()
    expect(moved.dir_id).toBe(manual.id)
  })
})

describe('合集', () => {
  it('create / get / list / update', () => {
    const c = kms.createCollection('合集1', '描述')
    expect(kms.getCollection(c.id)).toMatchObject({ name: '合集1', file_count: 0 })
    expect(kms.listCollections()).toHaveLength(1)

    kms.updateCollection(c.id, { name: '改名' })
    expect(kms.getCollection(c.id).name).toBe('改名')
  })

  it('deleteCollection 不存在也不抛错', () => {
    expect(() => kms.deleteCollection('x')).not.toThrow()
  })

  it('addFileToCollection：新文件注册并关联，changed=true', async () => {
    const fp = path.join(docsDir, '新文件.txt')
    fs.writeFileSync(fp, '文件内容')
    const c = kms.createCollection('合集')

    const r = await kms.addFileToCollection(c.id, fp)
    expect(r.fileId).toBeTruthy()
    expect(r.changed).toBe(true)

    expect(kms.listFilesInCollection(c.id)).toHaveLength(1)
    expect(kms.getCollectionStats(c.id).fileCount).toBe(1)
  })

  it('重复添加同一文件：reused=true，合集内不重复', async () => {
    const fp = path.join(docsDir, '文件.txt')
    fs.writeFileSync(fp, '内容')
    const c = kms.createCollection('合集')

    await kms.addFileToCollection(c.id, fp)
    const r = await kms.addFileToCollection(c.id, fp)
    expect(r.reused).toBe(true)
    expect(kms.listFilesInCollection(c.id)).toHaveLength(1)
  })

  it('临时锁文件被拒绝', async () => {
    const fp = path.join(docsDir, '~$temp.docx')
    fs.writeFileSync(fp, 'x')
    const c = kms.createCollection('合集')
    await expect(kms.addFileToCollection(c.id, fp)).rejects.toThrow('临时文件')
  })

  it('removeFileFromCollection：手动目录文件变游离后清理', async () => {
    const fp = path.join(docsDir, '文件.txt')
    fs.writeFileSync(fp, '内容')
    const c = kms.createCollection('合集')
    const r = await kms.addFileToCollection(c.id, fp)

    kms.removeFileFromCollection(c.id, r.fileId)
    expect(kms.listFilesInCollection(c.id)).toHaveLength(0)
    // 文件位于手动目录且不属于任何合集 → 已清理
    expect(mainDb.prepare("SELECT COUNT(*) AS c FROM kms_files WHERE id=?", ).get(r.fileId).c).toBe(0)
  })
})

describe('搜索', () => {
  it('searchFiles：按文件名命中索引目录文件', () => {
    const dir = kms.addIndexDir(docsDir)
    const fp = path.join(docsDir, '季度报告.docx')
    fs.writeFileSync(fp, '内容')
    mainDb.prepare(`
      INSERT INTO kms_files (id, dir_id, file_path, file_name, file_hash)
      VALUES ('f1', ?, ?, '季度报告.docx', 'h1')
    `).run(dir.id, fp)

    const results = kms.searchFiles('季度', { topK: 50 })
    expect(results).toHaveLength(1)
    expect(results[0].file_id).toBe('f1')
    expect(kms.searchFiles('zzz', { topK: 50 })).toEqual([])
  })

  it('searchCollectionSummaries：无摘要返回空', () => {
    expect(kms.searchCollectionSummaries('query')).toEqual([])
  })
})
