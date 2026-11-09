import { describe, it, expect, vi, beforeEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'

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

  it('description 含换行 / 引号 / Unicode 时 XML 字符转义注入（不破坏 <skills> 结构）', () => {
    h.installed = [skill({ name: '写作"助手"', description: '第一行\n第二行 — 中文' })]
    const mgr = new SkillManager()
    mgr.discoverSkills()
    // 引号转义为 &quot;，换行/普通 Unicode 保留
    expect(mgr.getSkillsXml()).toContain('name="写作&quot;助手&quot;"')
    expect(mgr.getSkillsXml()).toContain('第一行\n第二行 — 中文')
    expect(mgr.getSkillsXml()).not.toContain('name="写作"助手""')
  })
})

describe('agent/skill-manager / activateSkill 与 activeSkills', () => {
  it('激活返回技能指令，未激活时 getActiveSkillInstructions 为空', () => {
    h.installed = [skill({ name: 'a' })]
    const mgr = new SkillManager()
    expect(mgr.getActiveSkillInstructions()).toEqual([])
    mgr.discoverSkills()
    const output = mgr.activateSkill('a')
    expect(output).toContain('instructions-a')
    expect(output).toContain('技能根目录（绝对路径）')
    expect(mgr.getActiveSkillInstructions()).toEqual(['instructions-a'])
  })

  it('激活输出注入技能根目录，并把 skills/<技能名>/ 前缀改写为绝对路径', () => {
    h.installed = [skill({
      name: 'a',
      installPath: '/plugins/a/skills/a',
      skillMdContent: 'python skills/a/tools/run.py --x',
    })]
    const mgr = new SkillManager()
    mgr.discoverSkills()
    const output = mgr.activateSkill('a')
    expect(output).toContain('python /plugins/a/skills/a/tools/run.py --x')
    expect(output).not.toContain('python skills/a/tools/run.py')
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

describe('agent/skill-manager / readReference 技能目录相对路径', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-skill-'))
  const mk = (rel: string, content: string) => {
    const full = path.join(dir, rel)
    fs.mkdirSync(path.dirname(full), { recursive: true })
    fs.writeFileSync(full, content, 'utf-8')
  }
  mk('prompts/intake.md', 'INTAKE')
  mk('references/schemas/appearance.schema.yaml', 'SCHEMA')
  mk('tools/run.py', 'print(1)')
  mk('prompts/with-path.md', 'python skills/patent-disclosure/tools/run.py')

  const setup = () => {
    h.installed = [skill({ name: 'patent-disclosure', installPath: dir })]
    const mgr = new SkillManager()
    mgr.discoverSkills()
    return mgr
  }

  it('可读取 references/ 之外的 prompts/ 文件', () => {
    expect(setup().readReference('patent-disclosure', 'prompts/intake.md')).toBe('INTAKE')
  })

  it('可读取 references 子目录文件（含未预加载的嵌套文件）', () => {
    expect(setup().readReference('patent-disclosure', 'references/schemas/appearance.schema.yaml')).toBe('SCHEMA')
    expect(setup().readReference('patent-disclosure', 'schemas/appearance.schema.yaml')).toBe('SCHEMA')
  })

  it('可读取 tools/ 文件，且兼容 skills/<技能名>/ 前缀', () => {
    expect(setup().readReference('patent-disclosure', 'skills/patent-disclosure/tools/run.py')).toBe('print(1)')
  })

  it('拒绝技能目录之外的路径穿越', () => {
    expect(() => setup().readReference('patent-disclosure', '../outside.md')).toThrow('not found')
  })

  it('读取到的内容中 skills/<技能名>/ 前缀被改写为技能根目录绝对路径', () => {
    const content = setup().readReference('patent-disclosure', 'prompts/with-path.md')
    const root = dir.replace(/\\/g, '/')
    expect(content).toBe(`python ${root}/tools/run.py`)
  })
})
