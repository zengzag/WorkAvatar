/**
 * 员工注册表（内置 + 插件来源）单测：
 * - 内置员工声明完整性（id 前缀 builtin:、defaultTools/defaultSkills 覆盖）
 * - 插件员工 id 规则 plugin:<插件id>:<key>、上下线、热重载清理
 * - 启用/禁用与记忆开关的 settings KV 持久化（含容错）
 * - 默认工具/技能模式、DBEmployee 形状、影子记录同步
 * - 另存副本命名规则
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { EventEmitter } from 'events'
import Module from 'module'

const mockState = vi.hoisted(() => {
  const settings = new Map<string, string>()
  const employeeRows: Array<Record<string, any>> = []
  const sqlLog: Array<{ sql: string; args: any[] }> = []
  const windows: any[] = []
  const workspace = {
    getEmployee: vi.fn(() => null as any),
    createEmployee: vi.fn((name: string, description: string, profile: string, rules: string) => ({
      id: 'new-user-id',
      name,
      description,
      profile_json: profile,
      rules,
    })),
  }
  const agent = { clearAgentCache: vi.fn() }
  const db = {
    prepare(sql: string) {
      return {
        get: (key: string) => {
          sqlLog.push({ sql, args: [key] })
          if (sql.includes('FROM settings')) {
            return settings.has(key) ? { value: settings.get(key) } : undefined
          }
          if (sql.includes('FROM employees')) {
            const row = employeeRows.find(r => r.id === key)
            return row ? { ...row } : undefined
          }
          throw new Error(`unexpected get sql: ${sql}`)
        },
        run: (...args: any[]) => {
          sqlLog.push({ sql, args })
          if (sql.includes('INSERT INTO settings')) {
            settings.set(args[0], args[1])
          } else if (sql.includes('INSERT INTO employees')) {
            const row = {
              id: args[0], name: args[1], description: args[2], rules: args[3],
              profile_json: args[4], is_registered: 1,
            }
            const idx = employeeRows.findIndex(r => r.id === row.id)
            if (idx >= 0) employeeRows[idx] = row
            else employeeRows.push(row)
          } else {
            throw new Error(`unexpected run sql: ${sql}`)
          }
          return { changes: 1 }
        },
      }
    },
    transaction: (fn: Function) => (...args: any[]) => fn(...args),
  }
  return { settings, employeeRows, sqlLog, windows, workspace, agent, db }
})

const origModuleLoad = (Module as any)._load
function installInterceptor(): void {
  ;(Module as any)._load = function (this: any, request: string, parent: any, isMain: boolean) {
    const name = request.split('/').pop()
    if (name === 'workspace-manager.service') {
      return { default: { getInstance: () => mockState.workspace } }
    }
    if (name === 'employee-agent.service') {
      return { default: { getInstance: () => mockState.agent } }
    }
    return origModuleLoad.call(this, request, parent, isMain)
  }
}
function restoreInterceptor(): void {
  ;(Module as any)._load = origModuleLoad
}

vi.mock('electron', () => ({
  BrowserWindow: { getAllWindows: () => mockState.windows },
}))

vi.mock('../../../electron/main/services/database.service', () => ({
  default: { getInstance: () => ({ getDb: () => mockState.db }) },
}))

import EmployeeRegistryService, {
  type RegisteredEmployee,
} from '../../../electron/main/services/employee-registry.service'
import { IPC_CHANNELS } from '../../../electron/shared/ipc-channels'

const SETTINGS_KEY = 'registered_employees.config'
const service = EmployeeRegistryService.getInstance()

function makeWindow(destroyed = false) {
  return { destroyed, isDestroyed: () => destroyed, webContents: { send: vi.fn() } }
}

function pluginEmployee(overrides: Partial<RegisteredEmployee> = {}): RegisteredEmployee {
  return {
    id: 'dev',
    source_key: 'dev',
    name: 'Dev',
    description: '',
    rules: 'prompt',
    profile_json: '',
    avatar_type: 'default',
    memory_enabled: false,
    arch_version: 1,
    total_tasks: 0,
    total_approvals: 0,
    created_at: 0,
    updated_at: 0,
    ...overrides,
  } as RegisteredEmployee
}

beforeEach(() => {
  vi.clearAllMocks()
  installInterceptor()
  mockState.settings.clear()
  mockState.employeeRows.length = 0
  mockState.sqlLog.length = 0
  mockState.windows.length = 0
  mockState.workspace.getEmployee.mockReturnValue(null)
  service.resetPluginEmployees()
})

afterEach(() => {
  restoreInterceptor()
})

describe('employee-registry / 内置员工', () => {
  it('内置员工 id 带 builtin: 前缀且顺序稳定', () => {
    const list = service.getBuiltinEmployees()
    expect(list.map(e => e.id)).toEqual(['builtin:knowledge-base', 'builtin:plugin-dev'])
    expect(list.every(e => e.source === 'builtin')).toBe(true)
  })

  it('内置员工声明默认工具 / 默认技能覆盖', () => {
    expect(service.getDefaultToolModes('builtin:knowledge-base')).toBeInstanceOf(Map)
    expect(Array.from(service.getDefaultToolModes('builtin:knowledge-base')!.keys())).toEqual([
      'kms_search', 'kms_get_content', 'kms_list_collections', 'web_search', 'web_fetch',
    ])
    expect(Array.from(service.getDefaultSkillIds('builtin:plugin-dev')!)).toEqual(['plugin-dev'])
    expect(service.getDefaultToolModes('builtin:plugin-dev')).toBeNull()
    expect(service.getDefaultSkillIds('builtin:knowledge-base')).toBeNull()
  })

  it('注册员工查询与 isRegistered', () => {
    expect(service.isRegistered('builtin:plugin-dev')).toBe(true)
    expect(service.isRegistered('builtin:not-exist')).toBe(false)
    expect(service.getRegistered('builtin:not-exist')).toBeNull()
    expect(service.getRegistered('builtin:plugin-dev')?.name).toBe('插件开发助手')
  })

  it('未知员工的默认工具/技能返回 null', () => {
    expect(service.getDefaultToolModes('unknown')).toBeNull()
    expect(service.getDefaultSkillIds('unknown')).toBeNull()
  })

  it('listRegistered 包含内置与插件员工，内置在前', () => {
    service.registerPluginEmployees('p1', 'P1', [pluginEmployee()])
    const list = service.listRegistered()
    expect(list.length).toBeGreaterThanOrEqual(3)
    expect(list[0].id).toBe('builtin:knowledge-base')
    expect(list.at(-1)!.id).toBe('plugin:p1:dev')
  })
})

describe('employee-registry / 插件员工', () => {
  it('id 规则为 plugin:<插件id>:<key>，并回填 source/plugin 元信息', () => {
    service.registerPluginEmployees('my-plugin', '我的插件', [pluginEmployee({ id: 'dev', source_key: 'dev' })])
    const groups = service.getPluginGroups()
    expect(groups).toHaveLength(1)
    const emp = groups[0].employees[0]
    expect(emp.id).toBe('plugin:my-plugin:dev')
    expect(emp.source).toBe('plugin')
    expect(emp.plugin_id).toBe('my-plugin')
    expect(emp.plugin_name).toBe('我的插件')
    expect(service.getRegistered('plugin:my-plugin:dev')?.name).toBe('Dev')
  })

  it('缺少 source_key 时用传入 id 作为 key 段', () => {
    const emp = pluginEmployee({ id: 'fallback', source_key: undefined })
    service.registerPluginEmployees('p2', 'P2', [emp])
    expect(service.getRegistered('plugin:p2:fallback')).not.toBeNull()
  })

  it('空员工列表不注册分组', () => {
    service.registerPluginEmployees('p3', 'P3', [])
    expect(service.getPluginGroups()).toEqual([])
  })

  it('重复注册同一插件以最新声明为准', () => {
    service.registerPluginEmployees('p4', 'P4', [pluginEmployee({ id: 'a', source_key: 'a', name: '旧' })])
    service.registerPluginEmployees('p4', 'P4', [pluginEmployee({ id: 'a', source_key: 'a', name: '新' })])
    const group = service.getPluginGroups().find(g => g.pluginId === 'p4')!
    expect(group.employees.map(e => e.name)).toEqual(['新'])
  })

  it('插件员工上下线：unregisterPluginEmployees 移除分组', () => {
    service.registerPluginEmployees('p5', 'P5', [pluginEmployee()])
    expect(service.isRegistered('plugin:p5:dev')).toBe(true)
    service.unregisterPluginEmployees('p5')
    expect(service.isRegistered('plugin:p5:dev')).toBe(false)
    expect(service.getPluginGroups()).toEqual([])
  })

  it('unregisterPluginEmployees 对未知插件是空操作', () => {
    expect(() => service.unregisterPluginEmployees('never')).not.toThrow()
  })

  it('resetPluginEmployees 清空全部插件员工但保留内置', () => {
    service.registerPluginEmployees('p6', 'P6', [pluginEmployee()])
    service.registerPluginEmployees('p7', 'P7', [pluginEmployee()])
    service.resetPluginEmployees()
    expect(service.getPluginGroups()).toEqual([])
    expect(service.getBuiltinEmployees()).toHaveLength(2)
  })

  it('注册与下线都会广播员工变更（跳过已销毁窗口）', () => {
    const alive = makeWindow()
    const dead = makeWindow(true)
    mockState.windows.push(alive, dead)
    service.registerPluginEmployees('p8', 'P8', [pluginEmployee()])
    expect(alive.webContents.send).toHaveBeenCalledWith(IPC_CHANNELS.EMPLOYEE_ON_CHANGED, expect.anything())
    expect(dead.webContents.send).not.toHaveBeenCalled()
  })

  it('插件员工记录同步进 employees 表影子记录（幂等 UPSERT）', () => {
    service.registerPluginEmployees('p9', 'P9', [pluginEmployee()])
    const row = mockState.employeeRows.find(r => r.id === 'plugin:p9:dev')
    expect(row).toBeDefined()
    expect(row!.name).toBe('Dev')
    expect(row!.is_registered).toBe(1)
    expect(mockState.sqlLog.some(l => l.sql.includes('ON CONFLICT(id) DO UPDATE'))).toBe(true)
  })

  it('ensureDbRecords 抛错时被吞掉（不影响主流程）', () => {
    const spy = vi.spyOn(mockState.db, 'prepare').mockImplementation(() => {
      throw new Error('db down')
    })
    expect(() => service.ensureDbRecords()).not.toThrow()
    spy.mockRestore()
  })
})

describe('employee-registry / 启用与记忆开关持久化', () => {
  it('默认启用且未配置时无记录', () => {
    expect(service.isEnabled('builtin:plugin-dev')).toBe(true)
    expect(service.isMemoryEnabled('builtin:plugin-dev')).toBe(false)
    expect(mockState.settings.has(SETTINGS_KEY)).toBe(false)
  })

  it('禁用写入 KV 并可被读回', () => {
    expect(service.setEnabled('builtin:plugin-dev', false)).toBe(true)
    expect(service.isEnabled('builtin:plugin-dev')).toBe(false)
    const saved = JSON.parse(mockState.settings.get(SETTINGS_KEY)!)
    expect(saved.disabled).toEqual(['builtin:plugin-dev'])
    expect(service.getRegistered('builtin:plugin-dev')!.is_enabled).toBe(false)
  })

  it('重新启用后从 disabled 集合移除', () => {
    service.setEnabled('builtin:plugin-dev', false)
    service.setEnabled('builtin:plugin-dev', true)
    expect(service.isEnabled('builtin:plugin-dev')).toBe(true)
    expect(JSON.parse(mockState.settings.get(SETTINGS_KEY)!).disabled).toEqual([])
  })

  it('禁用与记忆开关互不覆盖', () => {
    service.setMemoryEnabled('builtin:plugin-dev', true)
    service.setEnabled('builtin:plugin-dev', false)
    const saved = JSON.parse(mockState.settings.get(SETTINGS_KEY)!)
    expect(saved.disabled).toEqual(['builtin:plugin-dev'])
    expect(saved.memoryEnabled).toEqual(['builtin:plugin-dev'])
  })

  it('未注册且 DB 中也不存在的员工返回 false（不写 KV）', () => {
    expect(service.setEnabled('not-exist', false)).toBe(false)
    expect(mockState.settings.has(SETTINGS_KEY)).toBe(false)
  })

  it('user 员工（注册表外但 DB 有记录）也能切换启用状态', () => {
    mockState.workspace.getEmployee.mockReturnValue({ id: 'user-1', name: 'U' })
    expect(service.setEnabled('user-1', false)).toBe(true)
    expect(service.isEnabled('user-1')).toBe(false)
  })

  it('记忆开关只对注册员工生效并清理 agent 缓存', () => {
    expect(service.setMemoryEnabled('user-1', true)).toBe(false)
    expect(service.setMemoryEnabled('builtin:plugin-dev', true)).toBe(true)
    expect(mockState.agent.clearAgentCache).toHaveBeenCalledWith('builtin:plugin-dev')
  })

  it('记忆开关关闭后移除标记', () => {
    service.setMemoryEnabled('builtin:plugin-dev', true)
    service.setMemoryEnabled('builtin:plugin-dev', false)
    expect(service.isMemoryEnabled('builtin:plugin-dev')).toBe(false)
  })

  it('KV 配置损坏时按空配置处理（全员启用、记忆关闭）', () => {
    mockState.settings.set(SETTINGS_KEY, '{ broken json')
    expect(service.isEnabled('builtin:plugin-dev')).toBe(true)
    expect(service.isMemoryEnabled('builtin:plugin-dev')).toBe(false)
    // 写入后覆盖损坏值
    service.setEnabled('builtin:plugin-dev', false)
    expect(JSON.parse(mockState.settings.get(SETTINGS_KEY)!).disabled).toEqual(['builtin:plugin-dev'])
  })

  it('KV 中字段类型非法（非数组）时按空集合处理', () => {
    mockState.settings.set(SETTINGS_KEY, JSON.stringify({ disabled: 'x', memoryEnabled: 5 }))
    expect(service.isEnabled('builtin:plugin-dev')).toBe(true)
    expect(service.isMemoryEnabled('builtin:plugin-dev')).toBe(false)
  })

  it('setEnabled 广播员工变更', () => {
    const win = makeWindow()
    mockState.windows.push(win)
    service.setEnabled('builtin:plugin-dev', false)
    expect(win.webContents.send).toHaveBeenCalledWith(IPC_CHANNELS.EMPLOYEE_ON_CHANGED, expect.anything())
  })
})

describe('employee-registry / DBEmployee 与另存副本', () => {
  it('toDBEmployee 输出兼容形状，记忆开关映射为 0/1', () => {
    service.setMemoryEnabled('builtin:plugin-dev', true)
    const e = service.toDBEmployee('builtin:plugin-dev')!
    expect(e.id).toBe('builtin:plugin-dev')
    expect(e.memory_enabled).toBe(1)
    expect(e.arch_version).toBe(1)
    expect(e.workspace_path).toBeNull()
    expect(e.delegation_json).toBeNull()
    expect(service.toDBEmployee('unknown')).toBeNull()
  })

  it('toDBEmployee 未开启记忆时为 0', () => {
    expect(service.toDBEmployee('builtin:knowledge-base')!.memory_enabled).toBe(0)
  })

  it('duplicateAsUser 名称追加「（副本）」后缀', () => {
    const copy = service.duplicateAsUser('builtin:plugin-dev') as any
    expect(copy.name).toBe('插件开发助手（副本）')
    expect(mockState.workspace.createEmployee).toHaveBeenCalledWith(
      '插件开发助手（副本）',
      expect.any(String),
      expect.any(String),
      expect.any(String),
    )
  })

  it('duplicateAsUser：名称以裸「副本」结尾时不追加后缀', () => {
    service.registerPluginEmployees('p10', 'P10', [pluginEmployee({ id: 'copy', source_key: 'copy', name: '助手副本' })])
    service.duplicateAsUser('plugin:p10:copy')
    expect(mockState.workspace.createEmployee).toHaveBeenCalledWith(
      '助手副本', expect.any(String), expect.any(String), expect.any(String),
    )
    service.unregisterPluginEmployees('p10')
  })

  it('duplicateAsUser：名称以「（副本）」结尾时不再重复追加（另存幂等）', () => {
    service.registerPluginEmployees('p10b', 'P10B', [pluginEmployee({ id: 'copy', source_key: 'copy', name: '助手（副本）' })])
    service.duplicateAsUser('plugin:p10b:copy')
    expect(mockState.workspace.createEmployee).toHaveBeenCalledWith(
      '助手（副本）', expect.any(String), expect.any(String), expect.any(String),
    )
    service.unregisterPluginEmployees('p10b')
  })

  it('duplicateAsUser 对未知员工返回 null 且不落库', () => {
    mockState.workspace.createEmployee.mockClear()
    expect(service.duplicateAsUser('unknown')).toBeNull()
    expect(mockState.workspace.createEmployee).not.toHaveBeenCalled()
  })

  it('插件员工注册不原地改写传入对象（避免调用方共享引用被污染）', () => {
    const emp = pluginEmployee({ id: 'dev', source_key: 'dev' })
    service.registerPluginEmployees('p11', 'P11', [emp])
    // 入参保持原样，注册 id 只落在内部副本上
    expect(emp.id).toBe('dev')
    expect(emp.plugin_id).toBeUndefined()
    expect(service.getRegistered('plugin:p11:dev')).not.toBeNull()
  })

  it('缺少 source_key 且重复注册同一对象时 id 稳定（不再叠加 plugin: 前缀）', () => {
    const emp = pluginEmployee({ id: 'k', source_key: undefined })
    service.registerPluginEmployees('p12', 'P12', [emp])
    expect(service.getRegistered('plugin:p12:k')).not.toBeNull()
    service.registerPluginEmployees('p12', 'P12', [emp])
    expect(emp.id).toBe('k')
    expect(service.getRegistered('plugin:p12:k')).not.toBeNull()
    expect(service.getRegistered('plugin:p12:plugin:p12:k')).toBeNull()
  })
})
