/**
 * 会话消息行存储单测（node:sqlite 内存库）。
 *
 * 覆盖：旧 messages_json 懒迁移、按 seq 分页与滚动补载、单条 append/upsert、
 * 全量替换时还原被外置的委托子过程、产物聚合、裁剪最近 N 条。
 */
import { describe, it, expect, afterEach, vi } from 'vitest'
import { DatabaseSync } from 'node:sqlite'

const dbState = vi.hoisted(() => ({ db: null as any }))

vi.mock('../../../electron/main/services/database.service', () => ({
  default: { getInstance: () => ({ getDb: () => dbState.db }) },
}))

type Message = Record<string, any>

const CREATE_SCHEMA = `
  CREATE TABLE conversations (
    id TEXT PRIMARY KEY,
    messages_json TEXT NOT NULL DEFAULT '[]',
    message_count INTEGER NOT NULL DEFAULT 0,
    messages_migrated INTEGER NOT NULL DEFAULT 0,
    updated_at INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE conversation_messages (
    conversation_id TEXT NOT NULL,
    message_id TEXT NOT NULL,
    seq INTEGER NOT NULL,
    data_json TEXT NOT NULL,
    artifacts_json TEXT NOT NULL DEFAULT '[]',
    updated_at INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (conversation_id, message_id)
  );
`

