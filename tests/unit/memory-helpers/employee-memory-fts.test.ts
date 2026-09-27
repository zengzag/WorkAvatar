/**
 * 记忆 FTS 分词桥接层集成测试。
 *
 * 关键回归点：FTS5 的 unicode61 会把一整段连续中文视作单个 token，
 * 因此索引侧必须用 jieba 预分词，否则"用户偏好简洁回复"无法被"用户偏好"命中。
 * 使用 Node 内置的 node:sqlite（无需为测试重新编译原生模块；CI 中 better-sqlite3
 * 是按 Electron ABI 构建的，无法在测试 Node 进程加载）。
 */
import { describe, it, expect } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { segmentMemoryText, buildMemoryFtsMatch } from '../../../electron/main/services/employee-memory-fts'

function setupDb(): DatabaseSync {
  const db = new DatabaseSync(':memory:')
  db.exec(`
    CREATE TABLE employee_memories (
      id TEXT PRIMARY KEY,
      employee_id TEXT,
      scope TEXT NOT NULL DEFAULT 'employee',
      key TEXT NOT NULL,
      topic TEXT NOT NULL,
      content TEXT NOT NULL DEFAULT '',
      is_pinned BOOLEAN NOT NULL DEFAULT 0,
      deleted_at INTEGER
    );
    CREATE VIRTUAL TABLE employee_memories_fts USING fts5(
      key, topic, content, memory_id UNINDEXED, employee_id UNINDEXED,
      tokenize='unicode61', prefix='2,3'
    );
  `)
  return db
}

function insertMemory(
  db: DatabaseSync,
  row: { id: string; employeeId: string | null; scope: 'employee' | 'global'; key: string; topic: string; content: string; segmented?: boolean },
): void {
  db.prepare(
    'INSERT INTO employee_memories (id, employee_id, scope, key, topic, content) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(row.id, row.employeeId, row.scope, row.key, row.topic, row.content)
  const seg = row.segmented === false ? (t: string) => t : segmentMemoryText
  db.prepare(
    'INSERT INTO employee_memories_fts (key, topic, content, memory_id, employee_id) VALUES (?, ?, ?, ?, ?)'
  ).run(seg(row.key), seg(row.topic), seg(row.content), row.id, row.employeeId ?? '')
}

/** 与 employee-memory.service 的检索 SQL 保持一致 */
function search(
  db: DatabaseSync,
  query: string,
  ownerSql = '((m.scope = ? AND m.employee_id = ?) OR m.scope = ?)',
  ownerParams: any[] = ['employee', 'e1', 'global'],
): string[] {
  const match = buildMemoryFtsMatch(query)
  if (!match) return []
  const rows = db.prepare(
    `SELECT m.id FROM employee_memories_fts f
     JOIN employee_memories m ON m.id = f.memory_id
     WHERE m.deleted_at IS NULL AND ${ownerSql} AND employee_memories_fts MATCH ?
     ORDER BY bm25(employee_memories_fts) ASC
     LIMIT 10`
  ).all(...ownerParams, match) as Array<{ id: string }>
  return rows.map(r => r.id)
}

describe('employee-memory-fts / buildMemoryFtsMatch', () => {
  it('空查询返回 null（调用方直接短路）', () => {
    expect(buildMemoryFtsMatch('')).toBeNull()
    expect(buildMemoryFtsMatch('   ')).toBeNull()
  })

  it('中文查询被 jieba 切词并以 OR 连接', () => {
    const match = buildMemoryFtsMatch('用户偏好')
    expect(match).not.toBeNull()
    expect(match!).toContain('OR')
  })
})

describe('employee-memory-fts / 中文按词检索', () => {
  it('预分词索引下，中文子串查询可命中', () => {
    const db = setupDb()
    insertMemory(db, {
      id: 'm1', employeeId: 'e1', scope: 'employee',
      key: 'writing_style', topic: '用户偏好', content: '用户偏好简洁回复，不要冗长铺垫',
    })
    expect(search(db, '用户偏好')).toEqual(['m1'])
    expect(search(db, '简洁回复')).toEqual(['m1'])
    db.close()
  })

  it('未预分词的索引无法按中文词命中（说明索引侧分词是必需的）', () => {
    const db = setupDb()
    insertMemory(db, {
      id: 'raw', employeeId: 'e1', scope: 'employee',
      key: 'writing_style', topic: '用户偏好', content: '用户偏好简洁回复',
      segmented: false,
    })
    // unicode61 把整段中文当成一个 token，子串查询命中不了
    expect(search(db, '用户偏好')).toEqual([])
    db.close()
  })

  it('英文与数字混排内容可命中', () => {
    const db = setupDb()
    insertMemory(db, {
      id: 'm2', employeeId: 'e1', scope: 'employee',
      key: 'excel_pitfall', topic: '事实知识', content: 'Excel 透视表超过十万行会崩溃，改用 Power Query',
    })
    expect(search(db, 'Excel')).toEqual(['m2'])
    expect(search(db, '透视表')).toEqual(['m2'])
    db.close()
  })

  it('OR 语义：命中任一关键词即可召回', () => {
    const db = setupDb()
    insertMemory(db, { id: 'a', employeeId: 'e1', scope: 'employee', key: 'k1', topic: '用户偏好', content: '周报用 PDF 发送' })
    insertMemory(db, { id: 'b', employeeId: 'e1', scope: 'employee', key: 'k2', topic: '决策结论', content: 'PPT 不用动画' })
    const hitIds = search(db, '周报 动画').sort()
    expect(hitIds).toEqual(['a', 'b'])
    db.close()
  })
})

describe('employee-memory-fts / 作用域过滤', () => {
  it('仅员工作用域时不返回全局记忆', () => {
    const db = setupDb()
    insertMemory(db, { id: 'emp', employeeId: 'e1', scope: 'employee', key: 'k1', topic: '用户偏好', content: '用中文回复' })
    insertMemory(db, { id: 'glb', employeeId: null, scope: 'global', key: 'k2', topic: '用户偏好', content: '用户是财务岗，用中文回复' })

    const employeeOnly = search(db, '中文回复', 'm.scope = ? AND m.employee_id = ?', ['employee', 'e1'])
    expect(employeeOnly).toEqual(['emp'])

    const all = search(db, '中文回复').sort()
    expect(all).toEqual(['emp', 'glb'])
    db.close()
  })

  it('仅全局作用域时只返回全局记忆', () => {
    const db = setupDb()
    insertMemory(db, { id: 'emp', employeeId: 'e1', scope: 'employee', key: 'k1', topic: '用户偏好', content: '用中文回复' })
    insertMemory(db, { id: 'glb', employeeId: null, scope: 'global', key: 'k2', topic: '用户偏好', content: '用户是财务岗，用中文回复' })
    expect(search(db, '中文回复', 'm.scope = ?', ['global'])).toEqual(['glb'])
    expect(search(db, '中文回复', 'm.scope = ? AND m.employee_id = ?', ['employee', 'e1'])).toEqual(['emp'])
    db.close()
  })
})
