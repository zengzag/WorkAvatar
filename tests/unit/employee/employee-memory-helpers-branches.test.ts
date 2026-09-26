/**
 * 记忆辅助函数未覆盖分支补充（与 tests/unit/memory-helpers 互补）：
 * - formatMemoriesForPrompt 的 pinned 越限、长度记账与排序稳定性
 * - getExtractionRelevantMemories 的关键词大小写、上限与空文本
 * - getConsolidationCandidates 的 pinned 超过上限、critical 归入 recent
 */
import { describe, it, expect } from 'vitest'
import {
  formatContentOnlyMessages,
  formatMemoriesForPrompt,
  getExtractionRelevantMemories,
  getConsolidationCandidates,
  selectAlwaysOnMemories,
  buildMemoryPromptBlock,
} from '../../../electron/main/services/employee-memory-helpers'
import type { EmployeeMemory } from '../../../electron/main/services/employee-memory-types'
import {
  MEMORY_MAX_CHARS,
  EXTRACTION_MAX_EXISTING_MEMORIES,
  CONSOLIDATION_CANDIDATE_MAX,
  MEMORY_ALWAYS_ON_MAX_COUNT,
} from '../../../electron/main/services/employee-memory-types'

function makeMemory(partial: Partial<EmployeeMemory> = {}): EmployeeMemory {
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

describe('memory-helpers 补充 / selectAlwaysOnMemories 边界', () => {
  it('默认条数上限为常量值', () => {
    const list = Array.from({ length: MEMORY_ALWAYS_ON_MAX_COUNT + 5 }, (_, i) =>
      makeMemory({ id: `p${i}`, is_pinned: 1 }),
    )
    expect(selectAlwaysOnMemories(list)).toHaveLength(MEMORY_ALWAYS_ON_MAX_COUNT)
  })

  it('同 pinned 时 critical 排在 normal/low 之前', () => {
    const picked = selectAlwaysOnMemories([
      makeMemory({ id: 'low', is_pinned: 1, importance: 'low' }),
      makeMemory({ id: 'crit', is_pinned: 1, importance: 'critical' }),
      makeMemory({ id: 'norm', is_pinned: 1, importance: 'normal' }),
    ])
    expect(picked.map(m => m.id)).toEqual(['crit', 'norm', 'low'])
  })
})

describe('memory-helpers 补充 / buildMemoryPromptBlock 边界', () => {
  it('pinned 项超过字符上限仍保留（与 formatMemoriesForPrompt 语义一致）', () => {
    const block = buildMemoryPromptBlock(
      [makeMemory({ content: 'y'.repeat(3000), is_pinned: 1 })],
      1,
    )
    expect(block).toContain('y'.repeat(3000))
  })

  it('全部记忆为空时返回空串', () => {
    expect(buildMemoryPromptBlock([], 0)).toBe('')
  })
})

describe('memory-helpers 补充 / formatContentOnlyMessages', () => {
  it('仅 user/assistant 且内容非空白才保留，顺序不变', () => {
    const out = formatContentOnlyMessages([
      { role: 'system', content: '系统' },
      { role: 'user', content: '一' },
      { role: 'assistant', content: '' },
      { role: 'tool', content: '工具' },
      { role: 'assistant', content: '二' },
    ])
    expect(out).toBe('用户: 一\n助手: 二')
  })

  it('保留多行内容原样（不压缩换行）', () => {
    expect(formatContentOnlyMessages([{ role: 'user', content: 'a\n\nb' }])).toBe('用户: a\n\nb')
  })
})

describe('memory-helpers 补充 / formatMemoriesForPrompt', () => {
  it('默认上限为 MEMORY_MAX_CHARS', () => {
    const memories = Array.from({ length: 200 }, (_, i) => makeMemory({ id: `m${i}`, content: 'x'.repeat(50) }))
    const out = formatMemoriesForPrompt(memories)
    expect(out.length).toBeLessThanOrEqual(MEMORY_MAX_CHARS)
    expect(out.length).toBeGreaterThan(0)
  })

  it('pinned 记忆即使超限也会继续保留（不因非 pinned 提前 break 而丢弃）', () => {
    const out = formatMemoriesForPrompt(
      [
        makeMemory({ id: '1', content: 'a'.repeat(200), importance: 'normal' }),
        makeMemory({ id: '2', content: 'pinned-1', is_pinned: 1 }),
        makeMemory({ id: '3', content: 'pinned-2', is_pinned: 1 }),
      ],
      10,
    )
    expect(out).toBe('- pinned-1\n- pinned-2')
  })

  it('同重要性按 updated_at 倒序', () => {
    const out = formatMemoriesForPrompt([
      makeMemory({ id: '1', content: '旧', updated_at: 1 }),
      makeMemory({ id: '2', content: '新', updated_at: 9 }),
    ])
    expect(out.split('\n')).toEqual(['- 新', '- 旧'])
  })

  it('importance 顺序 critical > normal > low', () => {
    const out = formatMemoriesForPrompt([
      makeMemory({ id: '1', content: 'low', importance: 'low' }),
      makeMemory({ id: '2', content: 'normal', importance: 'normal' }),
      makeMemory({ id: '3', content: 'critical', importance: 'critical' }),
    ])
    expect(out.split('\n')).toEqual(['- critical', '- normal', '- low'])
  })

  it('内容为空字符串时仍输出占位行', () => {
    expect(formatMemoriesForPrompt([makeMemory({ content: '' })])).toBe('- ')
  })

  it('仅返回 content 不包含 topic/key', () => {
    const out = formatMemoriesForPrompt([makeMemory({ key: 'k1', topic: 't1', content: 'c1' })])
    expect(out).toBe('- c1')
  })
})

describe('memory-helpers 补充 / getExtractionRelevantMemories', () => {
  const many = (n: number, prefix: string) =>
    Array.from({ length: n }, (_, i) => makeMemory({ id: `${prefix}${i}`, key: `${prefix}_${i}`, content: `${prefix} 内容 ${i}`, updated_at: 1000 }))

  it('恰好等于上限时不打分直接返回', () => {
    const list = many(EXTRACTION_MAX_EXISTING_MEMORIES, 'x')
    expect(getExtractionRelevantMemories(list, '')).toHaveLength(EXTRACTION_MAX_EXISTING_MEMORIES)
  })

  it('超过上限时按关键词命中加分（大小写不敏感）', () => {
    const list = [...many(30, 'other'), makeMemory({ id: 'hit', key: 'k', topic: '', content: 'Python 教程', updated_at: 1000 })]
    const picked = getExtractionRelevantMemories(list, 'PYTHON')
    expect(picked.map(m => m.id)).toContain('hit')
  })

  it('返回条数不超过上限', () => {
    expect(getExtractionRelevantMemories(many(100, 'y'), '内容')).toHaveLength(EXTRACTION_MAX_EXISTING_MEMORIES)
  })

  it('空对话文本时仅按 pinned/critical/新鲜度排序', () => {
    const list = [...many(30, 'z'), makeMemory({ id: 'crit', importance: 'critical', updated_at: 1000 })]
    expect(getExtractionRelevantMemories(list, '')[0].id).toBe('crit')
  })

  it('非常旧的非 pinned 记忆排在最后（新鲜度加分不为负）', () => {
    const stale = makeMemory({ id: 'stale', content: '陈旧', updated_at: Math.floor(Date.now() / 1000) - 365 * 86400 })
    const fresh = makeMemory({ id: 'fresh', content: '新鲜', updated_at: Math.floor(Date.now() / 1000) })
    const list = [...many(30, 'q'), stale, fresh]
    const picked = getExtractionRelevantMemories(list, '')
    expect(picked.map(m => m.id)).toContain('fresh')
    expect(picked.map(m => m.id)).not.toContain('stale')
  })
})

describe('memory-helpers 补充 / getConsolidationCandidates', () => {
  it('pinned 数量超过上限时全部保留（硬上限被 pinned 突破）', () => {
    const pinned = Array.from({ length: CONSOLIDATION_CANDIDATE_MAX + 5 }, (_, i) =>
      makeMemory({ id: `p${i}`, is_pinned: 1, updated_at: 1 }),
    )
    const picked = getConsolidationCandidates(pinned)
    expect(picked).toHaveLength(CONSOLIDATION_CANDIDATE_MAX + 5)
  })

  it('critical 归入 recent 组，优先于 old', () => {
    const now = Math.floor(Date.now() / 1000)
    const old = Array.from({ length: 20 }, (_, i) => makeMemory({ id: `old${i}`, updated_at: now - 200 * 86400 }))
    const critical = makeMemory({ id: 'crit', importance: 'critical', updated_at: now - 200 * 86400 })
    const picked = getConsolidationCandidates([...old, critical])
    expect(picked.map(m => m.id)).toContain('crit')
  })

  it('30 天内更新视为 recent', () => {
    const now = Math.floor(Date.now() / 1000)
    const old = Array.from({ length: 20 }, (_, i) => makeMemory({ id: `old${i}`, updated_at: now - 200 * 86400 }))
    const recent = makeMemory({ id: 'recent', updated_at: now - 29 * 86400 })
    expect(getConsolidationCandidates([...old, recent]).map(m => m.id)).toContain('recent')
  })

  it('空输入返回空数组', () => {
    expect(getConsolidationCandidates([])).toEqual([])
  })
})
