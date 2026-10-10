import { describe, it, expect } from 'vitest'
import {
  buildEmployeeSystemPrompt,
  buildAssistantSystemPrompt,
  buildCapabilitiesPrompt,
  buildDelegationPrompt,
  PROMPT_FORMAT_MARKER,
  STABLE_CONTEXT_MSG_PREFIX,
  TASK_CONTEXT_MSG_PREFIX,
  CONTEXT_MSG_FOOTER,
  buildStableContextMessageContent,
  buildTaskContextMessageContent,
} from '../../../electron/main/services/agent/business/prompts'

describe('agent/business/prompts / buildEmployeeSystemPrompt', () => {
  it('完整模式包含身份锚定、操作规则与格式标记', () => {
    const p = buildEmployeeSystemPrompt({ name: '小王', instructions: '' })
    expect(p).toContain('digital employee named "小王"')
    expect(p).toContain('# Operating Rules')
    expect(p).toContain('# Key Principles')
    expect(p.trimEnd().endsWith(PROMPT_FORMAT_MARKER)).toBe(true)
  })

  it('完整模式声明与用户语言一致地回复', () => {
    const p = buildEmployeeSystemPrompt({ name: 'A', instructions: '' })
    expect(p).toMatch(/same primary language as the user's latest message/)
  })

  it('minimalMode 仅保留身份/角色/指令，不含规则段与格式标记', () => {
    const p = buildEmployeeSystemPrompt({ name: '小王', instructions: '自定义', role: '测试', minimalMode: true })
    expect(p).toContain('digital employee named "小王"')
    expect(p).toContain('Role: 测试')
    expect(p).toContain('自定义')
    expect(p).not.toContain('# Operating Rules')
    expect(p).not.toContain(PROMPT_FORMAT_MARKER)
  })

  it('短指令（<100 字）以 Profile 跟在身份后、规则段之前', () => {
    const p = buildEmployeeSystemPrompt({ name: 'A', instructions: '短指令' })
    expect(p).toContain('Profile: 短指令')
    expect(p.indexOf('Profile: 短指令')).toBeLessThan(p.indexOf('# Operating Rules'))
    expect(p).not.toContain('# Custom Instructions')
  })

  it('长指令（>=100 字）放在规则之后的 Custom Instructions 独立段', () => {
    const long = 'x'.repeat(120)
    const p = buildEmployeeSystemPrompt({ name: 'A', instructions: long })
    expect(p).toContain('# Custom Instructions')
    expect(p).toContain(long)
    expect(p.indexOf('# Operating Rules')).toBeLessThan(p.indexOf('# Custom Instructions'))
  })

  it('hasReportGeneratedFiles 时包含 report_generated_files 条款，否则不出现', () => {
    const withFlag = buildEmployeeSystemPrompt({ name: 'A', instructions: '', hasReportGeneratedFiles: true })
    const without = buildEmployeeSystemPrompt({ name: 'A', instructions: '' })
    expect(withFlag).toContain('report_generated_files')
    expect(without).not.toContain('report_generated_files')
  })

  it('hasFileDelete 时包含 file_delete 硬约束，否则不出现', () => {
    const withFlag = buildEmployeeSystemPrompt({ name: 'A', instructions: '', hasFileDelete: true })
    const without = buildEmployeeSystemPrompt({ name: 'A', instructions: '' })
    expect(withFlag).toContain('file_delete')
    expect(withFlag).toMatch(/Never delete via shell_exec/)
    expect(without).not.toContain('file_delete')
  })

  it('workspaceGuidance 注入 Environment 段', () => {
    const p = buildEmployeeSystemPrompt({ name: 'A', instructions: '', workspaceGuidance: 'System environment: Windows' })
    expect(p).toContain('# Environment')
    expect(p).toContain('System environment: Windows')
  })

  it('边界：恰好 100 字的指令按长指令处理', () => {
    const p = buildEmployeeSystemPrompt({ name: 'A', instructions: 'y'.repeat(100) })
    expect(p).toContain('# Custom Instructions')
    expect(p).not.toContain('Profile:')
  })
})

describe('agent/business/prompts / buildAssistantSystemPrompt', () => {
  it('默认助手身份 + 完整规则', () => {
    const p = buildAssistantSystemPrompt({ instructions: '' })
    expect(p).toContain('helpful AI assistant operating inside WorkAvatar')
    expect(p).toContain('# Operating Rules')
    expect(p.trimEnd().endsWith(PROMPT_FORMAT_MARKER)).toBe(true)
  })

  it('minimalMode 仅保留身份与指令', () => {
    const p = buildAssistantSystemPrompt({ instructions: 'be brief', minimalMode: true })
    expect(p.trim()).toBe('You are a helpful AI assistant.\nInstructions:\nbe brief')
    expect(p).not.toContain('# Operating Rules')
  })

  it('条款按工具注册情况条件渲染', () => {
    const p = buildAssistantSystemPrompt({ instructions: '', hasFileDelete: true })
    expect(p).toContain('file_delete')
    expect(p).not.toContain('report_generated_files')
  })

  it('长指令进入 Custom Instructions 段', () => {
    const long = 'z'.repeat(150)
    const p = buildAssistantSystemPrompt({ instructions: long })
    expect(p).toContain('# Custom Instructions')
    expect(p.indexOf('# Custom Instructions')).toBeGreaterThan(p.indexOf('# Operating Rules'))
  })
})

describe('agent/business/prompts / buildCapabilitiesPrompt', () => {
  it('无内容返回 undefined', () => {
    expect(buildCapabilitiesPrompt({})).toBeUndefined()
    expect(buildCapabilitiesPrompt({ hasSkills: false })).toBeUndefined()
  })

  it('按需工具 + 技能声明', () => {
    const p = buildCapabilitiesPrompt({ onDemandToolList: 'a, b', hasSkills: true })!
    expect(p).toContain('Capabilities:')
    expect(p).toContain('list_available_tools')
    expect(p).toContain('invoke_tool')
    expect(p).toContain('activate_skill')
  })
})

describe('agent/business/prompts / buildDelegationPrompt', () => {
  it('空列表返回 undefined', () => {
    expect(buildDelegationPrompt([])).toBeUndefined()
  })

  it('列表项含名称与 id，描述优先于角色', () => {
    const p = buildDelegationPrompt([
      { id: 'e1', name: '写作员', description: '擅长写作', role: '写手' },
      { id: 'e2', name: '无描述', role: '数据分析' },
    ])!
    expect(p).toContain('- 写作员 (id=e1): 擅长写作')
    expect(p).toContain('- 无描述 (id=e2): 数据分析')
    expect(p).toContain('delegate_to_employee')
    expect(p).toContain('launch_agents')
    expect(p).toContain('followup_delegation')
  })

  it('包含编排五步法与硬限制', () => {
    const p = buildDelegationPrompt([{ id: 'e1', name: 'A' }])!
    expect(p).toContain('1. Plan:')
    expect(p).toContain('5. Report:')
    expect(p).toContain('delegation depth is capped at 2')
    expect(p).toContain('capped at 5 follow-up turns')
    expect(p).toContain('never delegate to yourself')
  })

  it('委托能力显式关闭时整体不注入（即使传入了目标列表）', () => {
    expect(buildDelegationPrompt([{ id: 'e1', name: 'A' }], false)).toBeUndefined()
    expect(buildDelegationPrompt([], false, [{ id: 'p1', name: 'explore' }])).toBeUndefined()
  })

  it('可用子智能体模板以预置执行者候选列出', () => {
    const p = buildDelegationPrompt([], true, [{ id: 'p1', name: 'explore', description: '只读检索' }])!
    expect(p).toContain('Available sub-agent profiles')
    expect(p).toContain('- explore (id=p1): 只读检索')
  })
})

describe('agent/business/prompts / 上下文消息构造', () => {
  it('buildStableContextMessageContent 空内容返回 undefined', () => {
    expect(buildStableContextMessageContent({})).toBeUndefined()
    expect(buildStableContextMessageContent({ skillsPrompt: '', extras: ['', ''] })).toBeUndefined()
  })

  it('稳定上下文：英文前缀 + 块 + 结尾', () => {
    const p = buildStableContextMessageContent({ skillsPrompt: '<skills/>', extras: ['Capabilities:\n- x'] })!
    expect(p.startsWith(STABLE_CONTEXT_MSG_PREFIX)).toBe(true)
    expect(p).toContain('<skills/>')
    expect(p).toContain('Capabilities:')
    expect(p.endsWith(CONTEXT_MSG_FOOTER)).toBe(true)
  })

  it('任务上下文：四种块按固定顺序包裹标签', () => {
    const p = buildTaskContextMessageContent({
      workspaceContextPrompt: 'W',
      taskTimePrompt: 'T',
      memoryPrompt: 'M',
      kbContextPrompt: 'K',
    })!
    expect(p.startsWith(TASK_CONTEXT_MSG_PREFIX)).toBe(true)
    expect(p).toContain('<workspace>W</workspace>')
    expect(p).toContain('<task_time>T</task_time>')
    expect(p).toContain('<memory>M</memory>')
    expect(p).toContain('<knowledge_scope>K</knowledge_scope>')
    expect(p.indexOf('<workspace>')).toBeLessThan(p.indexOf('<task_time>'))
    expect(p.indexOf('<task_time>')).toBeLessThan(p.indexOf('<memory>'))
    expect(p.indexOf('<memory>')).toBeLessThan(p.indexOf('<knowledge_scope>'))
    expect(p.endsWith(CONTEXT_MSG_FOOTER)).toBe(true)
  })

  it('部分块缺失时仅包含存在的块', () => {
    const p = buildTaskContextMessageContent({ memoryPrompt: 'M' })!
    expect(p).toContain('<memory>M</memory>')
    expect(p).not.toContain('<workspace>')
  })

  it('两个前缀互不相同且均为非用户消息声明', () => {
    expect(STABLE_CONTEXT_MSG_PREFIX).not.toBe(TASK_CONTEXT_MSG_PREFIX)
    expect(STABLE_CONTEXT_MSG_PREFIX).toContain('not part of the user')
    expect(TASK_CONTEXT_MSG_PREFIX).toContain('not part of the user')
  })
})