function adapt(db: DatabaseSync) {
  const anyDb = db as any
  anyDb.transaction = (fn: (...args: any[]) => any) => (...args: any[]) => {
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

/** 每个用例独立的内存库 + 全新 store 单例，避免 migrated 标记串场 */
async function setup() {
  const db = adapt(new DatabaseSync(':memory:'))
  db.exec(CREATE_SCHEMA)
  dbState.db = db
  vi.resetModules()
  const mod = await import('../../../electron/main/services/conversation-message-store.service')
  return { db, store: mod.default.getInstance(), extractMessageArtifacts: mod.extractMessageArtifacts }
}

const insertLegacy = (db: DatabaseSync, id: string, messages: Message[]) => {
  db.prepare('INSERT INTO conversations (id, messages_json, message_count) VALUES (?, ?, ?)')
    .run(id, JSON.stringify(messages), messages.length)
}

const msg = (id: string, content: string, extra: Record<string, any> = {}): Message => ({
  id, role: 'user', content, ...extra,
})

let db: DatabaseSync

afterEach(() => {
  db?.close()
  dbState.db = null
})

describe('conversation-message-store / 迁移与读取', () => {
  it('首次访问把 messages_json 拆成行并清空旧字段', async () => {
    const ctx = await setup()
    db = ctx.db
    insertLegacy(db, 'c1', [msg('m1', 'a'), msg('m2', 'b')])

    const all = ctx.store.getAll('c1')
    expect(all.map(m => m.id)).toEqual(['m1', 'm2'])

    const conv = db.prepare('SELECT messages_migrated, messages_json, message_count FROM conversations WHERE id = ?')
      .get('c1') as any
    expect(conv.messages_migrated).toBe(1)
    expect(conv.messages_json).toBe('[]')
    expect(conv.message_count).toBe(2)

    const rows = db.prepare('SELECT message_id, seq FROM conversation_messages WHERE conversation_id = ? ORDER BY seq')
      .all('c1') as any[]
    expect(rows).toEqual([{ message_id: 'm1', seq: 0 }, { message_id: 'm2', seq: 1 }])
  })

  it('迁移时缺少 id 的消息按序号补 id，重复 id 自动去重', async () => {
    const ctx = await setup()
    db = ctx.db
    insertLegacy(db, 'c1', [{ role: 'user', content: 'a' }, msg('dup', 'b'), msg('dup', 'c')])
    ctx.store.getAll('c1')

    const rows = db.prepare('SELECT message_id FROM conversation_messages WHERE conversation_id = ? ORDER BY seq')
      .all('c1') as any[]
    expect(rows.map(r => r.message_id)).toEqual(['msg_legacy_0', 'dup', 'dup_2'])
  })

  it('getMessage 只读单条，缺失返回 null', async () => {
    const ctx = await setup()
    db = ctx.db
    insertLegacy(db, 'c1', [msg('m1', 'a'), msg('m2', 'b')])
    expect(ctx.store.getMessage('c1', 'm2')?.content).toBe('b')
    expect(ctx.store.getMessage('c1', 'missing')).toBeNull()
  })

  it('分页读取最近 N 条，并按 beforeSeq 向前补载', async () => {
    const ctx = await setup()
    db = ctx.db
    insertLegacy(db, 'c1', Array.from({ length: 10 }, (_, i) => msg(`m${i}`, `c${i}`)))

    const latest = ctx.store.getPage('c1', 4)
    expect(latest.messages.map(m => m.id)).toEqual(['m6', 'm7', 'm8', 'm9'])
    expect(latest.total).toBe(10)
    expect(latest.hasOlder).toBe(true)
    expect(latest.oldestSeq).toBe(6)

    const older = ctx.store.getPage('c1', 4, latest.oldestSeq!)
    expect(older.messages.map(m => m.id)).toEqual(['m2', 'm3', 'm4', 'm5'])
    expect(older.hasOlder).toBe(true)

    const first = ctx.store.getPage('c1', 4, older.oldestSeq!)
    expect(first.messages.map(m => m.id)).toEqual(['m0', 'm1'])
    expect(first.hasOlder).toBe(false)
  })
})

describe('conversation-message-store / 写入', () => {
  it('append 分配递增 seq，重复 id 转为更新不新增行', async () => {
    const ctx = await setup()
    db = ctx.db
    insertLegacy(db, 'c1', [msg('m1', 'a')])

    expect(ctx.store.append('c1', msg('m2', 'b'))).toBe(1)
    expect(ctx.store.append('c1', { ...msg('m2', 'b2'), segments: [] })).toBe(1)

    const all = ctx.store.getAll('c1')
    expect(all).toHaveLength(2)
    expect(all[1].content).toBe('b2')
    const conv = db.prepare('SELECT message_count FROM conversations WHERE id = ?').get('c1') as any
    expect(conv.message_count).toBe(2)
  })

  it('append 缺少 id 抛错', async () => {
    const ctx = await setup()
    db = ctx.db
    insertLegacy(db, 'c1', [])
    expect(() => ctx.store.append('c1', { role: 'user', content: 'x' })).toThrow('message.id')
  })

  it('upsert 更新单条并按原行还原被外置的委托子过程', async () => {
    const ctx = await setup()
    db = ctx.db
    insertLegacy(db, 'c1', [{
      id: 'm1',
      role: 'assistant',
      content: 'done',
      segments: [{ type: 'delegation', delegationStatus: 'completed', subSegments: [{ content: '子过程' }] }],
    }])
    ctx.store.getAll('c1')

    // 渲染层回写的是裁剪视图（无 subSegments）
    ctx.store.upsert('c1', {
      id: 'm1',
      role: 'assistant',
      content: 'done!',
      segments: [{
        type: 'delegation',
        delegationStatus: 'completed',
        subSegmentsOmitted: true,
        subSegmentCount: 1,
      }],
    })

    const saved = ctx.store.getMessage('c1', 'm1')
    expect(saved.content).toBe('done!')
    expect(saved.segments[0].subSegments).toEqual([{ content: '子过程' }])
  })

  it('replaceAll 重建行、清空 messages_json，并保留原委托子过程', async () => {
    const ctx = await setup()
    db = ctx.db
    insertLegacy(db, 'c1', [
      msg('m1', 'a'),
      {
        id: 'm2',
        role: 'assistant',
        segments: [{ type: 'delegation', delegationStatus: 'completed', subSegments: [{ content: 'x' }] }],
      },
    ])
    ctx.store.getAll('c1')

    ctx.store.replaceAll('c1', [
      msg('m1', 'a2'),
      {
        id: 'm2',
        role: 'assistant',
        segments: [{ type: 'delegation', delegationStatus: 'completed', subSegmentsOmitted: true }],
      },
      msg('m3', 'c'),
    ])

    const all = ctx.store.getAll('c1')
    expect(all.map(m => m.id)).toEqual(['m1', 'm2', 'm3'])
    expect(all[0].content).toBe('a2')
    expect(all[1].segments[0].subSegments).toEqual([{ content: 'x' }])
    const conv = db.prepare('SELECT messages_migrated, messages_json, message_count FROM conversations WHERE id = ?')
      .get('c1') as any
    expect(conv).toEqual({ messages_migrated: 1, messages_json: '[]', message_count: 3 })
  })

  it('replaceAll 对不存在的会话静默跳过', async () => {
    const ctx = await setup()
    db = ctx.db
    expect(() => ctx.store.replaceAll('missing', [msg('m1', 'a')])).not.toThrow()
  })

  it('trimToRecent 只保留最近 keep 条', async () => {
    const ctx = await setup()
    db = ctx.db
    insertLegacy(db, 'c1', Array.from({ length: 6 }, (_, i) => msg(`m${i}`, `c${i}`)))

    expect(ctx.store.trimToRecent('c1', 2)).toBe(2)
    expect(ctx.store.getAll('c1').map(m => m.id)).toEqual(['m4', 'm5'])
    expect(ctx.store.trimToRecent('c1', 5)).toBe(2)
  })
})

describe('conversation-message-store / 产物', () => {
  it('按消息从新到旧聚合，同路径保留最新', async () => {
    const ctx = await setup()
    db = ctx.db
    insertLegacy(db, 'c1', [
      { id: 'm1', role: 'assistant', segments: [{ generatedFiles: [{ path: 'a.md', size: 1 }, { path: 'b.md' }] }] },
      { id: 'm2', role: 'assistant', segments: [{ runResult: { generatedFiles: [{ path: 'a.md', size: 2 }], autoDetectedFiles: [{ path: 'c.md' }] } }] },
      { id: 'm3', role: 'user', content: 'hi' },
    ])

    expect(ctx.store.listArtifacts('c1')).toEqual([
      { path: 'a.md', size: 2 },
      { path: 'c.md' },
      { path: 'b.md' },
    ])
  })

  it('extractMessageArtifacts 忽略无 path 的条目', async () => {
    const ctx = await setup()
    db = ctx.db
    expect(ctx.extractMessageArtifacts({
      segments: [
        { generatedFiles: [{ path: 'a.md' }, { name: 'no-path' }] },
        { runResult: { autoDetectedFiles: [{ path: 'b.png' }] } },
      ],
    })).toEqual([{ path: 'a.md' }, { path: 'b.png' }])
  })
})
