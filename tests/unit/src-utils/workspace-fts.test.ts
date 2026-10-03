import { describe, it, expect } from 'vitest'
import { buildFtsQuery } from '../../../electron/main/services/workspace-manager.service'

describe('buildFtsQuery（对话全局搜索 FTS 表达式）', () => {
  it('英文 token 追加前缀匹配', () => {
    expect(buildFtsQuery('work')).toBe('work*')
  })

  it('ClientId：中文逐字拆分后每字均带前缀匹配', () => {
    expect(buildFtsQuery('知识库')).toBe('知* 识* 库*')
  })

  it('剔除 FTS5 语法字符，不抛 syntax error', () => {
    const q = buildFtsQuery('a:b (c) ^d-e')
    expect(q).not.toMatch(/[:()^]/)
    expect(q.length).toBeGreaterThan(0)
  })

  it('空/纯符号查询返回空串', () => {
    expect(buildFtsQuery('')).toBe('')
    expect(buildFtsQuery('!!!')).toBe('')
    expect(buildFtsQuery('   ')).toBe('')
  })

  it('混合中英文', () => {
    expect(buildFtsQuery('kms 知识')).toBe('kms* 知* 识*')
  })
})
