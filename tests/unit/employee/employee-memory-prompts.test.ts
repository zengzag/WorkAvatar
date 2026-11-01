/**
 * 记忆提示词构建单测（纯函数）：
 * - 记忆提取 / 合并整理两类 prompt 的结构与关键约束
 * - 与 employee-memory-types 中常量的一致性（防止 prompt 文案与阈值常量漂移）
 * - 上下文拼接的边界（空数组、多段、超长、Unicode）
 */
import { describe, it, expect } from 'vitest'
import {
  buildExtractionPrompt,
  buildConsolidationPrompt,
} from '../../../electron/main/services/employee-memory-prompts'
import {
  STALE_MEMORY_DAYS,
  MEMORY_MAX_CHARS,
  MEMORY_MAX_COUNT,
  MEMORY_CONTENT_MAX_CHARS,
  MEMORY_CONSOLIDATION_TARGET_COUNT,
  MEMORY_CONSOLIDATION_TARGET_CHARS,
} from '../../../electron/main/services/employee-memory-types'

describe('employee-memory-prompts / buildExtractionPrompt', () => {
  it('上下文按 --- 分隔拼接并落到 prompt 末尾', () => {
    const p = buildExtractionPrompt(['历史摘要A', '本轮新对话B', '现有记忆C'])
    expect(p).toContain('历史摘要A\n---\n本轮新对话B\n---\n现有记忆C')
  })

  it('空上下文数组不抛错，仍输出完整模板', () => {
    const p = buildExtractionPrompt([])
    expect(p).toContain('Context:')
    expect(p).toContain('"memories"')
    expect(p.length).toBeGreaterThan(500)
  })

  it('单段上下文不带分隔符', () => {
    const p = buildExtractionPrompt(['只有一段'])
    expect(p).toContain('只有一段')
    expect(p).not.toContain('只有一段\n---\n')
  })

  it('包含核心判定准则与输出字段（防止模板被误删关键约束）', () => {
    const p = buildExtractionPrompt(['x'])
    expect(p).toContain('will I still need this in a week')
    expect(p).toContain('delete_keys')
    expect(p).toContain('update_memories')
    expect(p).toContain('running summary')
  })

  it('超长/Unicode 上下文完整透传', () => {
    const long = '🙂'.repeat(5000) + '\n' + '中'.repeat(5000)
    const p = buildExtractionPrompt([long])
    expect(p).toContain(long)
  })

  it('单条 content 上限提示与常量同量级（≤150 字符提示 vs 服务层硬截断）', () => {
    const p = buildExtractionPrompt([])
    expect(p).toContain('≤150 characters')
    // 服务层兜底截断上限不得小于提示词约定值，否则会出现"照提示写仍被截断"
    expect(MEMORY_CONTENT_MAX_CHARS).toBeGreaterThanOrEqual(150)
  })

  it('包含作用域判定规则与输出字段（防止全局记忆被误判）', () => {
    const p = buildExtractionPrompt([])
    expect(p).toContain('## Scope')
    expect(p).toContain('"scope":"employee|global"')
    // 不确定时必须回落到 employee，避免错误地全局生效
    expect(p).toContain('When unsure, always use "employee"')
  })

  it('包含提取准入闸门与产出预算（抑制过度提取）', () => {
    const p = buildExtractionPrompt([])
    expect(p).toContain('## Admission bar')
    expect(p).toContain('Most conversations contain nothing worth saving')
    expect(p).toContain('at most 3 new items per extraction')
    expect(p).toContain('## Never save')
    expect(p).toContain('Transient state or mood')
  })

  it('声明输出语言跟随用户消息语言，而非固定中文', () => {
    const p = buildExtractionPrompt([])
    expect(p.toLowerCase()).toContain('the output language follows the user')
  })
})

describe('employee-memory-prompts / buildConsolidationPrompt', () => {
  it('陈旧阈值来自 STALE_MEMORY_DAYS 常量', () => {
    expect(buildConsolidationPrompt('MEM')).toContain(`unused for more than ${STALE_MEMORY_DAYS} days`)
  })

  it('总量目标与软目标常量一致，且低于触发阈值以留缓冲', () => {
    const p = buildConsolidationPrompt('MEM')
    expect(p).toContain(`within ${MEMORY_CONSOLIDATION_TARGET_COUNT} items / ${MEMORY_CONSOLIDATION_TARGET_CHARS} characters`)
    // 软目标必须低于触发阈值，否则整理后仍会立即再次触发整理
    expect(MEMORY_CONSOLIDATION_TARGET_COUNT).toBeLessThan(MEMORY_MAX_COUNT)
    expect(MEMORY_CONSOLIDATION_TARGET_CHARS).toBeLessThan(MEMORY_MAX_CHARS)
  })

  it('记忆文本原样嵌入，空文本也能生成模板', () => {
    expect(buildConsolidationPrompt('- 用户偏好简洁回复')).toContain('- 用户偏好简洁回复')
    const empty = buildConsolidationPrompt('')
    expect(empty).toContain('merge_groups')
    expect(empty).toContain('importance_updates')
  })

  it('pinned 保护与关键细节保留约束存在', () => {
    const p = buildConsolidationPrompt('')
    expect(p).toContain('Memories marked pinned(pin:1) must not be deleted')
    expect(p).toContain('Never drop a qualifying condition or parallel requirement')
  })
})
