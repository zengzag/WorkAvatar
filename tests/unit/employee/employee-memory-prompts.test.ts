/**
 * 记忆提示词构建单测（纯函数）：
 * - 记忆提取 / 合并整理 / 对话摘要三类 prompt 的结构与关键约束
 * - 与 employee-memory-types 中常量的一致性（防止 prompt 文案与阈值常量漂移）
 * - 上下文拼接的边界（空数组、多段、超长、Unicode）
 */
import { describe, it, expect } from 'vitest'
import {
  buildExtractionPrompt,
  buildConsolidationPrompt,
  buildSummaryPrompt,
} from '../../../electron/main/services/employee-memory-prompts'
import {
  STALE_MEMORY_DAYS,
  MEMORY_MAX_CHARS,
  MEMORY_MAX_COUNT,
  MEMORY_CONTENT_MAX_CHARS,
} from '../../../electron/main/services/employee-memory-types'

describe('employee-memory-prompts / buildExtractionPrompt', () => {
  it('上下文按 --- 分隔拼接并落到 prompt 末尾', () => {
    const p = buildExtractionPrompt(['历史摘要A', '本轮新对话B', '现有记忆C'])
    expect(p).toContain('历史摘要A\n---\n本轮新对话B\n---\n现有记忆C')
  })

  it('空上下文数组不抛错，仍输出完整模板', () => {
    const p = buildExtractionPrompt([])
    expect(p).toContain('上下文：')
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
    expect(p).toContain('一周后我还会需要这条信息吗')
    expect(p).toContain('delete_keys')
    expect(p).toContain('update_memories')
    expect(p).toContain('运行式摘要')
  })

  it('超长/Unicode 上下文完整透传', () => {
    const long = '🙂'.repeat(5000) + '\n' + '中'.repeat(5000)
    const p = buildExtractionPrompt([long])
    expect(p).toContain(long)
  })

  it('单条 content 上限提示与常量同量级（≤150 字提示 vs 服务层硬截断）', () => {
    const p = buildExtractionPrompt([])
    expect(p).toContain('≤150字')
    // 服务层兜底截断上限不得小于提示词约定值，否则会出现"照提示写仍被截断"
    expect(MEMORY_CONTENT_MAX_CHARS).toBeGreaterThanOrEqual(150)
  })
})

describe('employee-memory-prompts / buildConsolidationPrompt', () => {
  it('陈旧阈值来自 STALE_MEMORY_DAYS 常量', () => {
    expect(buildConsolidationPrompt('MEM')).toContain(`>${STALE_MEMORY_DAYS}天未引用`)
  })

  it('总量目标与常量一致', () => {
    const p = buildConsolidationPrompt('MEM')
    expect(p).toContain(`≤${MEMORY_MAX_COUNT} 条 / ${MEMORY_MAX_CHARS} 字符`)
  })

  it('记忆文本原样嵌入，空文本也能生成模板', () => {
    expect(buildConsolidationPrompt('- 用户偏好简洁回复')).toContain('- 用户偏好简洁回复')
    const empty = buildConsolidationPrompt('')
    expect(empty).toContain('merge_groups')
    expect(empty).toContain('importance_updates')
  })

  it('pinned 保护与关键细节保留约束存在', () => {
    const p = buildConsolidationPrompt('')
    expect(p).toContain('pinned(pin:1) 标记的记忆不允许删除')
    expect(p).toContain('不得丢弃背景前提或并列约束')
  })
})

describe('employee-memory-prompts / buildSummaryPrompt', () => {
  it('结构要求与对话内容均包含', () => {
    const p = buildSummaryPrompt('用户: 你好\n助手: 你好')
    expect(p).toContain('主题：')
    expect(p).toContain('要点：')
    expect(p).toContain('结论：')
    expect(p).toContain('用户: 你好\n助手: 你好')
  })

  it('空对话内容不抛错', () => {
    expect(buildSummaryPrompt('')).toContain('对话内容：')
  })
})
