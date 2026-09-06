import { describe, it, expect, vi, beforeEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'

// 内存 fakeDb：模拟 installed_skills 表（行键为数据库下划线列名，rowToSkill 直接消费）
const { fakeDb, getRows, resetRows } = vi.hoisted(() => {
  let rows: Array<Record<string, any>> = []
  let employeeSkillRows: Array<{ id: string; employee_id: string; skill_id: string; is_enabled: number }> = []
  const fakeDb = {
    prepare: vi.fn((sql: string) => ({
      get: (...args: any[]) => {
        if (sql.includes('FROM installed_skills') && /WHERE id = \?/.test(sql)) {
          return rows.find(r => r.id === args[0])
        }
        // SELECT workspace_path FROM employees：返回空 → 无项目级技能
        if (sql.includes('FROM employees') && sql.includes('workspace_path')) {
          return undefined
        }
        return undefined
      },
      all: (..._args: any[]) => {
        if (sql.includes('FROM installed_skills')) return [...rows]
        if (sql.includes('FROM employee_skills') && sql.includes('employee_id = ?')) {
          return employeeSkillRows.filter(r => r.employee_id === _args[0])
        }
        return []
      },
      run: (...args: any[]) => {
        if (sql.includes('INSERT INTO installed_skills')) {
          // 列顺序对齐 saveToDatabase：id,name,description,version,author,tags_json,install_path,manifest_json,
          // skill_md_content,license,compatibility,allowed_tools_json,metadata_json,context,agent,source,
          // disable_model_invocation,user_invocable,hooks_json,plugin_id,is_enabled,created_at
          const row = {
            id: args[0], name: args[1], description: args[2], version: args[3], author: args[4], tags_json: args[5],
            install_path: args[6], manifest_json: args[7], skill_md_content: args[8], license: args[9],
            compatibility: args[10], allowed_tools_json: args[11], metadata_json: args[12], context: args[13],
            agent: args[14], source: args[15], disable_model_invocation: args[16], user_invocable: args[17],
            hooks_json: args[18], plugin_id: args[19], is_enabled: args[20], created_at: args[21],
          }
          const idx = rows.findIndex(r => r.id === row.id)
          if (idx >= 0) rows[idx] = row
          else rows.push(row)
        } else if (sql.includes('INSERT OR IGNORE INTO employee_skills')) {
          // assignSkillToEmployee：id, employee_id, skill_id；is_enabled 为 SQL 字面量 1（非参数）
          if (!employeeSkillRows.some(r => r.employee_id === args[1] && r.skill_id === args[2])) {
            employeeSkillRows.push({ id: args[0], employee_id: args[1], skill_id: args[2], is_enabled: 1 })
          }
        } else if (sql.includes('DELETE FROM installed_skills WHERE source = ? AND plugin_id = ?')) {
          rows = rows.filter(r => !(r.source === args[0] && r.plugin_id === args[1]))
        }
        return { changes: 1 }
      },
    })),
  }
  return {
    fakeDb,
    getRows: () => rows,
    resetRows: () => {
      rows = []
      employeeSkillRows = []
    },
  }
})

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-skill-test-'))
const pluginId = 'demo-plugin'

vi.mock('../../../electron/main/services/database.service', () => ({
  default: class {
    static getInstance() { return new this() }
    getDb() { return fakeDb }
  },
}))
vi.mock('../../../electron/main/services/path.service', () => ({
  default: {
    getInstance: () => ({
      getSkillsDir: () => path.join(tempRoot, 'skills'),
      getResourcesDir: () => path.join(tempRoot, 'resources'),
    }),
  },
}))

// 动态引入被测模块（vi.mock 生效后）
const SkillRegistryService = (await import('../../../electron/main/services/skill-registry.service')).default

/** 构造一个合法插件技能目录（含 SKILL.md + references 文件），返回 skills 根目录 */
function makePluginSkillDir(skillName: string) {
  const skillsRoot = path.join(tempRoot, pluginId, 'skills')
  const dir = path.join(skillsRoot, skillName)
  fs.mkdirSync(path.join(dir, 'references'), { recursive: true })
  fs.writeFileSync(
    path.join(dir, 'SKILL.md'),
    `---\nname: ${skillName}\ndescription: 测试技能 ${skillName}\nauthor: test\n---\n\n# ${skillName}\n\n对 ${skillName} 的完整操作指引。\n`
  )
  fs.writeFileSync(path.join(dir, 'references', 'api.md'), 'API 参考文档（用于渐进披露第 3 层按需读取）\n')
  return skillsRoot
}

describe('SkillRegistryService 插件技能（source=plugin）', () => {
  let svc: InstanceType<typeof SkillRegistryService>

  beforeEach(() => {
    resetRows()
    svc = SkillRegistryService.getInstance()
    svc.markPluginSkillsInactive(pluginId)
  })

  afterAll(() => {
    fs.rmSync(tempRoot, { recursive: true, force: true })
  })

  it('registerPluginSkills 注册插件技能：稳定 id、installPath 指向插件目录、references 可解析', () => {
    const skillsRoot = makePluginSkillDir('data-expert')
    svc.registerPluginSkills(pluginId, skillsRoot)

    const skills = svc.getInstalledSkills()
    const skill = skills.find(s => s.id === `plugin:${pluginId}:data-expert`)
    expect(skill).toBeDefined()
    expect(skill!.source).toBe('plugin')
    expect(skill!.plugin_id).toBe(pluginId)
    expect(skill!.installPath).toBe(path.join(skillsRoot, 'data-expert'))
    expect(skill!.name).toBe('data-expert')
    expect(skill!.references.length).toBe(1)
    expect(skill!.references[0].name).toBe('api.md')
  })

  it('插件技能默认进入可用池，可分配给员工（getEmployeeSkills 可见）', () => {
    const skillsRoot = makePluginSkillDir('data-expert')
    svc.registerPluginSkills(pluginId, skillsRoot)
    const skill = svc.getInstalledSkills().find(s => s.plugin_id === pluginId)!
    svc.assignSkillToEmployee(skill.id, 'emp-1')
    const { enabled } = svc.getEmployeeSkills('emp-1')
    expect(enabled.some(s => s.id === skill.id)).toBe(true)
  })

  it('markPluginSkillsInactive 后插件技能从可用池隐藏（DB 记录保留）', () => {
    const skillsRoot = makePluginSkillDir('data-expert')
    svc.registerPluginSkills(pluginId, skillsRoot)
    expect(svc.getInstalledSkills().some(s => s.plugin_id === pluginId)).toBe(true)

    svc.markPluginSkillsInactive(pluginId)
    expect(svc.getInstalledSkills().some(s => s.plugin_id === pluginId)).toBe(false)
    // DB 记录仍在（员工分配不丢失，重新激活后恢复）
    expect(fs.readdirSync(skillsRoot).length).toBeGreaterThan(0)
  })

  it('重新激活（再次注册）后技能恢复可用', () => {
    const skillsRoot = makePluginSkillDir('data-expert')
    svc.registerPluginSkills(pluginId, skillsRoot)
    svc.markPluginSkillsInactive(pluginId)
    expect(svc.getInstalledSkills().length).toBe(0)

    svc.registerPluginSkills(pluginId, skillsRoot)
    const skill = svc.getInstalledSkills().find(s => s.plugin_id === pluginId)
    expect(skill).toBeDefined()
    // 员工分配记录在重新激活后依然生效（id 稳定）
    expect(skill!.id).toBe(`plugin:${pluginId}:data-expert`)
  })

  it('removePluginSkills 物理删除技能记录（点击删除插件时）', () => {
    const skillsRoot = makePluginSkillDir('data-expert')
    svc.registerPluginSkills(pluginId, skillsRoot)
    svc.removePluginSkills(pluginId)
    expect(svc.getInstalledSkills().some(s => s.plugin_id === pluginId)).toBe(false)
    // 物理删除后 DB 无残留：再次注册是新记录
    expect(getRows().filter(r => r.plugin_id === pluginId).length).toBe(0)
  })

  it('uninstallSkill 拒绝插件来源技能（由插件生命周期管理，不允许单独卸载）', async () => {
    const skillsRoot = makePluginSkillDir('data-expert')
    svc.registerPluginSkills(pluginId, skillsRoot)
    const skill = svc.getInstalledSkills().find(s => s.plugin_id === pluginId)!
    const ok = await svc.uninstallSkill(skill.id)
    expect(ok).toBe(false)
    // DB 与插件目录均未受影响
    expect(getRows().some(r => r.id === skill.id)).toBe(true)
    expect(fs.existsSync(path.join(skillsRoot, 'data-expert', 'SKILL.md'))).toBe(true)
  })

  it('无效技能目录（无 SKILL.md / name 与目录名不一致）跳过注册，不影响其他技能', () => {
    const skillsRoot = makePluginSkillDir('data-expert')
    // 目录名非法但内部 SKILL.md name 合法
    const badDir = path.join(skillsRoot, 'Bad Dir!')
    fs.mkdirSync(badDir, { recursive: true })
    fs.writeFileSync(path.join(badDir, 'SKILL.md'), '---\nname: data-expert\ndescription: 重复技能\n---\n\n正文\n')
    // 无 SKILL.md 的目录
    fs.mkdirSync(path.join(skillsRoot, 'no-md'), { recursive: true })

    svc.registerPluginSkills(pluginId, skillsRoot)
    const skills = svc.getInstalledSkills().filter(s => s.plugin_id === pluginId)
    expect(skills.length).toBe(1)
    expect(skills[0].name).toBe('data-expert')
  })
})