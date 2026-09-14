import { describe, it, expect } from 'vitest'
import {
  buildEmployeeSystemPrompt,
  buildCapabilitiesPrompt,
  buildDelegationPrompt,
  STABLE_CONTEXT_MSG_PREFIX,
  TASK_CONTEXT_MSG_PREFIX,
  CONTEXT_MSG_FOOTER,
  buildStableContextMessageContent,
  buildTaskContextMessageContent,
} from '../../../electron/main/services/agent/business/prompts'

describe('agent/business/prompts / buildEmployeeSystemPrompt', () => {
  it('包含身份锚定与核心规则', () => {
    const p = buildEmployeeSystemPrompt({ name: '小王', instructions: '' })
    expect(p).toContain('[IDENTITY]')
    expect(p).toContain('小王')
    expect(p).toContain('[RULES]')
    expect(p).toContain('[RULES_REPEAT]')
  })

  it('minimalMode 仅保留身份/角色/指令', () => {
    const p = buildEmployeeSystemPrompt({ name: '小王', instructions: '自定义', role: '测试', minimalMode: true })
    expect(p).toContain('小王')
    expect(p).toContain('自定义')
    expect(p).toContain('角色定位：测试')
    expect(p).not.toContain('[RULES]')
  })

  it('短指令（<100 字）跟在身份后', () => {
    const p = buildEmployeeSystemPrompt({ name: 'A', instructions: '短指令' })
    expect(p.indexOf('角色说明：短指令')).toBeLessThan(p.indexOf('[RULES]'))
  })

  it('长指令（>=100 字）放在 RULES 之后独立段', () => {
    const long = 'x'.repeat(120)
    const p = buildEmployeeSystemPrompt({ name: 'A', instructions: long })
    expect(p).toContain('[CUSTOM_ROLE]')
    expect(p.indexOf('[CUSTOM_ROLE]')).toBeGreaterThan(p.indexOf('[RULES]'))
  })

  it('hasReportGeneratedFiles 时包含 report 工具指引', () => {
    const withFlag = buildEmployeeSystemPrompt({ name: 'A', instructions: '', hasReportGeneratedFiles: true })
    const without = buildEmployeeSystemPrompt({ name: 'A', instructions: '' })
    expect(withFlag).toContain('report_generated_files')
    expect(without).not.toContain('report_generated_files')
  })

  it('hasFileDelete 时包含"删除必须走 file_delete"规则', () => {
    const withFlag = buildEmployeeSystemPrompt({ name: 'A', instructions: '', hasFileDelete: true })
    const without = buildEmployeeSystemPrompt({ name: 'A', instructions: '' })
    expect(withFlag).toContain('file_delete')
    expect(withFlag).toContain('禁止')
    expect(without).not.toContain('file_delete')
  })

  it('workspaceGuidance 注入 [CONTEXT] 段', () => {
    const p = buildEmployeeSystemPrompt({ name: 'A', instructions: '', workspaceGuidance: '工作区说明' })
    expect(p).toContain('[CONTEXT]')
    expect(p).toContain('工作区说明')
  })

  it('边界：恰好 100 字的指令按长指令处理', () => {
    const p = buildEmployeeSystemPrompt({ name: 'A', instructions: 'y'.repeat(100) })
    expect(p).toContain('[CUSTOM_ROLE]')
  })
})

describe('agent/business/prompts / buildCapabilitiesPrompt', () => {
  it('无内容返回 undefined', () => {
    expect(buildCapabilitiesPrompt({})).toBeUndefined()
    expect(buildCapabilitiesPrompt({ hasSkills: false })).toBeUndefined()
  })

  it('按需工具 + 技能声明', () => {
    const p = buildCapabilitiesPrompt({ onDemandToolList: 'a, b', hasSkills: true })
    expect(p).toContain('[CAPABILITIES]')
    expect(p).toContain('list_available_tools')
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
    ])
    expect(p).toContain('- 写作员 (id=e1)：擅长写作')
    expect(p).toContain('- 无描述 (id=e2)：数据分析')
    expect(p).toContain('delegate_to_employee')
    expect(p).toContain('launch_agents')
    expect(p).toContain('followup_delegation')
  })

  it('空白描述回退到角色', () => {
    const p = buildDelegationPrompt([{ id: 'e1', name: 'A', description: '   ' }])
    expect(p).toContain('- A (id=e1)\n')
  })
})

describe('agent/business/prompts / 上下文消息构造', () => {
  it('buildStableContextMessageContent 空内容返回 undefined', () => {
    expect(buildStableContextMessageContent({})).toBeUndefined()
    expect(buildStableContextMessageContent({ skillsPrompt: '', extras: ['', ''] })).toBeUndefined()
  })

  it('稳定上下文：前缀 + 块 + 结尾', () => {
    const p = buildStableContextMessageContent({ skillsPrompt: '<skills/>', extras: ['[CAPABILITIES] x'] })
    expect(p).toContain(STABLE_CONTEXT_MSG_PREFIX)
    expect(p).toContain('<skills/>')
    expect(p).toContain('[CAPABILITIES] x')
    expect(p).toContain(CONTEXT_MSG_FOOTER)
  })

  it('任务上下文：四种块按固定顺序包裹标签', () => {
    const p = buildTaskContextMessageContent({
      workspaceContextPrompt: 'W',
      taskTimePrompt: 'T',
      memoryPrompt: 'M',
      kbContextPrompt: 'K',
    })
    expect(p).toContain(TASK_CONTEXT_MSG_PREFIX)
    expect(p).toContain('<workspace>W</workspace>')
    expect(p).toContain('<task_time>T</task_time>')
    expect(p).toContain('<memory>M</memory>')
    expect(p).toContain('<knowledge_scope>K</knowledge_scope>')
    expect(p.indexOf('<workspace>')).toBeLessThan(p.indexOf('<task_time>'))
    expect(p.indexOf('<task_time>')).toBeLessThan(p.indexOf('<memory>'))
    expect(p.indexOf('<memory>')).toBeLessThan(p.indexOf('<knowledge_scope>'))
  })

  it('部分块缺失时仅包含存在的块', () => {
    const p = buildTaskContextMessageContent({ memoryPrompt: 'M' })
    expect(p).toContain('<memory>M</memory>')
    expect(p).not.toContain('<workspace>')
  })
})
