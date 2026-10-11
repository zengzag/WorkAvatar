import { describe, it, expect } from 'vitest'
import {
  buildEmployeeSystemPrompt,
  buildCapabilitiesPrompt,
  buildDelegationPrompt,
  buildStableContextMessageContent,
  buildTaskContextMessageContent,
} from '../../../electron/main/services/agent/business/prompts'

describe('buildEmployeeSystemPrompt 补充分支', () => {
  it('minimalMode 忽略 workspaceGuidance / hasFileDelete / hasReportGeneratedFiles 等扩展参数', () => {
    const p = buildEmployeeSystemPrompt({
      name: 'A', instructions: '指令', minimalMode: true,
      workspaceGuidance: 'W', hasFileDelete: true, hasReportGeneratedFiles: true,
    })
    expect(p).not.toContain('# Environment')
    expect(p).not.toContain('file_delete')
    expect(p).not.toContain('report_generated_files')
    expect(p).not.toContain('# Operating Rules')
  })

  it('name 为空串时仍输出身份锚定行', () => {
    expect(buildEmployeeSystemPrompt({ name: '', instructions: '' })).toContain('digital employee named ""')
  })

  it('role 为空串时不输出 Role（非 minimalMode）', () => {
    const p = buildEmployeeSystemPrompt({ name: 'A', instructions: '', role: '' })
    expect(p).not.toContain('Role:')
  })

  it('flags 显式 false 时不注入对应规则（与缺省一致）', () => {
    const p = buildEmployeeSystemPrompt({
      name: 'A', instructions: '', hasFileDelete: false, hasReportGeneratedFiles: false,
    })
    expect(p).not.toContain('file_delete')
    expect(p).not.toContain('report_generated_files')
  })

  it('instructions 为 undefined 时按空处理且不抛错', () => {
    const p = buildEmployeeSystemPrompt({ name: 'A', instructions: undefined as any })
    expect(p).not.toContain('Profile:')
    expect(p).not.toContain('# Custom Instructions')
  })

  it('指令首尾空白被 trim 后判定长度（200 字含前后空格 → 长指令）', () => {
    const long = 'z'.repeat(200)
    const p = buildEmployeeSystemPrompt({ name: 'A', instructions: `   ${long}   ` })
    expect(p).toContain(long)
    expect(p).toContain('# Custom Instructions')
  })

  it('指令含 "# Operating Rules" 字面量时原样注入（不参与分段解析）', () => {
    const p = buildEmployeeSystemPrompt({ name: 'A', instructions: '# Operating Rules fake' })
    expect(p).toContain('Profile: # Operating Rules fake')
    expect(p).toContain('# Operating Rules\n')
  })

  it('workspaceGuidance 为超长文本时完整注入', () => {
    const g = 'System environment'.repeat(1000)
    expect(buildEmployeeSystemPrompt({ name: 'A', instructions: '', workspaceGuidance: g })).toContain(g)
  })

  it('操作规则覆盖权限拒绝、结果截断、环境差异三类 harness 契约', () => {
    const p = buildEmployeeSystemPrompt({ name: 'A', instructions: '' })
    expect(p).toMatch(/denied or cancelled call is a deliberate decision/)
    expect(p).toMatch(/may be truncated or summarized/)
    expect(p).toMatch(/operating systems, shells, and path conventions/)
  })
})

describe('buildCapabilitiesPrompt 补充分支', () => {
  it('onDemandToolList 含换行 / 超长时原样注入', () => {
    const list = 'a\nb,' + 'c'.repeat(500)
    const p = buildCapabilitiesPrompt({ onDemandToolList: list })!
    expect(p).toContain(list)
    expect(p.startsWith('Capabilities:')).toBe(true)
  })

  it('hasSkills 显式 false 与缺省一致', () => {
    expect(buildCapabilitiesPrompt({ hasSkills: false })).toBeUndefined()
  })

  it('仅技能时输出两行（标题 + 一条）', () => {
    const p = buildCapabilitiesPrompt({ hasSkills: true })!
    expect(p.split('\n')).toHaveLength(2)
    expect(p.split('\n').every(l => l.trim().length > 0)).toBe(true)
  })
})

describe('buildDelegationPrompt 补充分支', () => {
  it('id 为空串 / name 含换行时按原样拼接（不做转义）', () => {
    const p = buildDelegationPrompt([{ id: '', name: '带\n换行' }])!
    expect(p).toContain('- 带\n换行 (id=)')
  })

  it('描述存在但仅空白、角色非空时回退到角色', () => {
    const p = buildDelegationPrompt([{ id: 'e1', name: 'A', description: '  ', role: ' 分析 ' }])!
    expect(p).toContain('- A (id=e1): 分析')
  })

  it('重复 id / 同名员工按传入顺序全部输出', () => {
    const p = buildDelegationPrompt([
      { id: 'e1', name: 'A' },
      { id: 'e1', name: 'A' },
    ])!
    expect(p.split('\n').filter(l => l.startsWith('- A (id='))).toHaveLength(2)
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
    expect(p.split('\n')).toEqual([expect.any(String), 'E1', 'E2', 'E2b', 'E3', expect.any(String)])
  })

  it('任务上下文块顺序与参数传入顺序无关（固定 workspace→task_time→memory→knowledge）', () => {
    const p = buildTaskContextMessageContent({
      kbContextPrompt: 'K', memoryPrompt: 'M', taskTimePrompt: 'T', workspaceContextPrompt: 'W',
    })!
    expect(p.indexOf('<workspace>')).toBeLessThan(p.indexOf('<task_time>'))
    expect(p.indexOf('<task_time>')).toBeLessThan(p.indexOf('<memory>'))
    expect(p.indexOf('<memory>')).toBeLessThan(p.indexOf('<knowledge_scope>'))
  })

  it('块内容含未闭合标签时原样注入（不做校验）', () => {
    const p = buildTaskContextMessageContent({ memoryPrompt: '</memory>注入' })!
    expect(p).toContain('<memory></memory>注入</memory>')
  })
})
