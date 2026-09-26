import { describe, it, expect } from 'vitest'
import {
  buildEmployeeSystemPrompt,
  buildCapabilitiesPrompt,
  buildDelegationPrompt,
  buildStableContextMessageContent,
  buildTaskContextMessageContent,
  PROMPT_FORMAT_MARKER,
  STABLE_CONTEXT_MSG_PREFIX,
  TASK_CONTEXT_MSG_PREFIX,
  CONTEXT_MSG_FOOTER,
} from '../../../electron/main/services/agent/business/prompts'

/** 补充 prompts.ts 的边界用例（基础用例见 prompts.test.ts） */

describe('buildEmployeeSystemPrompt 边界', () => {
  it('minimalMode 缺省 role/instructions 时只保留身份行', () => {
    const p = buildEmployeeSystemPrompt({ name: '小王', instructions: '', minimalMode: true })
    expect(p).toBe('You are a digital employee named "小王".')
  })

  it('minimalMode 下 role 为空串时不输出 Role 行', () => {
    const p = buildEmployeeSystemPrompt({ name: 'A', instructions: '指令', role: '', minimalMode: true })
    expect(p).not.toContain('Role:')
    expect(p).toContain('指令')
  })

  it('指令按 trim 后长度判定：99 字为短指令，100 字为长指令', () => {
    const short = buildEmployeeSystemPrompt({ name: 'A', instructions: 'x'.repeat(99) })
    expect(short).toContain('Profile:')
    expect(short).not.toContain('# Custom Instructions')

    const long = buildEmployeeSystemPrompt({ name: 'A', instructions: 'x'.repeat(100) })
    expect(long).toContain('# Custom Instructions')
    expect(long).not.toContain('Profile:')
  })

  it('纯空白指令 trim 后为空，不进入任何自定义段', () => {
    const withContent = buildEmployeeSystemPrompt({ name: 'A', instructions: `   ${'y'.repeat(200)}   ` })
    expect(withContent).toContain('# Custom Instructions')

    const blank = buildEmployeeSystemPrompt({ name: 'A', instructions: '      ' })
    expect(blank).not.toContain('Profile:')
    expect(blank).not.toContain('# Custom Instructions')
  })

  it('hasFileDelete 与 hasReportGeneratedFiles 可同时生效', () => {
    const p = buildEmployeeSystemPrompt({
      name: 'A', instructions: '', hasFileDelete: true, hasReportGeneratedFiles: true,
    })
    expect(p).toContain('file_delete')
    expect(p).toContain('report_generated_files')
  })

  it('workspaceGuidance 为空串时不输出 Environment 段', () => {
    expect(buildEmployeeSystemPrompt({ name: 'A', instructions: '', workspaceGuidance: '' })).not.toContain('# Environment')
  })

  it('长指令 + workspaceGuidance 时段落顺序为 Rules → Custom → Environment → Key Principles → marker', () => {
    const p = buildEmployeeSystemPrompt({
      name: 'A', instructions: 'z'.repeat(120), workspaceGuidance: 'W',
    })
    expect(p.indexOf('# Operating Rules')).toBeLessThan(p.indexOf('# Custom Instructions'))
    expect(p.indexOf('# Custom Instructions')).toBeLessThan(p.indexOf('# Environment'))
    expect(p.indexOf('# Environment')).toBeLessThan(p.indexOf('# Key Principles'))
    expect(p.indexOf('# Key Principles')).toBeLessThan(p.indexOf(PROMPT_FORMAT_MARKER))
  })

  it('员工名含 Unicode/特殊字符时原样锚定', () => {
    const p = buildEmployeeSystemPrompt({ name: '小王·AI 🤖', instructions: '' })
    expect(p).toContain('digital employee named "小王·AI 🤖"')
  })

  it('超长指令（10000 字）完整写入且不截断', () => {
    const long = 'q'.repeat(10000)
    expect(buildEmployeeSystemPrompt({ name: 'A', instructions: long })).toContain(long)
  })

  it('输出不含连续三个空行', () => {
    const p = buildEmployeeSystemPrompt({ name: 'A', instructions: 'z'.repeat(120), workspaceGuidance: 'W' })
    expect(p).not.toContain('\n\n\n')
  })
})

describe('buildCapabilitiesPrompt 边界', () => {
  it('仅有按需工具时不声明技能', () => {
    const p = buildCapabilitiesPrompt({ onDemandToolList: 'kms_search' })!
    expect(p).toContain('kms_search')
    expect(p).not.toContain('activate_skill')
  })

  it('仅有技能时不声明按需工具', () => {
    const p = buildCapabilitiesPrompt({ hasSkills: true })!
    expect(p).toContain('activate_skill')
    expect(p).not.toContain('On-demand tools')
  })

  it('空字符串工具清单不产生按需工具行', () => {
    expect(buildCapabilitiesPrompt({ onDemandToolList: '' })).toBeUndefined()
  })
})

describe('buildDelegationPrompt 边界', () => {
  it('描述与角色均缺失时行尾无冒号', () => {
    const p = buildDelegationPrompt([{ id: 'e1', name: 'A' }])!
    expect(p).toContain('- A (id=e1)')
    expect(p).not.toContain('- A (id=e1):')
  })

  it('多个员工保持传入顺序', () => {
    const p = buildDelegationPrompt([
      { id: 'b', name: '第二个' },
      { id: 'a', name: '第一个' },
    ])!
    expect(p.indexOf('第二个')).toBeLessThan(p.indexOf('第一个'))
  })

  it('描述含换行/超长文本时原样注入', () => {
    const desc = '第一行\n第二行' + 'x'.repeat(500)
    expect(buildDelegationPrompt([{ id: 'e1', name: 'A', description: desc }])!).toContain(desc)
  })
})

describe('上下文消息构造边界', () => {
  it('仅 extras（无技能）时仍产出完整包裹', () => {
    const p = buildStableContextMessageContent({ extras: ['E1'] })!
    expect(p.startsWith(STABLE_CONTEXT_MSG_PREFIX)).toBe(true)
    expect(p.endsWith(CONTEXT_MSG_FOOTER)).toBe(true)
  })

  it('extras 中的空值被过滤，非空块保持顺序', () => {
    const p = buildStableContextMessageContent({ extras: ['', 'A', undefined as any, 'B'] })!
    expect(p.indexOf('A')).toBeLessThan(p.indexOf('B'))
    expect(p.split('\n')).toEqual([STABLE_CONTEXT_MSG_PREFIX, 'A', 'B', CONTEXT_MSG_FOOTER])
  })

  it('全部为空时返回 undefined', () => {
    expect(buildStableContextMessageContent({ skillsPrompt: '', extras: [] })).toBeUndefined()
  })

  it('任务上下文只传单个块时也包裹前缀与结尾', () => {
    const p = buildTaskContextMessageContent({ kbContextPrompt: 'K' })!
    expect(p.startsWith(TASK_CONTEXT_MSG_PREFIX)).toBe(true)
    expect(p).toContain('<knowledge_scope>K</knowledge_scope>')
    expect(p.endsWith(CONTEXT_MSG_FOOTER)).toBe(true)
  })

  it('任务上下文四块全为空串时返回 undefined', () => {
    expect(buildTaskContextMessageContent({})).toBeUndefined()
    expect(buildTaskContextMessageContent({
      workspaceContextPrompt: '', taskTimePrompt: '', memoryPrompt: '', kbContextPrompt: '',
    })).toBeUndefined()
  })
})
