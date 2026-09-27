import { describe, it, expect } from 'vitest'
import {
  buildMemoryMatchQuery,
  applyScoreFloor,
  selectAlwaysOnMemories,
  buildMemoryPromptBlock,
  formatContentOnlyMessages,
  formatMemoriesForPrompt,
  getExtractionRelevantMemories,
  getConsolidationCandidates,
  hideMemoryBoundCategories,
} from '../../../electron/main/services/employee-memory-helpers'
import { MEMORY_SEARCH_MAX_TERMS, MEMORY_BOUND_TOOL_IDS } from '../../../electron/main/services/employee-memory-types'
import type { EmployeeMemory } from '../../../electron/main/services/employee-memory-types'

function makeMemory(partial: Partial<EmployeeMemory>): EmployeeMemory {
  return {
    id: 'm1',
    employee_id: 'e1',
    scope: 'employee',
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

/** 简易分词器：按空白切分，模拟 jieba 的输出形态 */
const whitespaceTokenize = (text: string) => text.split(/\s+/).filter(Boolean)

describe('employee-memory-helpers / buildMemoryMatchQuery', () => {
  it('空查询 / 仅空白返回 null', () => {
    expect(buildMemoryMatchQuery('', whitespaceTokenize)).toBeNull()
    expect(buildMemoryMatchQuery('   ', whitespaceTokenize)).toBeNull()
  })

  it('分词器无输出时返回 null（不把脏查询送进 SQL）', () => {
    expect(buildMemoryMatchQuery('任意', () => [])).toBeNull()
  })

  it('单/多词元均加短语引号并以 OR 连接', () => {
    expect(buildMemoryMatchQuery('测试', whitespaceTokenize)).toBe('"测试"')
    expect(buildMemoryMatchQuery('用户 偏好', whitespaceTokenize)).toBe('"用户" OR "偏好"')
  })

  it('词元去重（大小写不敏感）并剔除内部引号', () => {
    expect(buildMemoryMatchQuery('Ab ab', whitespaceTokenize)).toBe('"Ab"')
    expect(buildMemoryMatchQuery('a"b', whitespaceTokenize)).toBe('"ab"')
  })

  it('词元数量被截断到上限，避免超长 MATCH', () => {
    const many = Array.from({ length: MEMORY_SEARCH_MAX_TERMS + 10 }, (_, i) => `w${i}`).join(' ')
    const expr = buildMemoryMatchQuery(many, whitespaceTokenize)!
    expect(expr.split(' OR ')).toHaveLength(MEMORY_SEARCH_MAX_TERMS)
  })
})

describe('employee-memory-helpers / applyScoreFloor', () => {
  it('空数组返回空', () => {
    expect(applyScoreFloor([], 0.15)).toEqual([])
  })

  it('floor <= 0 时不过滤', () => {
    const rows = [{ score: 10 }, { score: 1 }, { score: -5 }]
    expect(applyScoreFloor(rows, 0)).toHaveLength(3)
  })

  it('第 1 条恒保留，尾部低于相对阈值的被裁掉', () => {
    const rows = [{ score: 1 }, { score: 0.5 }, { score: 0.1 }, { score: 0.05 }]
    const kept = applyScoreFloor(rows, 0.15)
    expect(kept.map(r => r.score)).toEqual([1, 0.5])
  })

  it('即使第 1 条为负（BM25 极端情况）也保留', () => {
    const rows = [{ score: -1 }, { score: -10 }]
    expect(applyScoreFloor(rows, 0.15)).toHaveLength(1)
  })
})

describe('employee-memory-helpers / selectAlwaysOnMemories', () => {
  it('只保留置顶与关键记忆，置顶优先', () => {
    const picked = selectAlwaysOnMemories([
      makeMemory({ id: '1', content: '普通' }),
      makeMemory({ id: '2', content: '关键', importance: 'critical' }),
      makeMemory({ id: '3', content: '置顶', is_pinned: 1, importance: 'low' }),
    ])
    expect(picked.map(m => m.id)).toEqual(['3', '2'])
  })

  it('超出条数上限时截断', () => {
    const list = Array.from({ length: 20 }, (_, i) => makeMemory({ id: String(i), is_pinned: 1 }))
    expect(selectAlwaysOnMemories(list, { maxCount: 3 })).toHaveLength(3)
  })

  it('maxCount <= 0 时返回空', () => {
    expect(selectAlwaysOnMemories([makeMemory({ is_pinned: 1 })], { maxCount: 0 })).toEqual([])
  })

  it('无置顶/关键记忆时返回空数组', () => {
    expect(selectAlwaysOnMemories([makeMemory({ importance: 'low' })])).toEqual([])
  })
})

describe('employee-memory-helpers / buildMemoryPromptBlock', () => {
  it('无任何记忆时不占用上下文', () => {
    expect(buildMemoryPromptBlock([], 0)).toBe('')
  })

  it('有记忆但无常驻项时只给检索提示', () => {
    const block = buildMemoryPromptBlock([], 3)
    expect(block).toContain('核心记忆')
    expect(block).toContain('search_memories')
    expect(block).not.toContain('- ')
  })

  it('有常驻项时列出内容并附检索提示', () => {
    const block = buildMemoryPromptBlock([makeMemory({ content: '用户偏好简洁回复', is_pinned: 1 })], 5)
    expect(block).toContain('- 用户偏好简洁回复')
    expect(block).toContain('search_memories')
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

describe('employee-memory-helpers / hideMemoryBoundCategories', () => {
  it('记忆开启时原样返回（同一引用）', () => {
    const categories = [
      { id: 'conversation_memory', tool_ids: [...MEMORY_BOUND_TOOL_IDS] },
      { id: 'web', tool_ids: ['web_search'] },
    ]
    expect(hideMemoryBoundCategories(categories, true)).toBe(categories)
  })

  it('记忆关闭时整类隐藏与记忆绑定的分类，其他分类保留', () => {
    const categories = [
      { id: 'file_operations', tool_ids: ['file_read'] },
      { id: 'conversation_memory', tool_ids: [...MEMORY_BOUND_TOOL_IDS] },
      { id: 'web', tool_ids: ['web_search'] },
    ]
    expect(hideMemoryBoundCategories(categories, false).map(c => c.id)).toEqual([
      'file_operations',
      'web',
    ])
  })

  it('空列表返回空数组', () => {
    expect(hideMemoryBoundCategories([], false)).toEqual([])
  })
})
