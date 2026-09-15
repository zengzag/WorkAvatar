import { describe, it, expect } from 'vitest'
import {
  buildEmployeeSystemPrompt,
  buildCapabilitiesPrompt,
  buildDelegationPrompt,
  buildStableContextMessageContent,
  buildTaskContextMessageContent,
  STABLE_CONTEXT_MSG_PREFIX,
  TASK_CONTEXT_MSG_PREFIX,
  CONTEXT_MSG_FOOTER,
} from '../../../electron/main/services/agent/business/prompts'

/** 补充 prompts.ts 的边界用例（基础用例见 prompts.test.ts） */

describe('agent/business/prompts / buildEmployeeSystemPrompt 边界', () => {
  it('minimalMode 缺省 role/instructions 时只保留身份行', () => {
    const p = buildEmployeeSystemPrompt({ name: '小王', instructions: '', minimalMode: true })
    expect(p.split('\n')).toEqual(['[IDENTITY] 你是一名数字员工，称呼为 小王。'])
  })

  it('minimalMode 下 role 为空串时不输出角色定位行', () => {
    const p = buildEmployeeSystemPrompt({ name: 'A', instructions: '指令', role: '', minimalMode: true })
    expect(p).not.toContain('角色定位')
    expect(p).toContain('自定义指令：指令')
  })

  it('指令按 trim 后长度判定：99 字为短指令，100 字为长指令', () => {
    const hasShortLine = (p: string) => p.split('\n').some(l => l.startsWith('角色说明：'))

    const short = buildEmployeeSystemPrompt({ name: 'A', instructions: 'x'.repeat(99) })
    expect(hasShortLine(short)).toBe(true)
    expect(short).not.toContain('[CUSTOM_ROLE]')

    const long = buildEmployeeSystemPrompt({ name: 'A', instructions: 'x'.repeat(100) })
    expect(long).toContain('[CUSTOM_ROLE]')
    expect(hasShortLine(long)).toBe(false)
  })

  it('纯空白指令（两侧空格）trim 后为空，不进入任何分支', () => {
    const p = buildEmployeeSystemPrompt({ name: 'A', instructions: `   ${'y'.repeat(200)}   ` })
    // 内容 trim 后仍有内容 → 走长指令分支
    expect(p).toContain('[CUSTOM_ROLE]')

    const blank = buildEmployeeSystemPrompt({ name: 'A', instructions: '      ' })
    expect(blank).not.toContain('角色说明：')
    expect(blank).not.toContain('[CUSTOM_ROLE]')
  })

  it('hasFileDelete 与 hasReportGeneratedFiles 可同时生效', () => {
    const p = buildEmployeeSystemPrompt({
      name: 'A',
      instructions: '',
      hasFileDelete: true,
      hasReportGeneratedFiles: true,
    })
    expect(p).toContain('file_delete')
    expect(p).toContain('report_generated_files')
  })

  it('workspaceGuidance 为空串/null 时不输出 [CONTEXT] 段', () => {
    expect(buildEmployeeSystemPrompt({ name: 'A', instructions: '', workspaceGuidance: '' })).not.toContain('[CONTEXT]')
    expect(buildEmployeeSystemPrompt({ name: 'A', instructions: '' }).includes('[CONTEXT]')).toBe(false)
  })

  it('长指令 + workspaceGuidance 时顺序为 RULES → CUSTOM_ROLE → CONTEXT → RULES_REPEAT', () => {
    const p = buildEmployeeSystemPrompt({
      name: 'A',
      instructions: 'z'.repeat(120),
      workspaceGuidance: 'W',
    })
    expect(p.indexOf('[RULES]')).toBeLessThan(p.indexOf('[CUSTOM_ROLE]'))
    expect(p.indexOf('[CUSTOM_ROLE]')).toBeLessThan(p.indexOf('[CONTEXT]'))
    expect(p.indexOf('[CONTEXT]')).toBeLessThan(p.indexOf('[RULES_REPEAT]'))
  })

  it('员工名含 Unicode/特殊字符时原样锚定', () => {
    const p = buildEmployeeSystemPrompt({ name: '小王·AI 🤖', instructions: '' })
    expect(p).toContain('[IDENTITY] 你是一名数字员工，称呼为 小王·AI 🤖。')
  })

  it('超长指令（10000 字）完整写入且不截断', () => {
    const long = 'q'.repeat(10000)
    const p = buildEmployeeSystemPrompt({ name: 'A', instructions: long })
    expect(p).toContain(long)
  })
})

