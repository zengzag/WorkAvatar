/**
 * 附件服务单测（electron 经 Module._load 拦截打桩，database.service 打桩为内存 DB）：
 * - saveDataUrl 落盘 + hash 去重 + 引用格式
 * - resolve 读写回环 / 文件丢失返回 null（不抛异常）
 * - collectAttachmentRefs 深度遍历收集引用
 * - replaceDataUrlsWithRefs 嵌套结构替换，非法数据 URL 不动
 * - pruneRefs：无引用删除、DB 引用保留、本会话新落盘保护
 * - migrateExistingDataUrls：存量 base64 迁移为引用
 * - 非法输入（非图片 data URL / 超限 / 乱数据）安全返回 null
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import Module from 'module'

const mockState = vi.hoisted(() => ({
  userDataDir: '',
  documentsDir: '',
  packaged: true,
  rows: new Map<string, string>(),
  settings: new Map<string, string>(),
}))

const origModuleLoad = (Module as any)._load

function installElectronStub(): void {
  ;(Module as any)._load = function (this: any, request: string, parent: any, isMain: boolean) {
    if (request === 'electron') {
      return {
        app: {
          isPackaged: mockState.packaged,
          getPath: (name: string) =>
            name === 'documents' ? mockState.documentsDir : mockState.userDataDir,
        },
      }
    }
    return origModuleLoad.call(this, request, parent, isMain)
  }
}

// database.service 直接打桩为内存 DB（避免真实 better-sqlite3 初始化）
vi.mock('../../../electron/main/services/database.service', () => ({
  default: {
    getInstance: () => ({ getDb: () => (globalThis as any).__fakeDb }),
  },
}))

/** 极简 sqlite 打桩：按 SQL 关键字路由到内存 Map */
const fakeDb = {
  prepare(sql: string) {
    if (sql.includes('settings WHERE key = ?') && sql.startsWith('SELECT')) {
      return {
        get: (key: string) => {
          const value = mockState.settings.get(key)
          return value === undefined ? undefined : { value }
        },
      }
    }
    if (sql.startsWith('INSERT INTO settings')) {
      return {
        run: (key: string, value: string) => {
          mockState.settings.set(key, value)
          return { changes: 1 }
        },
      }
    }
    if (sql.includes('LIKE')) {
      const isMigrate = sql.includes("LIKE '%data:image/%'")
      return {
        all: () => {
          const rows: Array<{ id: string; messages_json: string }> = []
          for (const [id, json] of mockState.rows) {
            const hit = isMigrate ? json.includes('data:image/') : json.includes('wa-attachment://')
            if (hit) rows.push({ id, messages_json: json })
          }
          return rows
        },
      }
    }
    if (sql.startsWith('UPDATE conversations')) {
      return {
        run: (json: string, id: string) => {
          mockState.rows.set(id, json)
          return { changes: 1 }
        },
      }
    }
    if (sql.includes('WHERE id = ?')) {
      return {
        get: (id: string) => {
          const json = mockState.rows.get(id)
          return json === undefined ? undefined : { id, messages_json: json }
        },
      }
    }
    throw new Error(`unexpected sql: ${sql}`)
  },
  transaction(fn: () => void) {
    return () => fn()
  },
}

const PNG_1PX = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
const PNG_1PX_BUF = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64')

type AttachmentServiceInstance = ReturnType<
  typeof import('../../../electron/main/services/attachment.service').default.getInstance
>

async function freshService(): Promise<AttachmentServiceInstance> {
  vi.resetModules()
  const mod = await import('../../../electron/main/services/attachment.service')
  return mod.default.getInstance()
}

let root = ''

beforeEach(() => {
  installElectronStub()
  mockState.rows.clear()
  mockState.settings.clear()
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-attachment-test-'))
  mockState.userDataDir = path.join(root, 'user-data')
  mockState.documentsDir = path.join(root, 'documents')
  mockState.packaged = true
  ;(globalThis as any).__fakeDb = fakeDb
})

