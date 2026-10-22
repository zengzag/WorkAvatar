import { describe, it, expect } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import {
  buildConversationFtsMatch,
  buildConversationLikeTerms,
  buildConversationSnippet,
  ensureConversationFts,
} from '../../../electron/main/services/conversation-fts'

/**
 * 对话检索 FTS 表达式构造。
 * 回归重点：中文必须走 jieba 分词（unicode61 会把整段中文视作单个 token，
 * "保密协议" 这类词在旧实现里几乎永不命中）。
 */
describe('buildConversationFtsMatch（对话检索 FTS 表达式）', () => {
  it('中文按 jieba 词切分，默认 AND 连接', () => {
    expect(buildConversationFtsMatch('保密协议')).toBe('"保密" AND "协议"')
  })

  it('mode=any 时改为 OR 连接（召回优先）', () => {
    expect(buildConversationFtsMatch('保密协议', 'any')).toBe('"保密" OR "协议"')
  })

  it('长词会拆出子词一并参与匹配', () => {
    expect(buildConversationFtsMatch('知识库')).toBe('"知识" AND "知识库"')
  })

  it('英文按词匹配并小写化', () => {
    expect(buildConversationFtsMatch('KMS')).toBe('"kms"')
  })

  it('剔除 FTS5 语法字符，不抛 syntax error', () => {
    expect(buildConversationFtsMatch('a*b(c)^d+e-f')).toBe('"abcdef"')
  })

  it('空/纯符号查询返回 null', () => {
    expect(buildConversationFtsMatch('')).toBeNull()
    expect(buildConversationFtsMatch('***')).toBeNull()
    expect(buildConversationFtsMatch('   ')).toBeNull()
  })
})

describe('buildConversationLikeTerms（LIKE 兜底关键词）', () => {
  it('按 jieba 词粒度切分', () => {
    expect(buildConversationLikeTerms('保密协议')).toEqual(['保密', '协议'])
  })

  it('无有效词元时回退为清洗后的原串', () => {
    expect(buildConversationLikeTerms('***')).toEqual(['***'])
  })
})

describe('buildConversationSnippet（原文片段高亮）', () => {
  it('命中关键词时截取上下文并加 highlight 标记', () => {
    const raw = `${'前文'.repeat(40)}保密协议的签订要求${'后文'.repeat(40)}`
    const snippet = buildConversationSnippet(raw, '保密协议')
    // 长词优先：整词命中时不再拆成单字高亮
    expect(snippet).toContain('<highlight>保密协议</highlight>')
    expect(snippet.startsWith('...')).toBe(true)
  })

  it('未命中时返回正文开头', () => {
    const snippet = buildConversationSnippet('一段无关内容', '保密协议')
    expect(snippet).toBe('一段无关内容')
    expect(snippet).not.toContain('<highlight>')
  })

  it('空预览返回空串', () => {
    expect(buildConversationSnippet('', '查询')).toBe('')
  })
})

describe('ensureConversationFts（旧索引重建）', () => {
  function setupOldSchema(): DatabaseSync {
    const db = new DatabaseSync(':memory:')
    db.exec(`
      CREATE TABLE conversations (
        id TEXT PRIMARY KEY,
        employee_id TEXT,
        title TEXT DEFAULT '',
        summary TEXT DEFAULT '',
        messages_json TEXT DEFAULT '[]',
        status TEXT DEFAULT 'active',
        parent_conversation_id TEXT DEFAULT ''
      );
      CREATE VIRTUAL TABLE conversations_fts USING fts5(
        title, summary, content_preview,
        conversation_id UNINDEXED, employee_id UNINDEXED,
        tokenize='unicode61', prefix='2,3'
      );
    `)
    const messages = JSON.stringify([
      { role: 'user', content: '需要尽快完成保密协议的签订' },
      { role: 'assistant', content: '已整理好签订流程与注意事项' },
    ])
    db.prepare(
      'INSERT INTO conversations (id, employee_id, title, messages_json) VALUES (?, ?, ?, ?)'
    ).run('c1', 'emp-1', '保密协议签订', messages)
    // 旧索引：整段中文是单个 token，检索 "保密协议" 无法命中
    db.prepare(
      'INSERT INTO conversations_fts VALUES (?, ?, ?, ?, ?)'
    ).run('保密协议签订', '', '需要尽快完成保密协议的签订', 'c1', 'emp-1')
    return db
  }

  it('旧表被重建：中文按词可命中，且保留原始预览列', () => {
    const db = setupOldSchema()
    const before = db.prepare(
      'SELECT count(*) AS n FROM conversations_fts WHERE conversations_fts MATCH ?'
    ).get('"保密协议"') as { n: number }
    expect(before.n).toBe(0)

    ensureConversationFts(db as any)

    const columns = db.prepare('PRAGMA table_info(conversations_fts)').all() as Array<{ name: string }>
    expect(columns.some(c => c.name === 'content_raw')).toBe(true)

    const after = db.prepare(
      'SELECT content_raw FROM conversations_fts WHERE conversations_fts MATCH ?'
    ).get('"保密" AND "协议"') as { content_raw: string } | undefined
    expect(after?.content_raw).toContain('保密协议')
  })

  it('已是新结构时幂等（重复调用不重复写入）', () => {
    const db = setupOldSchema()
    ensureConversationFts(db as any)
    ensureConversationFts(db as any)
    const rows = db.prepare('SELECT count(*) AS n FROM conversations_fts').get() as { n: number }
    expect(rows.n).toBe(1)
  })
})
