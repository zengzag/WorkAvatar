import { describe, it, expect, vi, beforeEach } from 'vitest'

const h = vi.hoisted(() => ({
  installed: [] as any[],
}))

vi.mock('../../../electron/main/services/skill-registry.service', () => ({
  default: { getInstance: () => ({ getInstalledSkills: () => h.installed }) },
}))

import { SkillManager } from '../../../electron/main/services/agent/skill-manager'

interface SkillRow {
  name: string
  description: string
  skillMdContent: string
  installPath: string
  is_enabled: boolean
  references: Array<{ name: string; content: string }>
}

const skill = (over: Partial<SkillRow> & { name: string }): SkillRow => ({
  description: `desc-${over.name}`,
  skillMdContent: `instructions-${over.name}`,
  installPath: `/skills/${over.name}`,
  is_enabled: true,
  references: [],
  ...over,
})

beforeEach(() => {
  h.installed = []
})

describe('agent/skill-manager / discoverSkills', () => {
  it('仅收集已启用技能；未启用技能被忽略', () => {
    h.installed = [
      skill({ name: 'a' }),
      skill({ name: 'b', is_enabled: false }),
    ]
    const mgr = new SkillManager()
    mgr.discoverSkills()
    expect(mgr.getSkillsXml()).toContain('name="a"')
    expect(mgr.getSkillsXml()).not.toContain('name="b"')
  })

  it('allowedSkillPaths 为白名单：仅保留 installPath 命中的技能', () => {
    h.installed = [
      skill({ name: 'a', installPath: '/skills/a' }),
      skill({ name: 'b', installPath: '/skills/b' }),
    ]
    const mgr = new SkillManager(['/skills/b'])
    mgr.discoverSkills()
    expect(mgr.getSkillsXml()).toContain('name="b"')
    expect(mgr.getSkillsXml()).not.toContain('name="a"')
  })

  it('allowedSkillPaths 为空数组时全部过滤；undefined 时不过滤', () => {
    h.installed = [skill({ name: 'a' })]
    const empty = new SkillManager([])
    empty.discoverSkills()
    expect(empty.getSkillsXml()).toBe('')

    const all = new SkillManager(undefined)
    all.discoverSkills()
    expect(all.getSkillsXml()).toContain('name="a"')
  })

  it('重复 discoverSkills 会清空上一次结果（幂等）', () => {
    h.installed = [skill({ name: 'a' })]
    const mgr = new SkillManager()
    mgr.discoverSkills()
    h.installed = [skill({ name: 'b' })]
    mgr.discoverSkills()
    const xml = mgr.getSkillsXml()
    expect(xml).toContain('name="b"')
    expect(xml).not.toContain('name="a"')
  })

  it('debugLog 输出发现数量；未传 debugLog 时不抛错', () => {
    h.installed = [skill({ name: 'a' }), skill({ name: 'b', is_enabled: false })]
    const log = vi.fn()
    new SkillManager(undefined, log).discoverSkills()
    expect(log).toHaveBeenCalledWith(expect.stringContaining('Discovered 1 skills'))
    expect(() => new SkillManager().discoverSkills()).not.toThrow()
  })

  it('registry 返回空列表时 XML 为空串', () => {
    const mgr = new SkillManager()
    mgr.discoverSkills()
    expect(mgr.getSkillsXml()).toBe('')
  })
})

describe('agent/skill-manager / getSkillsXml', () => {
  it('按发现顺序输出每个技能的 name/description', () => {
    h.installed = [skill({ name: 'a', description: 'DA' }), skill({ name: 'b', description: 'DB' })]
    const mgr = new SkillManager()
    mgr.discoverSkills()
    expect(mgr.getSkillsXml()).toBe('<skills>\n<skill name="a">DA</skill>\n<skill name="b">DB</skill>\n</skills>')
  })

  it('description 含换行 / 引号 / Unicode 时原样注入', () => {
    h.installed = [skill({ name: '写作"助手"', description: '第一行\n第二行 — 中文' })]
    const mgr = new SkillManager()
    mgr.discoverSkills()
    expect(mgr.getSkillsXml()).toContain('name="写作"助手""')
    expect(mgr.getSkillsXml()).toContain('第一行\n第二行 — 中文')
  })
})