describe('attachment.service', () => {
  it('saveDataUrl 落盘文件并以 wa-attachment 引用返回，重复保存 hash 去重', async () => {
    const service = await freshService()
    const ref = service.saveDataUrl(PNG_1PX)!
    expect(ref).toMatch(/^wa-attachment:\/\/local\/[a-f0-9]{64}\.png$/)

    const filePath = service.getFilePathFromRef(ref)!
    expect(fs.existsSync(filePath)).toBe(true)
    expect(fs.readFileSync(filePath).equals(PNG_1PX_BUF)).toBe(true)

    const ref2 = service.saveDataUrl(PNG_1PX)!
    expect(ref2).toBe(ref)
  })

  it('resolve 回环读取 base64 与 mime；文件丢失返回 null 不抛异常', async () => {
    const service = await freshService()
    const ref = service.saveDataUrl(PNG_1PX)!
    const resolved = service.resolve(ref)
    expect(resolved?.mimeType).toBe('image/png')
    expect(resolved?.base64).toBe(PNG_1PX_BUF.toString('base64'))

    const missing = service.resolve('wa-attachment://local/' + '0'.repeat(64) + '.png')
    expect(missing).toBeNull()
  })

  it('非法输入安全返回 null：非图片 data URL / 坏数据', async () => {
    const service = await freshService()
    expect(service.saveDataUrl('not-a-data-url')).toBeNull()
    expect(service.saveDataUrl('data:text/plain;base64,AAAA')).toBeNull()
    expect(service.saveDataUrl('data:image/png;base64,!!!!invalid')).toBeNull()
    expect(service.saveDataUrl('')).toBeNull()
  })

  it('collectAttachmentRefs 深度遍历所有层级的引用', async () => {
    const { collectAttachmentRefs } = await import('../../../electron/main/services/attachment.service')
    const msg = {
      images: ['wa-attachment://local/' + 'a'.repeat(64) + '.png'],
      segments: [{ toolResultImages: ['wa-attachment://local/' + 'b'.repeat(64) + '.jpg', 'data:image/png;base64,AAA'] }],
    }
    const refs = collectAttachmentRefs(msg)
    expect(refs.size).toBe(2)
    expect([...refs].some(r => r.includes('a'.repeat(64)))).toBe(true)
    expect([...refs].some(r => r.includes('b'.repeat(64)))).toBe(true)
  })

  it('replaceDataUrlsWithRefs 嵌套替换 data URL；非法内容原样保留', async () => {
    const service = await freshService()
    const { replaceDataUrlsWithRefs } = await import('../../../electron/main/services/attachment.service')
    const input = {
      images: [PNG_1PX],
      segments: [{ toolResultImages: ['data:image/png;base64,not-base64!'] }],
      keep: 'plain',
    }
    const { value, changed } = replaceDataUrlsWithRefs(input)
    expect(changed).toBe(true)
    expect(value.images[0]).toMatch(/^wa-attachment:\/\/local\//)
    // 非法 base64 未替换
    expect(value.segments[0].toolResultImages[0]).toBe('data:image/png;base64,not-base64!')
    expect(value.keep).toBe('plain')
    // 落盘后的 ref 可回环读取
    expect(service.resolve(value.images[0])).not.toBeNull()
  })

  it('pruneRefs：无引用删除、DB 引用保留、本会话新落盘不误删', async () => {
    const service = await freshService()
    // refA：会话中引用（mock DB）；refB：落盘的历史孤儿（非本会话落盘）→ 应删除；refC：本会话刚落盘 → 保护
    const refA = service.saveDataUrl(PNG_1PX)!
    const bufB = Buffer.from('image-B')
    const refB = `wa-attachment://local/${require('crypto').createHash('sha256').update(bufB).digest('hex')}.png`
    const filePathB = service.getFilePathFromRef(refB)!
    fs.mkdirSync(path.dirname(filePathB), { recursive: true })
    fs.writeFileSync(filePathB, bufB)
    const refC = service.saveDataUrl('data:image/png;base64,' + Buffer.from('image-C').toString('base64'))!
    mockState.rows.set('conv1', JSON.stringify({ images: [refA] }))

    expect(fs.existsSync(service.getFilePathFromRef(refA)!)).toBe(true)
    expect(fs.existsSync(service.getFilePathFromRef(refB)!)).toBe(true)
    expect(fs.existsSync(service.getFilePathFromRef(refC)!)).toBe(true)
    service.pruneRefs([refA, refB, refC])
    expect(fs.existsSync(service.getFilePathFromRef(refA)!)).toBe(true)   // DB 引用保留
    expect(fs.existsSync(service.getFilePathFromRef(refB)!)).toBe(false)  // 孤儿删除
    expect(fs.existsSync(service.getFilePathFromRef(refC)!)).toBe(true)   // 会话内新落盘保护
  })

  it('collectRefsForConversations 按 ID 收集会话消息中的引用', async () => {
    const service = await freshService()
    const ref = service.saveDataUrl(PNG_1PX)!
    mockState.rows.set('conv1', JSON.stringify({ images: [ref] }))
    const refs = service.collectRefsForConversations(['conv1', 'conv-missing'])
    expect(refs).toContain(ref)
  })

  it('migrateExistingDataUrls 把存量 base64 迁移为引用并回写 DB，完成后置位标记（WA-COMPAT）', async () => {
    await freshService()
    const { replaceDataUrlsWithRefs } = await import('../../../electron/main/services/attachment.service')
    mockState.rows.set('conv-m1', JSON.stringify([{ role: 'user', content: '看图', images: [PNG_1PX] }]))
    const service = await freshService()
    service.migrateExistingDataUrls()
    const migrated = JSON.parse(mockState.rows.get('conv-m1')!)
    expect(migrated[0].images[0]).toMatch(/^wa-attachment:\/\/local\/[a-f0-9]{64}\.png$/)
    expect(replaceDataUrlsWithRefs({ x: 'wa-attachment://local/' + 'a'.repeat(64) + '.png' }).changed).toBe(false)
    // 迁移成功后一次性完成标记置位，后续启动不再重复扫描
    expect(mockState.settings.get('attachment_legacy_base64_migrated')).toBe('1')
    // 无存量数据的全新库迁移时同样置位标记
    mockState.settings.clear()
    const service2 = await freshService()
    mockState.rows.clear()
    service2.migrateExistingDataUrls()
    expect(mockState.settings.get('attachment_legacy_base64_migrated')).toBe('1')
  })
})
