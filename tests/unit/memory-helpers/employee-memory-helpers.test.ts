import { describe, it, expect } from 'vitest'
import {
  buildFtsQuery,
  formatContentOnlyMessages,
  formatMemoriesForPrompt,
  getExtractionRelevantMemories,
  getConsolidationCandidates,
  generateFallbackSummary,
} from '../../../electron/main/services/employee-memory-helpers'
import type { EmployeeMemory } from '../../../electron/main/services/employee-memory-types'

function makeMemory(partial: Partial<EmployeeMemory>): EmployeeMemory {
  return {
    id: 'm1',
    employee_id: 'e1',
    key: 'k',
    topic: 't',
    content: 'c',
    is_pinned: 0,
    source: 'auto',
    importance: 'normal',
    created_at: 1000,
    updated_at: 1000,
    last_referenced_at: null,
    deleted_at: null,
    ...partial,
  }
}

describe('employee-memory-helpers / buildFtsQuery', () => {
  it('短查询返回空', () => {
    expect(buildFtsQuery('')).toBe('')
    expect(buildFtsQuery('  ')).toBe('')
    expect(buildFtsQuery('a')).toBe('')
  })

  it('包裹引号短语', () => {
    expect(buildFtsQuery('测试')).toBe('"测试"')
  })

  it('双引号转义、FTS 运算符移除', () => {
    expect(buildFtsQuery('a"b*c(d)-e+f')).toBe('"a""bcdef"')
  })

  it('清理后不足 2 字符返回空', () => {
    expect(buildFtsQuery('*-+')).toBe('')
  })
})

describe('employee-memory-helpers / formatContentOnlyMessages', () => {
  it('仅保留 user/assistant 非空消息', () => {
    const out = formatContentOnlyMessages([
      { role: 'user', content: '你好' },
      { role: 'tool', content: 'tool output' },
      { role: 'assistant', content: '你好！' },
      { role: 'user', content: '   ' },
    ])
    expect(out).toBe('用户: 你好\n助手: 你好！')
  })

  it('空数组返回空串', () => {
    expect(formatContentOnlyMessages([])).toBe('')
  })
})

describe('employee-memory-helpers / formatMemoriesForPrompt', () => {
  it('空列表返回空串', () => {
    expect(formatMemoriesForPrompt([])).toBe('')
  })

  it('按 pinned > importance > updated_at 排序', () => {
    const out = formatMemoriesForPrompt([
      makeMemory({ id: '1', content: '普通旧', importance: 'normal', updated_at: 100 }),
      makeMemory({ id: '2', content: 'critical', importance: 'critical', updated_at: 50 }),
      makeMemory({ id: '3', content: '置顶', is_pinned: 1, importance: 'low', updated_at: 10 }),
    ])
    const lines = out.split('\n')
    expect(lines[0]).toBe('- 置顶')
    expect(lines[1]).toBe('- critical')
    expect(lines[2]).toBe('- 普通旧')
  })

  it('超长截断（非 pinned break，pinned 保留）', () => {
    const memories = [
      makeMemory({ id: '1', content: 'a'.repeat(100), importance: 'normal' }),
      makeMemory({ id: '2', content: 'b'.repeat(100), importance: 'normal' }),
      makeMemory({ id: '3', content: 'pinned 内容', is_pinned: 1 }),
    ]
    const out = formatMemoriesForPrompt(memories, 120)
    expect(out).toContain('pinned 内容')
    expect(out).not.toContain('b'.repeat(100))
  })

  it('自定义 maxChars 生效', () => {
    const out = formatMemoriesForPrompt(
      [makeMemory({ id: '1', content: 'x'.repeat(50) })],
      10
    )
    expect(out).toBe('')
  })
})

describe('employee-memory-helpers / getExtractionRelevantMemories', () => {
  it('不超过上限时原样返回', () => {
    const list = Array.from({ length: 12 }, (_, i) => makeMemory({ id: String(i) }))
    expect(getExtractionRelevantMemories(list, '任何文本')).toHaveLength(12)
  })

  it('超限时按相关性取前 12', () => {
    const list = Array.from({ length: 30 }, (_, i) =>
      makeMemory({ id: String(i), content: i < 5 ? `python 相关${i}` : `无关内容${i}`, updated_at: 1000 })
    )
    const picked = getExtractionRelevantMemories(list, 'python 编程 教程')
    expect(picked).toHaveLength(12)
    const ids = picked.map(m => m.id)
    for (let i = 0; i < 5; i++) expect(ids).toContain(String(i))
  })

  it('pinned 与 critical 加分靠前', () => {
    const list = Array.from({ length: 30 }, (_, i) => makeMemory({ id: `x${i}`, updated_at: 1000 }))
    list.push(makeMemory({ id: 'pin', is_pinned: 1, updated_at: 1000 }))
    const picked = getExtractionRelevantMemories(list, '')
    expect(picked[0].id).toBe('pin')
  })
})

describe('employee-memory-helpers / getConsolidationCandidates', () => {
  it('不超过上限原样返回', () => {
    const list = Array.from({ length: 15 }, (_, i) => makeMemory({ id: String(i) }))
    expect(getConsolidationCandidates(list)).toHaveLength(15)
  })

  it('超限时 pinned 优先、其次 recent/critical、最后 old', () => {
    const now = Math.floor(Date.now() / 1000)
    const list: EmployeeMemory[] = []
    for (let i = 0; i < 20; i++) list.push(makeMemory({ id: `old${i}`, updated_at: now - 60 * 86400 }))
    list.push(makeMemory({ id: 'pin1', is_pinned: 1, updated_at: now - 60 * 86400 }))
    list.push(makeMemory({ id: 'recent1', updated_at: now - 86400 }))
    const picked = getConsolidationCandidates(list)
    expect(picked).toHaveLength(15)
    expect(picked.map(m => m.id)).toContain('pin1')
    expect(picked.map(m => m.id)).toContain('recent1')
  })
})

describe('employee-memory-helpers / generateFallbackSummary', () => {
  it('包含话题数与消息统计', () => {
    const out = generateFallbackSummary([
      { role: 'user', content: '帮我写报告' },
      { role: 'assistant', content: '好的' },
      { role: 'user', content: '再改一版' },
    ])
    expect(out).toContain('讨论了 2 个话题')
    expect(out).toContain('- 用户询问: 帮我写报告')
    expect(out).toContain('共 2 条用户消息，1 条助手回复')
  })

  it('长消息截断 100 字加省略号', () => {
    const out = generateFallbackSummary([{ role: 'user', content: 'z'.repeat(150) }])
    expect(out).toContain('...')
    expect(out).not.toContain('z'.repeat(150))
  })

  it('空消息列表', () => {
    const out = generateFallbackSummary([])
    expect(out).toContain('共 0 条用户消息，0 条助手回复')
  })
})