describe('agent/skill-manager / activateSkill 与 activeSkills', () => {
  it('激活返回技能指令，未激活时 getActiveSkillInstructions 为空', () => {
    h.installed = [skill({ name: 'a' })]
    const mgr = new SkillManager()
    expect(mgr.getActiveSkillInstructions()).toEqual([])
    mgr.discoverSkills()
    expect(mgr.activateSkill('a')).toBe('instructions-a')
    expect(mgr.getActiveSkillInstructions()).toEqual(['instructions-a'])
  })

  it('未发现技能时激活抛错（含技能名）', () => {
    const mgr = new SkillManager()
    mgr.discoverSkills()
    expect(() => mgr.activateSkill('ghost')).toThrow('Skill "ghost" not found')
    expect(mgr.getActiveSkillInstructions()).toEqual([])
  })

  it('重复激活同一技能不产生重复指令', () => {
    h.installed = [skill({ name: 'a' })]
    const mgr = new SkillManager()
    mgr.discoverSkills()
    mgr.activateSkill('a')
    mgr.activateSkill('a')
    expect(mgr.getActiveSkillInstructions()).toEqual(['instructions-a'])
  })

  it('debugLog 记录激活动作', () => {
    h.installed = [skill({ name: 'a' })]
    const log = vi.fn()
    const mgr = new SkillManager(undefined, log)
    mgr.discoverSkills()
    mgr.activateSkill('a')
    expect(log).toHaveBeenCalledWith(expect.stringContaining('Activated skill: a'))
  })
})

describe('agent/skill-manager / readReference 容错匹配', () => {
  // loadReferences 只读取 references 目录下的一级文件，name 恒为扁平文件名
  const references = [
    { name: 'guide.md', content: 'GUIDE' },
    { name: 'notes.txt', content: 'NOTES' },
    { name: 'UPPER.MD', content: 'UPPER' },
  ]

  const setup = () => {
    h.installed = [skill({ name: 'a', references })]
    const mgr = new SkillManager()
    mgr.discoverSkills()
    return mgr
  }

  it('精确名称命中', () => {
    expect(setup().readReference('a', 'guide.md')).toBe('GUIDE')
  })

  it('references/ 前缀与 ./ 前缀被归一化后命中', () => {
    const mgr = setup()
    expect(mgr.readReference('a', 'references/guide.md')).toBe('GUIDE')
    expect(mgr.readReference('a', './guide.md')).toBe('GUIDE')
    expect(mgr.readReference('a', './references/guide.md')).toBe('GUIDE')
  })

  it('Windows 反斜杠路径被归一化后命中', () => {
    const mgr = setup()
    expect(mgr.readReference('a', 'references\\guide.md')).toBe('GUIDE')
  })

  it('大小写不敏感命中（basename 匹配）', () => {
    const mgr = setup()
    expect(mgr.readReference('a', 'upper.md')).toBe('UPPER')
    expect(mgr.readReference('a', 'guide.MD')).toBe('GUIDE')
  })

  it('未知技能名抛错', () => {
    expect(() => setup().readReference('ghost', 'guide.md')).toThrow('Skill "ghost" not found')
  })

  it('未找到的参考文件抛错并列出可用文件', () => {
    const mgr = setup()
    let err: any
    try {
      mgr.readReference('a', 'missing.md')
    } catch (e) {
      err = e
    }
    expect(err?.message).toContain('Reference "missing.md" not found in skill "a"')
    expect(err?.message).toContain('- guide.md')
    expect(err?.message).toContain('- notes.txt')
  })

  it('技能无参考文件时错误信息提示"(无参考文件)"', () => {
    h.installed = [skill({ name: 'b', references: [] })]
    const mgr = new SkillManager()
    mgr.discoverSkills()
    expect(() => mgr.readReference('b', 'x.md')).toThrow('(无参考文件)')
  })

  it('空字符串 referencePath 找不到时抛错而非命中', () => {
    expect(() => setup().readReference('a', '')).toThrow('not found')
  })

  it('空内容的参考文件应能正常读取（空串也是有效命中）', () => {
    h.installed = [skill({ name: 'c', references: [{ name: 'empty.md', content: '' }] })]
    const mgr = new SkillManager()
    mgr.discoverSkills()
    expect(mgr.readReference('c', 'empty.md')).toBe('')
  })
})
