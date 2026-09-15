/**
 * 员工配置导出/导入服务单测（database 打桩，内存表模拟 employees/skills/employee_tools 等）：
 * - buildConfigData 字段完整性与默认值填充
 * - checksum 计算稳定性与篡改检测（含键序敏感性暴露）
 * - exportConfig 落盘、importConfig 的各类失败路径与冲突策略
 * - applyImportData 的事务语义与缺失技能告警
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'

const mockState = vi.hoisted(() => {
  const employees: any[] = []
  const skills: any[] = []
  const employeeTools: any[] = []
  const installedSkills = new Set<string>()
  const employeeSkills: any[] = []
  const log: Array<{ sql: string; args: any[] }> = []
  const errors = { throwOnSkillInsert: false }
  const norm = (s: string) => s.replace(/\s+/g, ' ').trim()

  const db = {
    prepare(sql: string) {
      const s = norm(sql)
      if (s === 'SELECT * FROM employees WHERE id = ?') {
        return { get: (id: string) => employees.find(e => e.id === id) }
      }
      if (s === 'SELECT * FROM skills WHERE employee_id = ?') {
        return { all: (empId: string) => skills.filter(x => x.employee_id === empId) }
      }
      if (s === 'SELECT tool_id, tool_mode, config_json FROM employee_tools WHERE employee_id = ?') {
        return { all: (empId: string) => employeeTools.filter(x => x.employee_id === empId) }
      }
      if (s.startsWith('SELECT es.skill_id, es.is_enabled, sk.name as skill_name FROM employee_skills es')) {
        return {
          all: (empId: string) =>
            employeeSkills
              .filter(x => x.employee_id === empId)
              .map(x => ({ skill_id: x.skill_id, is_enabled: x.is_enabled, skill_name: `name-${x.skill_id}` })),
        }
      }
      if (s.startsWith('SELECT id FROM employee_tools WHERE employee_id = ? AND tool_id = ?')) {
        return { get: (empId: string, toolId: string) => employeeTools.find(x => x.employee_id === empId && x.tool_id === toolId) }
      }
      if (s.startsWith('SELECT id FROM installed_skills WHERE id = ?')) {
        return { get: (id: string) => (installedSkills.has(id) ? { id } : undefined) }
      }
      if (s.startsWith('SELECT id FROM employee_skills WHERE employee_id = ? AND skill_id = ?')) {
        return {
          get: (empId: string, skillId: string) => employeeSkills.find(x => x.employee_id === empId && x.skill_id === skillId),
        }
      }
      if (s.startsWith('INSERT INTO employees')) {
        return { run: (...a: any[]) => { log.push({ sql: 'insert-employee', args: a }); employees.push({ id: a[0], name: a[1] }); return { changes: 1 } } }
      }
      if (s.startsWith('INSERT INTO skills')) {
        return {
          run: (...a: any[]) => {
            if (errors.throwOnSkillInsert) throw new Error('skill insert failed')
            log.push({ sql: 'insert-skill', args: a })
            skills.push({ id: a[0], employee_id: a[1] })
            return { changes: 1 }
          },
        }
      }
      if (s.startsWith('INSERT INTO employee_tools')) {
        return { run: (...a: any[]) => { log.push({ sql: 'insert-tool', args: a }); employeeTools.push({ id: a[0], employee_id: a[1], tool_id: a[2], tool_mode: a[3], config_json: a[4] }); return { changes: 1 } } }
      }
      if (s.startsWith('INSERT INTO employee_skills')) {
        return { run: (...a: any[]) => { log.push({ sql: 'insert-employee-skill', args: a }); employeeSkills.push({ id: a[0], employee_id: a[1], skill_id: a[2], is_enabled: a[3] }); return { changes: 1 } } }
      }
      if (s.startsWith('UPDATE employee_tools SET tool_mode = ?, config_json = ?')) {
        return {
          run: (...a: any[]) => {
            log.push({ sql: 'update-tool-full', args: a })
            const row = employeeTools.find(x => x.employee_id === a[2] && x.tool_id === a[3])
            if (row) { row.tool_mode = a[0]; row.config_json = a[1] }
            return { changes: 1 }
          },
        }
      }
      if (s.startsWith('UPDATE employee_tools SET tool_mode = ?')) {
        return {
          run: (...a: any[]) => {
            log.push({ sql: 'update-tool-mode', args: a })
            const row = employeeTools.find(x => x.employee_id === a[1] && x.tool_id === a[2])
            if (row) row.tool_mode = a[0]
            return { changes: 1 }
          },
        }
      }
      throw new Error(`unexpected sql: ${s}`)
    },
    transaction: (fn: Function) => (...args: any[]) => fn(...args),
  }
  return { employees, skills, employeeTools, installedSkills, employeeSkills, log, errors, db }
})

vi.mock('../../../electron/main/services/database.service', () => ({
  default: { getInstance: () => ({ getDb: () => mockState.db }) },
}))

import {
  EmployeeExportConfigService,
  EXPORT_CONFIG_VERSION,
  type EmployeeConfigExport,
} from '../../../electron/main/services/employee-export-config.service'

const service = new EmployeeExportConfigService({ getDb: () => mockState.db } as any)

let root = ''

function validConfig(overrides: Partial<EmployeeConfigExport> = {}): EmployeeConfigExport {
  return {
    version: EXPORT_CONFIG_VERSION,
    type: 'workavatar-employee-config',
    exportedAt: new Date().toISOString(),
    checksum: '',
    employee: {
      name: '员工A',
      description: '描述',
      rules: '规则',
      avatar_type: 'default',
      profile_json: '{"roleName":"A"}',
      memory_enabled: true,
      default_skill_id: null,
      delegation_json: '',
    },
    skills: [],
    tools: [],
    installedSkills: [],
    ...overrides,
  }
}

beforeEach(() => {
  mockState.employees.length = 0
  mockState.skills.length = 0
  mockState.employeeTools.length = 0
  mockState.employeeSkills.length = 0
  mockState.installedSkills.clear()
  mockState.log.length = 0
  mockState.errors.throwOnSkillInsert = false
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-export-test-'))
})

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true })
})

describe('employee-export-config / buildConfigData', () => {
  it('员工不存在时返回错误', () => {
    expect(service.buildConfigData('nope')).toEqual({ data: null, error: 'Employee not found' })
  })

  it('字段完整映射且空值填充默认', () => {
    mockState.employees.push({
      id: 'e1', name: '员工A', description: 'D', rules: '', avatar_type: 'default',
      profile_json: '', memory_enabled: 0, default_skill_id: null, delegation_json: '',
    })
    const { data } = service.buildConfigData('e1')
    expect(data!.employee).toEqual({
      name: '员工A',
      description: 'D',
      rules: '',
      avatar_type: 'default',
      profile_json: '',
      memory_enabled: false,
      default_skill_id: null,
      delegation_json: '',
    })
    expect(data!.version).toBe(EXPORT_CONFIG_VERSION)
    expect(data!.type).toBe('workavatar-employee-config')
    expect(data!.checksum).toBe('')
  })

  it('skills / tools / installedSkills 逐项映射，可选字段空串转 undefined', () => {
    mockState.employees.push({ id: 'e1', name: 'A', description: '', rules: 'r', avatar_type: 'default', profile_json: 'p', memory_enabled: 1, default_skill_id: 'sk', delegation_json: '{}' })
    mockState.skills.push({
      employee_id: 'e1', type: 'prompt', name: 'S', description: 'd', config_json: '{}',
      prompt_template: '', rules_json: '[]', test_cases_json: '[]',
      input_schema_json: '', output_schema_json: null, priority: 3, is_enabled: 1,
    })
    mockState.employeeTools.push({ employee_id: 'e1', tool_id: 'web_search', tool_mode: 'on_demand', config_json: '' })
    mockState.employeeSkills.push({ employee_id: 'e1', skill_id: 'ins-1', is_enabled: 0 })

    const { data } = service.buildConfigData('e1')!
    expect(data!.employee.memory_enabled).toBe(true)
    expect(data!.employee.default_skill_id).toBe('sk')
    expect(data!.skills[0]).toMatchObject({
      type: 'prompt', name: 'S', prompt_template: undefined,
      input_schema_json: undefined, output_schema_json: undefined,
      priority: 3, is_enabled: true,
    })
    expect(data!.tools).toEqual([{ tool_id: 'web_search', mode: 'on_demand', config_json: '{}' }])
    expect(data!.installedSkills).toEqual([{ skill_id: 'ins-1', skill_name: 'name-ins-1', is_enabled: false }])
  })
})

describe('employee-export-config / checksum', () => {
  it('为 64 位 sha256 十六进制且可复现', () => {
    const data = validConfig()
    const a = service.computeChecksum(data)
    const b = service.computeChecksum(data)
    expect(a).toBe(b)
    expect(a).toMatch(/^[0-9a-f]{64}$/)
  })

  it('忽略 data.checksum 自身取值', () => {
    // 复用同一份配置对象：validConfig 每次生成新的 exportedAt，两次调用会因时间戳不同而必然不等
    const base = validConfig()
    const a = service.computeChecksum({ ...base, checksum: '' })
    const b = service.computeChecksum({ ...base, checksum: 'deadbeef' })
    expect(a).toBe(b)
  })

  it('内容变化导致 checksum 变化', () => {
    const a = service.computeChecksum(validConfig())
    const b = service.computeChecksum(validConfig({ employee: { ...validConfig().employee, rules: '改了' } }))
    expect(a).not.toBe(b)
  })

  it('对键序敏感（外部工具重排键会导致校验失败）', () => {
    const base = validConfig()
    const reorderedEmployee = {
      rules: base.employee.rules,
      name: base.employee.name,
      description: base.employee.description,
      avatar_type: base.employee.avatar_type,
      profile_json: base.employee.profile_json,
      memory_enabled: base.employee.memory_enabled,
      default_skill_id: base.employee.default_skill_id,
      delegation_json: base.employee.delegation_json,
    }
    // 同一逻辑内容、不同键序 → checksum 不同（当前实现用 JSON.stringify 直接哈希）
    expect(service.computeChecksum({ ...base, employee: reorderedEmployee as any })).not.toBe(
      service.computeChecksum(base),
    )
  })
})

describe('employee-export-config / exportConfig 与 importConfig 往返', () => {
  it('导出文件存在且带校验和，可被成功导入', () => {
    mockState.employees.push({ id: 'e1', name: '导出员工', description: 'd', rules: 'r', avatar_type: 'default', profile_json: 'p', memory_enabled: 1, default_skill_id: null, delegation_json: '{}' })
    const target = path.join(root, 'cfg.json')
    expect(service.exportConfig('e1', target)).toEqual({ success: true })

    const saved = JSON.parse(fs.readFileSync(target, 'utf-8'))
    expect(saved.checksum).toMatch(/^[0-9a-f]{64}$/)
    expect(saved.checksum).toBe(service.computeChecksum(saved))

    const imported = service.importConfig(target)
    expect(imported.success).toBe(true)
    expect(imported.employeeId).toBeTruthy()
    expect(mockState.employees.some(e => e.name === '导出员工')).toBe(true)
  })

  it('导出目标不可写时返回错误而非抛出', () => {
    mockState.employees.push({ id: 'e1', name: 'A', description: '', rules: '', avatar_type: 'default', profile_json: '', memory_enabled: 0, default_skill_id: null, delegation_json: '' })
    const badPath = path.join(root, 'no-such-dir', 'cfg.json')
    const r = service.exportConfig('e1', badPath)
    expect(r.success).toBe(false)
    expect(r.error).toBeTruthy()
  })

  it('员工不存在时导出失败', () => {
    const r = service.exportConfig('nope', path.join(root, 'x.json'))
    expect(r).toEqual({ success: false, error: 'Employee not found' })
  })

  it('导入文件不存在', () => {
    expect(service.importConfig(path.join(root, 'missing.json'))).toEqual({
      success: false,
      error: 'Import file not found',
    })
  })

  it('导入非法 JSON', () => {
    const p = path.join(root, 'bad.json')
    fs.writeFileSync(p, '{ not json')
    const r = service.importConfig(p)
    expect(r.success).toBe(false)
    expect(r.error).toBeTruthy()
  })

  it('导入类型标识不符', () => {
    const p = path.join(root, 'wrong-type.json')
    fs.writeFileSync(p, JSON.stringify({ ...validConfig(), type: 'other' }))
    expect(service.importConfig(p)).toEqual({
      success: false,
      error: 'Invalid file: not a WorkAvatar employee config export',
    })
  })

  it('内容被篡改（checksum 不匹配）时拒绝导入', () => {
    const p = path.join(root, 'tampered.json')
    const data = validConfig()
    data.checksum = service.computeChecksum(data)
    data.employee.rules = '被篡改'
    fs.writeFileSync(p, JSON.stringify(data))
    expect(service.importConfig(p)).toEqual({
      success: false,
      error: 'Checksum verification failed: file may be corrupted',
    })
  })

  it('无 checksum 字段（旧版文件）跳过校验但仍做结构校验', () => {
    const p = path.join(root, 'no-checksum.json')
    const data = validConfig()
    delete (data as any).checksum
    fs.writeFileSync(p, JSON.stringify(data))
    expect(service.importConfig(p).success).toBe(true)
  })

  it('缺少 employee 字段时结构校验失败并列出错误', () => {
    const p = path.join(root, 'no-employee.json')
    fs.writeFileSync(p, JSON.stringify({ version: '1.0.0', type: 'workavatar-employee-config' }))
    const r = service.importConfig(p)
    expect(r.success).toBe(false)
    expect(r.error).toContain('Missing employee data')
  })

  it('导入写入失败时返回错误（事务内异常向上冒泡）', () => {
    const p = path.join(root, 'cfg.json')
    const data = validConfig()
    data.skills = [{ type: 'prompt', name: 'S', description: '', config_json: '{}', rules_json: '[]', test_cases_json: '[]', priority: 0, is_enabled: true }]
    data.checksum = service.computeChecksum(data)
    fs.writeFileSync(p, JSON.stringify(data))

    mockState.errors.throwOnSkillInsert = true
    const r = service.importConfig(p)
    expect(r.success).toBe(false)
    expect(r.error).toBe('skill insert failed')
  })
})

describe('employee-export-config / applyImportData 细节', () => {
  it('技能按导出项逐条落库，缺省字段填充默认值', () => {
    const r = service.importConfigFromData(validConfig({
      skills: [{
        type: 'prompt', name: 'S1', description: '', config_json: '', prompt_template: undefined,
        rules_json: '', test_cases_json: '', input_schema_json: undefined, output_schema_json: undefined,
        priority: 0, is_enabled: false,
      }],
    }))
    expect(r.success).toBe(true)
    const insert = mockState.log.find(l => l.sql === 'insert-skill')!
    // config_json / rules_json / test_cases_json / prompt_template / schema 的默认值
    expect(insert.args[5]).toBe('{}')
    expect(insert.args[6]).toBeNull()
    expect(insert.args[7]).toBe('[]')
    expect(insert.args[8]).toBe('[]')
    expect(insert.args[9]).toBeNull()
    expect(insert.args[10]).toBeNull()
    expect(insert.args[11]).toBe(0)
    expect(insert.args[12]).toBe(0)
  })

  it('工具默认插入，缺省 config_json 为 {}', () => {
    service.importConfigFromData(validConfig({ tools: [{ tool_id: 'kms_search', mode: 'on', config_json: '' }] }))
    const insert = mockState.log.find(l => l.sql === 'insert-tool')!
    expect(insert.args[2]).toBe('kms_search')
    expect(insert.args[3]).toBe('on')
    expect(insert.args[4]).toBe('{}')
  })

  it('冲突策略：同一份配置内重复 tool_id → merge 仅更新 mode，保留已有 config_json', () => {
    mockState.log.length = 0
    const r = service.importConfigFromData(validConfig({
      tools: [
        { tool_id: 't1', mode: 'on', config_json: '{"keep":1}' },
        { tool_id: 't1', mode: 'on_demand', config_json: '{"new":2}' },
      ],
    }))
    expect(r.success).toBe(true)
    expect(mockState.log.filter(l => l.sql === 'insert-tool')).toHaveLength(1)
    expect(mockState.log.some(l => l.sql === 'update-tool-mode')).toBe(true)
    expect(mockState.log.some(l => l.sql === 'update-tool-full')).toBe(false)
    const row = mockState.employeeTools.find(x => x.employee_id === r.employeeId && x.tool_id === 't1')!
    expect(row.tool_mode).toBe('on_demand')
    expect(row.config_json).toBe('{"keep":1}')
  })

  it('冲突策略：overwrite 同时更新 mode 与 config（走文件导入路径）', () => {
    const data = validConfig({
      tools: [
        { tool_id: 't1', mode: 'on', config_json: '{"keep":1}' },
        { tool_id: 't1', mode: 'off', config_json: '{"new":2}' },
      ],
    })
    data.checksum = service.computeChecksum(data)
    const p = path.join(root, 'overwrite.json')
    fs.writeFileSync(p, JSON.stringify(data))
    mockState.log.length = 0

    const r = service.importConfig(p, 'overwrite')
    expect(r.success).toBe(true)
    expect(mockState.log.some(l => l.sql === 'update-tool-full')).toBe(true)
    const row = mockState.employeeTools.find(x => x.employee_id === r.employeeId && x.tool_id === 't1')!
    expect(row.tool_mode).toBe('off')
    expect(row.config_json).toBe('{"new":2}')
  })

  it('冲突策略：skip 不修改已有工具', () => {
    const data = validConfig({
      tools: [
        { tool_id: 't1', mode: 'on', config_json: '{"keep":1}' },
        { tool_id: 't1', mode: 'off', config_json: '{"new":2}' },
      ],
    })
    data.checksum = service.computeChecksum(data)
    const p = path.join(root, 'skip.json')
    fs.writeFileSync(p, JSON.stringify(data))
    mockState.log.length = 0

    const r = service.importConfig(p, 'skip')
    expect(r.success).toBe(true)
    expect(mockState.log.some(l => l.sql.startsWith('update-tool'))).toBe(false)
    const row = mockState.employeeTools.find(x => x.employee_id === r.employeeId && x.tool_id === 't1')!
    expect(row.tool_mode).toBe('on')
    expect(row.config_json).toBe('{"keep":1}')
  })

  it('已安装技能缺失时收集告警且不写 employee_skills', () => {
    mockState.installedSkills.add('present-1')
    mockState.log.length = 0

    const r = service.importConfigFromData(validConfig({
      installedSkills: [
        { skill_id: 'missing-1', skill_name: '缺失技能', is_enabled: true },
        { skill_id: 'present-1', skill_name: '已装技能', is_enabled: false },
      ],
    }))

    expect(r.warnings).toEqual([expect.stringContaining('缺失技能')])
    expect(r.warnings![0]).toContain('missing-1')
    const assigns = mockState.log.filter(l => l.sql === 'insert-employee-skill')
    expect(assigns).toHaveLength(1)
    expect(assigns[0].args[1]).toBe(r.employeeId)
    expect(assigns[0].args[2]).toBe('present-1')
    expect(assigns[0].args[3]).toBe(0)
  })

  it('每次导入生成新员工，已装技能分别建立分配记录', () => {
    mockState.installedSkills.add('present-2')
    const data = validConfig({ installedSkills: [{ skill_id: 'present-2', skill_name: 'X', is_enabled: true }] })
    const a = service.importConfigFromData(data)
    const b = service.importConfigFromData(data)
    expect(a.employeeId).not.toBe(b.employeeId)
    expect(mockState.employeeSkills.filter(x => x.skill_id === 'present-2')).toHaveLength(2)
  })

  it('memory_enabled / default_skill_id 落库转换', () => {
    const r = service.importConfigFromData(validConfig({
      employee: { ...validConfig().employee, memory_enabled: false, default_skill_id: null },
    }))
    const insert = mockState.log.find(l => l.sql === 'insert-employee')!
    expect(insert.args[0]).toBe(r.employeeId)
    expect(insert.args[6]).toBe(0)
    expect(insert.args[7]).toBeNull()

    mockState.log.length = 0
    service.importConfigFromData(validConfig({
      employee: { ...validConfig().employee, memory_enabled: true, default_skill_id: 'sk-1' },
    }))
    const insert2 = mockState.log.find(l => l.sql === 'insert-employee')!
    expect(insert2.args[6]).toBe(1)
    expect(insert2.args[7]).toBe('sk-1')
  })
})

describe('employee-export-config / validateConfig', () => {
  it('合法配置通过校验', () => {
    expect(service.validateConfig(validConfig())).toEqual({ valid: true, errors: [] })
  })

  it('逐项列出缺失字段', () => {
    expect(service.validateConfig({} as any).errors).toEqual([
      'Missing employee data',
      'Missing version information',
      'Missing type identifier',
    ])
  })

  it('employee 存在但缺 name', () => {
    const data = validConfig()
    ;(data.employee as any).name = ''
    expect(service.validateConfig(data)).toEqual({ valid: false, errors: ['Missing employee name'] })
  })
})
