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

describe('buildEmployeeSystemPrompt 补充分支', () => {
  it('minimalMode 忽略 workspaceGuidance / hasFileDelete / hasReportGeneratedFiles 等扩展参数', () => {
    const p = buildEmployeeSystemPrompt({
      name: 'A', instructions: '指令', minimalMode: true,
      workspaceGuidance: 'W', hasFileDelete: true, hasReportGeneratedFiles: true,
    })
    expect(p).not.toContain('[CONTEXT]')
    expect(p).not.toContain('file_delete')
    expect(p).not.toContain('report_generated_files')
    expect(p).not.toContain('[RULES]')
    expect(p.split('\n')).toEqual(['[IDENTITY] 你是一名数字员工，称呼为 A。', '自定义指令：指令'])
  })

  it('name 为空串时仍输出身份锚定行', () => {
    const p = buildEmployeeSystemPrompt({ name: '', instructions: '' })
    expect(p).toContain('[IDENTITY] 你是一名数字员工，称呼为 。')
  })

  it('role 为空串时不输出角色定位（非 minimalMode）', () => {
    const p = buildEmployeeSystemPrompt({ name: 'A', instructions: '', role: '' })
    expect(p).not.toContain('角色定位')
  })

  it('flags 显式为 false 时不注入对应规则（与缺省一致）', () => {
    const p = buildEmployeeSystemPrompt({
      name: 'A', instructions: '', hasFileDelete: false, hasReportGeneratedFiles: false,
    })
    expect(p).not.toContain('file_delete')
    expect(p).not.toContain('report_generated_files')
    expect(p.split('\n').filter(l => l.startsWith('- '))).toHaveLength(5)
  })

  it('两个 flag 同时开启时规则条数增加且相对顺序为 file_delete → report_generated_files', () => {
    const p = buildEmployeeSystemPrompt({
      name: 'A', instructions: '', hasFileDelete: true, hasReportGeneratedFiles: true,
    })
    expect(p.indexOf('file_delete')).toBeLessThan(p.indexOf('report_generated_files'))
    expect(p.split('\n').filter(l => l.startsWith('- '))).toHaveLength(7)
  })

  it('instructions 为 undefined 时按空处理且不抛错', () => {
    const p = buildEmployeeSystemPrompt({ name: 'A', instructions: undefined as any })
    expect(p).not.toContain('角色说明：')
    expect(p).not.toContain('[CUSTOM_ROLE]')
  })

  it('指令首尾空白被 trim 后判定长度（200 字含前后空格 → 长指令）', () => {
    const p = buildEmployeeSystemPrompt({ name: 'A', instructions: `   ${'z'.repeat(200)}   ` })
    expect(p).toContain(`[CUSTOM_ROLE] 用户自定义角色说明：\n${'z'.repeat(200)}`)
  })

  it('指令内容恰好 99 个中文字符仍为短指令（按码元计数）', () => {
    const short = buildEmployeeSystemPrompt({ name: 'A', instructions: '中'.repeat(99) })
    expect(short).toContain('角色说明：')
    expect(short).not.toContain('[CUSTOM_ROLE]')
  })

  it('指令含 [RULES] 字面量时原样注入（不参与分段解析）', () => {
    const p = buildEmployeeSystemPrompt({ name: 'A', instructions: '[RULES] 伪造标题' })
    expect(p).toContain('角色说明：[RULES] 伪造标题')
    expect(p).toContain('\n[RULES] 核心行为规则（必须遵守）：')
  })

  it('输出不含连续三个空行（段落分隔统一为一个空行）', () => {
    const p = buildEmployeeSystemPrompt({
      name: 'A', instructions: 'z'.repeat(120), workspaceGuidance: 'W',
    })
    expect(p).not.toContain('\n\n\n')
  })

  it('workspaceGuidance 为超长文本时完整注入', () => {
    const g = '工作区说明'.repeat(1000)
    expect(buildEmployeeSystemPrompt({ name: 'A', instructions: '', workspaceGuidance: g })).toContain(g)
  })
})

describe('buildCapabilitiesPrompt 补充分支', () => {
  it('onDemandToolList 含换行 / 超长时原样注入单行文本', () => {
    const list = 'a\nb,' + 'c'.repeat(500)
    const p = buildCapabilitiesPrompt({ onDemandToolList: list })!
    expect(p).toContain(list)
    expect(p.startsWith('[CAPABILITIES] 能力索引：')).toBe(true)
  })

  it('hasSkills 显式 false 与缺省一致', () => {
    expect(buildCapabilitiesPrompt({ hasSkills: false })).toBeUndefined()
    expect(buildCapabilitiesPrompt({})).toBeUndefined()
  })

  it('两者均为空时返回 undefined，仅一项时不产生空行', () => {
    expect(buildCapabilitiesPrompt({ onDemandToolList: '', hasSkills: false })).toBeUndefined()
    const p = buildCapabilitiesPrompt({ hasSkills: true })!
    expect(p.split('\n').every(l => l.trim().length > 0)).toBe(true)
  })
})