describe('agent/business/prompts / buildCapabilitiesPrompt 边界', () => {
  it('仅有按需工具时不声明技能', () => {
    const p = buildCapabilitiesPrompt({ onDemandToolList: 'kms_search' })!
    expect(p).toContain('按需工具：【kms_search】')
    expect(p).not.toContain('activate_skill')
  })

  it('仅有技能时不声明按需工具', () => {
    const p = buildCapabilitiesPrompt({ hasSkills: true })!
    expect(p).toContain('activate_skill')
    expect(p).not.toContain('按需工具：')
  })

  it('空字符串工具清单不产生按需工具行', () => {
    expect(buildCapabilitiesPrompt({ onDemandToolList: '' })).toBeUndefined()
  })

  it('输出以 [CAPABILITIES] 开头且两段均为独立行', () => {
    const p = buildCapabilitiesPrompt({ onDemandToolList: 'a, b', hasSkills: true })!
    const lines = p.split('\n')
    expect(lines[0]).toBe('[CAPABILITIES] 能力索引：')
    expect(lines).toHaveLength(3)
  })
})

describe('agent/business/prompts / buildDelegationPrompt 边界', () => {
  it('描述与角色均缺失时行尾无冒号', () => {
    const p = buildDelegationPrompt([{ id: 'e1', name: 'A' }])!
    expect(p).toContain('- A (id=e1)')
    expect(p).not.toContain('- A (id=e1)：')
  })

  it('描述为空串且角色也为空串时同样回退为空', () => {
    const p = buildDelegationPrompt([{ id: 'e1', name: 'A', description: '', role: '  ' }])!
    expect(p.split('\n')[2]).toBe('- A (id=e1)')
  })

  it('多个员工保持传入顺序，且限制说明固定输出', () => {
    const p = buildDelegationPrompt([
      { id: 'b', name: '第二个' },
      { id: 'a', name: '第一个' },
    ])!
    expect(p.indexOf('第二个')).toBeLessThan(p.indexOf('第一个'))
    expect(p).toContain('委托深度上限 3 层')
    expect(p).toContain('追问轮数上限 5 轮')
    expect(p).toContain('不能委托给自己')
  })

  it('描述含换行/超长文本时原样注入', () => {
    const desc = '第一行\n第二行' + 'x'.repeat(500)
    const p = buildDelegationPrompt([{ id: 'e1', name: 'A', description: desc }])!
    expect(p).toContain(desc)
  })
})

describe('agent/business/prompts / 上下文消息构造边界', () => {
  it('仅 extras（无技能）时仍产出完整包裹', () => {
    const p = buildStableContextMessageContent({ extras: ['[CAPABILITIES] x'] })!
    expect(p.startsWith(STABLE_CONTEXT_MSG_PREFIX)).toBe(true)
    expect(p.endsWith(CONTEXT_MSG_FOOTER)).toBe(true)
    expect(p).toContain('[CAPABILITIES] x')
  })

  it('extras 中的空值被过滤，非空块保持顺序', () => {
    const p = buildStableContextMessageContent({ extras: ['', 'A', undefined as any, 'B'] })!
    expect(p.indexOf('A')).toBeLessThan(p.indexOf('B'))
    expect(p.split('\n')).toEqual([STABLE_CONTEXT_MSG_PREFIX, 'A', 'B', CONTEXT_MSG_FOOTER])
  })

  it('全部为空时返回 undefined（含仅空 extras 数组）', () => {
    expect(buildStableContextMessageContent({ skillsPrompt: '', extras: [] })).toBeUndefined()
    expect(buildStableContextMessageContent({ extras: ['', '  '] })).toContain('  ')
  })

  it('任务上下文只传单个块时也包裹前缀与结尾', () => {
    const p = buildTaskContextMessageContent({ kbContextPrompt: 'K' })!
    expect(p.split('\n')).toEqual([TASK_CONTEXT_MSG_PREFIX, '<knowledge_scope>K</knowledge_scope>', CONTEXT_MSG_FOOTER])
  })

  it('任务上下文四块齐全且全为空串时返回 undefined', () => {
    expect(buildTaskContextMessageContent({})).toBeUndefined()
    expect(buildTaskContextMessageContent({
      workspaceContextPrompt: '',
      taskTimePrompt: '',
      memoryPrompt: '',
      kbContextPrompt: '',
    })).toBeUndefined()
  })

  it('两处上下文前缀互不相同（供前端区分消息类型）', () => {
    expect(STABLE_CONTEXT_MSG_PREFIX).not.toBe(TASK_CONTEXT_MSG_PREFIX)
    expect(STABLE_CONTEXT_MSG_PREFIX).toContain('数字员工能力信息')
    expect(TASK_CONTEXT_MSG_PREFIX).toContain('本次任务信息')
  })
})
