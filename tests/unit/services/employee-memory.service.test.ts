/**
 * EmployeeMemoryService 真实实例化测试：
 * revision、CRUD + FTS 同步、软删除/回收站、置顶/touch、检索（置顶前置/BM25/touch）、
 * 统计/整理判定、对话提取落库、整理（删除/合并/精简）、自动整理冷却、过期清理。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import type { DatabaseSync as DbType } from 'node:sqlite'

function createDb(): DbType {
  const db = new DatabaseSync(':memory:')
  db.exec(`
    CREATE TABLE employee_memories (
      id TEXT PRIMARY KEY, employee_id TEXT, scope TEXT NOT NULL DEFAULT 'employee',
      key TEXT, topic TEXT, content TEXT, is_pinned INTEGER DEFAULT 0,
      source TEXT DEFAULT 'manual', importance TEXT DEFAULT 'normal',
      last_referenced_at INTEGER, deleted_at INTEGER,
      created_at INTEGER, updated_at INTEGER
    );
    CREATE VIRTUAL table employee_memories_fts USING fts5(
      key, topic, content, memory_id UNINDEXED, employee_id UNINDEXED, tokenize='unicode61'
    );
    CREATE TABLE conversations (id TEXT PRIMARY KEY, summary TEXT, updated_at INTEGER);
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

const dbState = vi.hoisted(() => ({ db: null as any }))

vi.mock('../../../electron/main/services/database.service', () => ({
  default: { getInstance: () => ({ getDb: () => dbState.db }) },
}))

const llmState = vi.hoisted(() => ({ output: '' }))
vi.mock('../../../electron/main/services/agent/llm/pi-provider-factory', () => ({
  createPiProvider: vi.fn(async () => ({
    chat: vi.fn(async () => ({ content: llmState.output })),
  })),
}))

import EmployeeMemoryService from '../../../electron/main/services/employee-memory.service'

beforeEach(() => {
  dbState.db = createDb()
  ;(EmployeeMemoryService as any).instance = undefined
})

afterEach(() => vi.restoreAllMocks())

const base = (over: Record<string, any> = {}) => ({
  employee_id: 'e1',
  key: 'k',
  topic: 't',
  content: 'content text',
  ...over,
})

describe('revision / create', () => {
  it('初始 revision=0；createMemory 后递增', () => {
    const svc = EmployeeMemoryService.getInstance()
    expect(svc.getRevision()).toBe(0)
    svc.createMemory(base())
    expect(svc.getRevision()).toBe(1)
  })

  it('员工作用域：employee_id 落库且 FTS 同步', () => {
    const created = EmployeeMemoryService.getInstance().createMemory(
      base({ key: 'style', content: 'concise style guide' })
    )
    expect(created.scope).toBe('employee')
    expect(created.employee_id).toBe('e1')

    const ftsRow = dbState.db.prepare('SELECT memory_id FROM employee_memories_fts').get()
    expect(ftsRow.memory_id).toBe(created.id)
  })

  it('全局作用域：employee_id 为 null', () => {
    const created = EmployeeMemoryService.getInstance().createMemory(
      base({ scope: 'global' })
    )
    expect(created.employee_id).toBeNull()
    expect(created.scope).toBe('global')
  })

  it('超长 content 在标点处截断（>80 位置有句号）', () => {
    const text = 'a'.repeat(100) + '。' + 'b'.repeat(80)
    const created = EmployeeMemoryService.getInstance().createMemory(base({ content: text }))
    expect(created.content.length).toBe(100)
  })

  it('超长且无可用标点：硬截断到 160', () => {
    const created = EmployeeMemoryService.getInstance().createMemory(
      base({ content: 'a'.repeat(200) })
    )
    expect(created.content).toHaveLength(160)
  })
})

describe('读取 / 更新 / 删除', () => {
  function seed(over: Record<string, any> = {}) {
    return EmployeeMemoryService.getInstance().createMemory(base(over))
  }

  it('getMemory / listMemories / listMemoriesForInjection', () => {
    const m = seed()
    const svc = EmployeeMemoryService.getInstance()
    expect(svc.getMemory(m.id)?.id).toBe(m.id)
    expect(svc.listMemories('e1')).toHaveLength(1)
    expect(svc.listMemoriesForInjection('e1')).toHaveLength(1)
    expect(svc.listMemories('other')).toHaveLength(0)
  })

  it('listGlobalMemories 只返回全局', () => {
    seed({ scope: 'global' })
    expect(EmployeeMemoryService.getInstance().listGlobalMemories()).toHaveLength(1)
  })

  it('updateMemory：不存在返回 undefined；更新 content 重建 FTS', () => {
    const m = seed()
    const svc = EmployeeMemoryService.getInstance()
    expect(svc.updateMemory('x', { content: 'c' })).toBeUndefined()
    expect(svc.updateMemory(m.id, {})).toEqual(m)

    const updated = svc.updateMemory(m.id, { content: 'updated text value' })
    expect(updated.content).toBe('updated text value')
  })

  it('deleteMemory 软删除并移除 FTS；二次删除 false', () => {
    const m = seed()
    const svc = EmployeeMemoryService.getInstance()
    expect(svc.deleteMemory(m.id)).toBe(true)
    expect(svc.deleteMemory(m.id)).toBe(false)
    expect(svc.getMemory(m.id).deleted_at).toBeTruthy()
    expect(svc.listMemories('e1')).toHaveLength(0)
    expect(dbState.db.prepare('SELECT COUNT(*) AS c FROM employee_memories_fts').get().c).toBe(0)
  })

  it('deleteMemoryByKey 受作用域约束', () => {
    seed({ key: 'target' })
    const svc = EmployeeMemoryService.getInstance()
    expect(svc.deleteMemoryByKey({ scope: 'employee', employeeId: 'other' }, 'target')).toBe(false)
    expect(svc.deleteMemoryByKey({ scope: 'employee', employeeId: 'e1' }, 'target')).toBe(true)
  })

  it('togglePin 切换置顶状态', () => {
    const m = seed()
    const svc = EmployeeMemoryService.getInstance()
    expect(svc.togglePin(m.id).is_pinned).toBe(1)
    expect(svc.togglePin(m.id).is_pinned).toBe(0)
    expect(svc.togglePin('x')).toBeUndefined()
  })

  it('touchMemories：去重、空数组跳过', () => {
    const m1 = seed({ key: 'a' })
    const m2 = seed({ key: 'b' })
    const svc = EmployeeMemoryService.getInstance()
    expect(() => svc.touchMemories([])).not.toThrow()
    svc.touchMemories([m1.id, m1.id, m2.id])
    expect(svc.getMemory(m1.id).last_referenced_at).toBeGreaterThan(0)
  })
})

describe('检索', () => {
  it('searchMemories：置顶项排在命中项之前', () => {
    const svc = EmployeeMemoryService.getInstance()
    const pinned = svc.createMemory(base({ key: 'p', content: 'pinned note', is_pinned: true }))
    svc.createMemory(base({ key: 'h', content: 'needle keyword appears here' }))

    const results = svc.searchMemories('e1', 'needle')
    expect(results[0].id).toBe(pinned.id)
    expect(results.some(r => r.content.includes('needle'))).toBe(true)
  })

  it('searchMemoriesForAgent：scope=employee 只命中本员工并 touch', () => {
    const svc = EmployeeMemoryService.getInstance()
    const m = svc.createMemory(base({ content: 'agent needle hit' }))
    svc.createMemory(base({ employee_id: 'e2', content: 'agent needle other' }))

    const results = svc.searchMemoriesForAgent('e1', 'needle', { scope: 'employee' })
    expect(results).toHaveLength(1)
    expect(results[0].id).toBe(m.id)
    expect(svc.getMemory(m.id).last_referenced_at).toBeTruthy()
  })

  it('searchMemoriesForAgent：无命中返回空', () => {
    const svc = EmployeeMemoryService.getInstance()
    svc.createMemory(base())
    expect(svc.searchMemoriesForAgent('e1', 'zzzznotexist')).toEqual([])
  })
})

describe('统计 / 对话摘要', () => {
  it('getMemoryStats 汇总数量/字符/置顶', () => {
    const svc = EmployeeMemoryService.getInstance()
    svc.createMemory(base({ content: 'abc', is_pinned: true }))
    svc.createMemory(base({ key: 'k2', content: 'de' }))

    const stats = svc.getMemoryStats({ scope: 'employee', employeeId: 'e1' })
    expect(stats.count).toBe(2)
    expect(stats.totalChars).toBe(5)
    expect(stats.pinnedCount).toBe(1)
  })

  it('needsConsolidation：字符量超阈值返回 true', () => {
    const m = EmployeeMemoryService.getInstance().createMemory(base())
    expect(EmployeeMemoryService.getInstance().needsConsolidation({ scope: 'employee', employeeId: 'e1' })).toBe(false)

    // createMemory 会把 content 截断到 160；直接改库构造超量
    dbState.db.prepare('UPDATE employee_memories SET content = ? WHERE id = ?').run('x'.repeat(5000), m.id)
    expect(EmployeeMemoryService.getInstance().needsConsolidation({ scope: 'employee', employeeId: 'e1' })).toBe(true)
  })

  it('getConversationSummary', () => {
    dbState.db.prepare("INSERT INTO conversations (id, summary) VALUES ('c1', '摘要')").run()
    const svc = EmployeeMemoryService.getInstance()
    expect(svc.getConversationSummary('c1')).toBe('摘要')
    expect(svc.getConversationSummary('')).toBe('')
    expect(svc.getConversationSummary('x')).toBe('')
  })
})

describe('extractMemoriesFromConversation', () => {
  const messages = [
    { role: 'user', content: 'a'.repeat(40) },
    { role: 'assistant', content: 'b'.repeat(40) },
  ]

  it('无新消息 / 内容过短：返回空数组', async () => {
    const svc = EmployeeMemoryService.getInstance()
    expect(await svc.extractMemoriesFromConversation('e1', messages, 'p1', undefined, undefined, 2)).toEqual([])
    expect(await svc.extractMemoriesFromConversation('e1', [{ role: 'user', content: 'short' }], 'p1')).toEqual([])
  })

  it('LLM 返回提取 JSON：记忆落库、summary 写回会话', async () => {
    dbState.db.prepare("INSERT INTO conversations (id, summary) VALUES ('c1', '')").run()
    llmState.output = JSON.stringify({
      memories: [{ key: 'newk', topic: '新主题', content: '新记忆内容' }],
      delete_keys: [],
      update_memories: [],
      summary: '新的对话摘要',
    })

    const svc = EmployeeMemoryService.getInstance()
    const extracted = await svc.extractMemoriesFromConversation('e1', messages, 'p1', undefined, 'c1')
    expect(extracted).toHaveLength(1)
    expect(svc.listMemories('e1')[0].key).toBe('newk')
    expect(dbState.db.prepare("SELECT summary FROM conversations WHERE id='c1'").get().summary).toBe('新的对话摘要')
  })

  it('同 key 已存在时走更新而非新增', async () => {
    const svc = EmployeeMemoryService.getInstance()
    svc.createMemory(base({ key: 'dup', content: '旧内容' }))

    llmState.output = JSON.stringify({
      memories: [{ key: 'dup', topic: 't', content: '提取的新内容' }],
    })
    await svc.extractMemoriesFromConversation('e1', messages, 'p1')

    const all = svc.listMemories('e1')
    expect(all).toHaveLength(1)
    expect(all[0].content).toBe('提取的新内容')
  })

  it('LLM 输出无 JSON：抛 EXTRATION_INVALID_OUTPUT', async () => {
    llmState.output = 'no json here'
    const svc = EmployeeMemoryService.getInstance()
    await expect(svc.extractMemoriesFromConversation('e1', messages, 'p1'))
      .rejects.toThrow('EXTRACTION_INVALID_OUTPUT')
  })

  it('delete_keys 触发软删除', async () => {
    const svc = EmployeeMemoryService.getInstance()
    svc.createMemory(base({ key: 'obsolete', content: '旧' }))
    llmState.output = JSON.stringify({ memories: [], delete_keys: ['obsolete'] })

    const extracted = await svc.extractMemoriesFromConversation('e1', messages, 'p1')
    expect(extracted).toHaveLength(0)
    expect(svc.listMemories('e1')).toHaveLength(0)
  })
})

describe('consolidateMemories', () => {
  it('候选不足 2：不调用 LLM 直接返回', async () => {
    const svc = EmployeeMemoryService.getInstance()
    svc.createMemory(base())
    const r = await svc.consolidateMemories('e1', 'p1')
    expect(r).toEqual({ deleted: 0, merged: 0, simplified: 0 })
  })

  it('LLM 失败：兜底返回全 0', async () => {
    const svc = EmployeeMemoryService.getInstance()
    svc.createMemory(base({ key: 'a', content: 'aaaa' }))
    svc.createMemory(base({ key: 'b', content: 'bbbb' }))
    const { createPiProvider } = await import('../../../electron/main/services/agent/llm/pi-provider-factory')
    vi.mocked(createPiProvider).mockResolvedValueOnce({
      chat: vi.fn(async () => { throw new Error('llm down') }),
    } as any)

    const r = await svc.consolidateMemories('e1', 'p1')
    expect(r).toEqual({ deleted: 0, merged: 0, simplified: 0 })
  })

  it('LLM 返回 delete_keys：删除对应记忆', async () => {
    const svc = EmployeeMemoryService.getInstance()
    svc.createMemory(base({ key: 'old', content: 'old content x' }))
    svc.createMemory(base({ key: 'keep', content: 'keep content y' }))
    llmState.output = JSON.stringify({ delete_keys: ['old'], merge_groups: [], simplify_updates: [] })

    const r = await svc.consolidateMemories({ scope: 'employee', employeeId: 'e1' }, 'p1')
    expect(r.deleted).toBe(1)
    expect(svc.listMemories('e1')).toHaveLength(1)
  })

  it('autoConsolidateIfNeeded：不需要/冷却中返回 null', async () => {
    const svc = EmployeeMemoryService.getInstance()
    expect(await svc.autoConsolidateIfNeeded('e1', 'p1')).toBeNull()
  })
})

describe('过期清理 / 回收站', () => {
  it('removeStaleMemories：旧的 low 且未置顶被软删，置顶保留', () => {
    const svc = EmployeeMemoryService.getInstance()
    const stale = svc.createMemory(base({ key: 's', importance: 'low' }))
    svc.createMemory(base({ key: 'p', importance: 'low', is_pinned: true }))
    const old = Math.floor(Date.now() / 1000) - 100 * 86400
    // createMemory 会把 last_referenced_at 设为当前时间；置 NULL 使其走 created_at 判定分支
    dbState.db.prepare("UPDATE employee_memories SET created_at=?, updated_at=?, last_referenced_at=NULL WHERE id=?").run(old, old, stale.id)

    const n = svc.removeStaleMemories({ scope: 'employee', employeeId: 'e1' })
    expect(n).toBe(1)
    expect(svc.listTrashedMemories({ scope: 'employee', employeeId: 'e1' })).toHaveLength(1)
  })

  it('回收站：restore / purge / emptyTrash', () => {
    const svc = EmployeeMemoryService.getInstance()
    const m = svc.createMemory(base())
    svc.deleteMemory(m.id)

    const restored = svc.restoreMemory(m.id)
    expect(restored.deleted_at).toBeNull()
    expect(svc.listMemories('e1')).toHaveLength(1)

    svc.deleteMemory(m.id)
    expect(svc.purgeMemory(m.id)).toBe(true)
    expect(svc.getMemory(m.id)).toBeUndefined()
    expect(svc.purgeMemory(m.id)).toBe(false)
  })

  it('emptyTrash 清空指定作用域回收站', () => {
    const svc = EmployeeMemoryService.getInstance()
    const m = svc.createMemory(base())
    svc.deleteMemory(m.id)
    expect(svc.emptyTrash({ scope: 'employee', employeeId: 'e1' })).toBe(1)
    expect(svc.emptyTrash({ scope: 'employee', employeeId: 'e1' })).toBe(0)
  })
})