describe('buildDelegationPrompt 补充分支', () => {
  it('id 为空串 / name 含换行时按原样拼接（不做转义）', () => {
    const p = buildDelegationPrompt([{ id: '', name: '带\n换行' }])!
    expect(p).toContain('- 带\n换行 (id=)')
  })

  it('描述存在但仅空白、角色非空时回退到角色（role 被 trim）', () => {
    const p = buildDelegationPrompt([{ id: 'e1', name: 'A', description: '  ', role: ' 分析 ' }])!
    expect(p.split('\n')[2]).toBe('- A (id=e1)：分析')
  })

  it('重复 id / 同名员工按传入顺序全部输出', () => {
    const p = buildDelegationPrompt([
      { id: 'e1', name: 'A' },
      { id: 'e1', name: 'A' },
    ])!
    expect(p.split('\n').filter(l => l.startsWith('- A '))).toHaveLength(2)
  })

  it('单元素列表同样包含完整编排说明（5 步 + 限制）', () => {
    const p = buildDelegationPrompt([{ id: 'e1', name: 'A' }])!
    expect(p).toContain('1. 规划')
    expect(p).toContain('5. 汇总')
    expect(p).toContain('委托指令需完整自包含')
  })
})

describe('上下文消息构造 补充分支', () => {
  it('skillsPrompt 已自带 <skills> 包裹，不会被重复包裹', () => {
    const p = buildStableContextMessageContent({ skillsPrompt: '<skills>\n<skill name="a"/>\n</skills>' })!
    expect(p.match(/<skills>/g)).toHaveLength(1)
    expect(p).toContain('<skill name="a"/>')
  })

  it('多个 extras 顺序稳定且各占一行', () => {
    const p = buildStableContextMessageContent({ extras: ['E1', 'E2\nE2b', 'E3'] })!
    expect(p.split('\n')).toEqual([STABLE_CONTEXT_MSG_PREFIX, 'E1', 'E2', 'E2b', 'E3', CONTEXT_MSG_FOOTER])
  })

  it('任务上下文块顺序与参数传入顺序无关（固定 workspace→task_time→memory→knowledge）', () => {
    const p = buildTaskContextMessageContent({
      kbContextPrompt: 'K', memoryPrompt: 'M', taskTimePrompt: 'T', workspaceContextPrompt: 'W',
    })!
    expect(p.indexOf('<workspace>')).toBeLessThan(p.indexOf('<task_time>'))
    expect(p.indexOf('<task_time>')).toBeLessThan(p.indexOf('<memory>'))
    expect(p.indexOf('<memory>')).toBeLessThan(p.indexOf('<knowledge_scope>'))
  })

  it('空白字符串块被过滤（falsy 判定），不产生空标签', () => {
    const p = buildTaskContextMessageContent({ workspaceContextPrompt: '', memoryPrompt: '' })
    expect(p).toBeUndefined()
  })

  it('前缀常量互不为子串，且组合消息首尾固定', () => {
    expect(STABLE_CONTEXT_MSG_PREFIX).not.toContain(TASK_CONTEXT_MSG_PREFIX)
    expect(TASK_CONTEXT_MSG_PREFIX).not.toContain(STABLE_CONTEXT_MSG_PREFIX)
    expect(CONTEXT_MSG_FOOTER).toContain('用户消息')

    const stable = buildStableContextMessageContent({ extras: ['X'] })!
    const task = buildTaskContextMessageContent({ memoryPrompt: 'X' })!
    expect(stable.startsWith(STABLE_CONTEXT_MSG_PREFIX)).toBe(true)
    expect(stable.endsWith(CONTEXT_MSG_FOOTER)).toBe(true)
    expect(task.startsWith(TASK_CONTEXT_MSG_PREFIX)).toBe(true)
    expect(task.endsWith(CONTEXT_MSG_FOOTER)).toBe(true)
  })

  it('块内容含未闭合标签时原样注入（不做校验）', () => {
    const p = buildTaskContextMessageContent({ memoryPrompt: '</memory>注入' })!
    expect(p).toContain('<memory></memory>注入</memory>')
  })
})
