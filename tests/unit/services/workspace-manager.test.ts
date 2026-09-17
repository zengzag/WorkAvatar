/**
 * 工作区/员工管理服务单测（database 打桩，内存表模拟 employees / conversations / settings）：
 * - isWithinEmployeesRoot 边界判定（含 employees-evil 前缀陷阱）
 * - getRegistryWorkspaceRoot 稳定哈希目录（跨调用可复现）
 * - createEmployee / updateEmployee（字段白名单、workspace_path 越界拒绝）/ deleteEmployee（目录删除安全校验）
 * - createConversation 任务工作区策略（复用/子会话/越界回退）与 FTS 写入规则
 * - transferConversations 的归属转移与工作区迁移安全校验
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'

const mockState = vi.hoisted(() => {
  const settings = new Map<string, string>()
  const employees = new Map<string, any>()
  const conversations = new Map<string, any>()
  const ftsRows: any[] = []
  let dataDir = ''
  const norm = (s: string) => s.replace(/\s+/g, ' ').trim()

  function parseSetClause(s: string): string[] {
    const setPart = s.slice(s.indexOf('SET ') + 4, s.indexOf(' WHERE '))
    return setPart.split(',').map(x => x.trim())
  }

  function applyUpdate(table: Map<string, any>, s: string, args: any[]) {
    const cols = parseSetClause(s)
    const whereId = args[args.length - 1]
    const row = table.get(whereId)
    if (!row) return { changes: 0 }
    let vi = 0
    for (const col of cols) {
      const name = col.split('=')[0].trim()
      if (col.endsWith('= ?')) {
        row[name] = args[vi++]
      } else if (col.endsWith('= unixepoch()')) {
        row[name] = Math.floor(Date.now() / 1000)
      }
    }
    return { changes: 1 }
  }

  const db = {
    prepare(sql: string) {
      const s = norm(sql)
      if (s === 'SELECT value FROM settings WHERE key = ?') {
        return { get: (k: string) => (settings.has(k) ? { value: settings.get(k) } : undefined) }
      }
      if (s.startsWith('INSERT INTO settings')) {
        return { run: (k: string, v: string) => { settings.set(k, v); return { changes: 1 } } }
      }
      if (s === 'SELECT * FROM employees ORDER BY COALESCE(last_active_at, 0) DESC, updated_at DESC') {
        return { all: () => [...employees.values()] }
      }
      if (s === 'SELECT * FROM employees WHERE id = ?' || s === 'SELECT id, workspace_path FROM employees WHERE id = ?' || s === 'SELECT workspace_path FROM employees WHERE id = ?') {
        return { get: (id: string) => employees.get(id) }
      }
      if (s.startsWith('INSERT INTO employees')) {
        return {
          run: (...a: any[]) => {
            employees.set(a[0], {
              id: a[0], workspace_path: a[1], name: a[2], description: a[3], rules: a[4],
              profile_json: a[5], avatar_type: 'default', arch_version: 1, total_tasks: 0,
              total_approvals: 0, memory_enabled: 0, created_at: a[6], updated_at: a[7],
            })
            return { changes: 1 }
          },
        }
      }
      if (s.startsWith('UPDATE employees SET last_active_at = MAX(COALESCE(last_active_at, 0), ?)')) {
        return {
          run: (ts: number, id: string) => {
            const row = employees.get(id)
            if (!row) return { changes: 0 }
            row.last_active_at = Math.max(row.last_active_at ?? 0, ts)
            return { changes: 1 }
          },
        }
      }
      if (s.startsWith('UPDATE employees SET ')) {
        return { run: (...args: any[]) => applyUpdate(employees, s, args) }
      }
      if (s === 'DELETE FROM employees WHERE id = ?') {
        return { run: (id: string) => ({ changes: employees.delete(id) ? 1 : 0 }) }
      }
      if (s.startsWith('SELECT MAX(COALESCE(last_message_at, created_at)) AS latest FROM conversations')) {
        return {
          get: (empId: string) => {
            const list = [...conversations.values()].filter(c => c.employee_id === empId)
            if (list.length === 0) return { latest: null }
            return { latest: Math.max(...list.map(c => c.last_message_at ?? c.created_at ?? 0)) }
          },
        }
      }
      if (s === 'SELECT * FROM conversations WHERE id = ?' || s === 'SELECT workspace_path FROM conversations WHERE id = ?') {
        return { get: (id: string) => conversations.get(id) }
      }
      if (s.startsWith('SELECT employee_id') && s.includes('FROM conversations WHERE id = ?')) {
        return { get: (id: string) => conversations.get(id) }
      }
      if (s === 'SELECT employee_id, COALESCE(last_message_at, created_at) AS ts FROM conversations WHERE id = ?') {
        return { get: (id: string) => conversations.get(id) }
      }
      if (s === 'DELETE FROM conversations_fts WHERE conversation_id = ?') {
        return { run: (id: string) => { const i = ftsRows.findIndex(r => r.conversation_id === id); if (i >= 0) ftsRows.splice(i, 1); return { changes: 1 } } }
      }
      if (s.startsWith('INSERT INTO conversations_fts')) {
        return { run: (...a: any[]) => { ftsRows.push({ title: a[0], summary: a[1], content_preview: a[2], conversation_id: a[3], employee_id: a[4] }); return { changes: 1 } } }
      }
      if (s === 'UPDATE conversations_fts SET employee_id = ? WHERE employee_id = ?') {
        return { run: () => ({ changes: 1 }) }
      }
      if (s.startsWith('INSERT INTO conversations')) {
        return {
          run: (...a: any[]) => {
            conversations.set(a[0], {
              id: a[0], employee_id: a[1], skill_id: a[2], title: a[3], messages_json: '[]',
              message_count: 0, minimal_mode: a[4], status: 'active', workspace_path: a[5],
              parent_conversation_id: a[6], created_at: a[7], updated_at: a[8], last_message_at: null,
            })
            return { changes: 1 }
          },
        }
      }
      if (s.startsWith('UPDATE conversations SET employee_id = ?, updated_at = unixepoch() WHERE employee_id = ?')) {
        return {
          run: (to: string, from: string) => {
            let changes = 0
            for (const c of conversations.values()) {
              if (c.employee_id === from) { c.employee_id = to; changes++ }
            }
            return { changes }
          },
        }
      }
      if (s.startsWith('UPDATE conversations SET workspace_path = ? || substr(workspace_path, ?)')) {
        return {
          run: (dest: string, charCount: number, pattern: string) => {
            // SQL substr(str, N) 为 1-based：对应 JS 的 slice(N - 1)
            const start = charCount - 1
            // 还原 SQL LIKE ESCAPE '\' 的转义：先还原 \\ 再还原 \% 与 \_
            const prefix = pattern.slice(0, -1).replace(/\\\\/g, '\\').replace(/\\%/g, '%').replace(/\\_/g, '_')
            let changes = 0
            for (const c of conversations.values()) {
              if (typeof c.workspace_path === 'string' && c.workspace_path.startsWith(prefix)) {
                c.workspace_path = dest + [...c.workspace_path].slice(start).join('')
                changes++
              }
            }
            return { changes }
          },
        }
      }
      if (s.startsWith('UPDATE conversations SET ')) {
        return { run: (...args: any[]) => applyUpdate(conversations, s, args) }
      }
      if (s === 'DELETE FROM conversations_fts WHERE conversation_id = ?') {
        return { run: (id: string) => { const i = ftsRows.findIndex(r => r.conversation_id === id); if (i >= 0) ftsRows.splice(i, 1); return { changes: 1 } } }
      }
      if (s.startsWith('INSERT INTO conversations_fts')) {
        return { run: (...a: any[]) => { ftsRows.push({ title: a[0], summary: a[1], content_preview: a[2], conversation_id: a[3], employee_id: a[4] }); return { changes: 1 } } }
      }
      if (s === 'UPDATE conversations_fts SET employee_id = ? WHERE employee_id = ?') {
        return { run: () => ({ changes: 1 }) }
      }
      throw new Error(`unexpected sql: ${s}`)
    },
  }

  return {
    settings, employees, conversations, ftsRows, db,
    getDataDir: () => dataDir,
    setDataDir: (v: string) => { dataDir = v },
  }
})

vi.mock('electron', () => ({
  BrowserWindow: { getAllWindows: () => [] },
}))

vi.mock('../../../electron/main/services/path.service', () => ({
  default: { getInstance: () => ({ getDataDir: () => mockState.getDataDir() }) },
}))

vi.mock('../../../electron/main/services/database.service', () => ({
  default: { getInstance: () => ({ getDb: () => mockState.db }) },
}))

import WorkspaceManagerService from '../../../electron/main/services/workspace-manager.service'
import EmployeeRegistryService from '../../../electron/main/services/employee-registry.service'

const service = WorkspaceManagerService.getInstance()

let root = ''
let dataDir = ''
let employeesRoot = ''

beforeEach(() => {
  mockState.settings.clear()
  mockState.employees.clear()
  mockState.conversations.clear()
  mockState.ftsRows.length = 0
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-ws-test-'))
  dataDir = path.join(root, 'data')
  employeesRoot = path.join(dataDir, 'employees')
  fs.mkdirSync(employeesRoot, { recursive: true })
  mockState.setDataDir(dataDir)
})

describe('workspace-manager / isWithinEmployeesRoot', () => {
  it('employees 子路径（含多级）视为合法', () => {
    expect(service.isWithinEmployeesRoot(path.join(employeesRoot, 'a'))).toBe(true)
    expect(service.isWithinEmployeesRoot(path.join(employeesRoot, 'a', 'b', 'c'))).toBe(true)
  })

  it('employees 根目录自身不算合法（防止递归删除全部工作区）', () => {
    expect(service.isWithinEmployeesRoot(employeesRoot)).toBe(false)
  })

  it('非 employees 路径与同前缀兄弟目录被拒绝', () => {
    expect(service.isWithinEmployeesRoot(dataDir)).toBe(false)
    expect(service.isWithinEmployeesRoot(path.join(root, 'other'))).toBe(false)
    expect(service.isWithinEmployeesRoot(`${employeesRoot}-evil`)).toBe(false)
    expect(service.isWithinEmployeesRoot(path.join(dataDir, 'employees-evil', 'x'))).toBe(false)
  })

  it('含 .. 的相对路径按解析结果判定', () => {
    expect(service.isWithinEmployeesRoot(path.join(employeesRoot, 'a', '..', 'b'))).toBe(true)
    expect(service.isWithinEmployeesRoot(path.join(employeesRoot, '..', 'outside'))).toBe(false)
  })
})

describe('workspace-manager / getRegistryWorkspaceRoot', () => {
  it('生成稳定 8 位哈希目录并落盘', () => {
    const first = service.getRegistryWorkspaceRoot('builtin:knowledge-base')
    const second = service.getRegistryWorkspaceRoot('builtin:knowledge-base')
    expect(first).toBe(second)
    expect(path.dirname(first)).toBe(employeesRoot)
    expect(path.basename(first)).toMatch(/^[0-9a-f]{8}$/)
    expect(fs.existsSync(first)).toBe(true)
  })

  it('不同员工 id 映射到不同目录', () => {
    const a = service.getRegistryWorkspaceRoot('builtin:knowledge-base')
    const b = service.getRegistryWorkspaceRoot('plugin:p1:dev')
    expect(a).not.toBe(b)
  })
})

describe('workspace-manager / 员工 CRUD', () => {
  it('createEmployee 创建 employees 下的短 ID 工作区并落库', () => {
    const emp = service.createEmployee('员工A', '描述', '{"roleName":"A"}', '规则')
    expect(emp.name).toBe('员工A')
    expect(path.dirname(emp.workspace_path!)).toBe(employeesRoot)
    expect(path.basename(emp.workspace_path!)).toHaveLength(8)
    expect(fs.existsSync(emp.workspace_path!)).toBe(true)
    expect(mockState.employees.get(emp.id)!.rules).toBe('规则')
  })

  it('createEmployee 默认参数为空串', () => {
    const emp = service.createEmployee('员工B')
    expect(emp.description).toBe('')
    expect(emp.rules).toBe('')
    expect(emp.profile_json).toBe('')
  })

  it('updateEmployee 未知员工返回 null', () => {
    expect(service.updateEmployee('nope', { name: 'x' })).toBeNull()
  })

  it('updateEmployee 仅接受白名单字段，未知字段被忽略', () => {
    const emp = service.createEmployee('员工C')
    const updated = service.updateEmployee(emp.id, {
      name: '改名',
      ...({ id: 'hacked', created_at: 1, is_registered: 1, total_tasks: 99 } as any),
    })!
    expect(updated.name).toBe('改名')
    expect(updated.id).toBe(emp.id)
    expect((updated as any).is_registered).toBeUndefined()
    expect((updated as any).total_tasks).toBe(0)
  })

  it('updateEmployee 拒绝 employees 目录之外的 workspace_path', () => {
    const emp = service.createEmployee('员工D')
    const outside = path.join(root, 'evil-dir')
    const updated = service.updateEmployee(emp.id, { workspace_path: outside })!
    expect(updated.workspace_path).toBe(emp.workspace_path)
  })

  it('updateEmployee 允许将 workspace_path 重置为空串 / null', () => {
    const emp = service.createEmployee('员工E')
    expect(service.updateEmployee(emp.id, { workspace_path: '' })!.workspace_path).toBe('')
    expect(service.updateEmployee(emp.id, { workspace_path: null })!.workspace_path).toBeNull()
  })

  it('updateEmployee memory_enabled 转 0/1，且 undefined 字段不参与更新', () => {
    const emp = service.createEmployee('员工F')
    expect(service.updateEmployee(emp.id, { memory_enabled: true })!.memory_enabled).toBe(1)
    expect(service.updateEmployee(emp.id, { memory_enabled: false })!.memory_enabled).toBe(0)
    const before = service.updateEmployee(emp.id, { name: 'G' })!
    expect(before.memory_enabled).toBe(0)
  })

  it('updateEmployee 无有效字段时仍返回当前记录', () => {
    const emp = service.createEmployee('员工G')
    const updated = service.updateEmployee(emp.id, {})!
    expect(updated.name).toBe('员工G')
  })

  it('deleteEmployee 未知员工返回 false', () => {
    expect(service.deleteEmployee('nope')).toBe(false)
  })

  it('deleteEmployee 默认保留工作区目录', () => {
    const emp = service.createEmployee('员工H')
    expect(service.deleteEmployee(emp.id)).toBe(true)
    expect(fs.existsSync(emp.workspace_path!)).toBe(true)
    expect(mockState.employees.has(emp.id)).toBe(false)
  })

  it('deleteEmployee(deleteWorkspace=true) 删除 employees 下的工作区目录', () => {
    const emp = service.createEmployee('员工I')
    fs.writeFileSync(path.join(emp.workspace_path!, 'file.txt'), 'x')
    expect(service.deleteEmployee(emp.id, true)).toBe(true)
    expect(fs.existsSync(emp.workspace_path!)).toBe(false)
  })

  it('deleteEmployee(deleteWorkspace=true) 拒绝删除 employees 之外的目录', () => {
    const emp = service.createEmployee('员工J')
    const outside = path.join(root, 'keep-me')
    fs.mkdirSync(outside, { recursive: true })
    mockState.employees.get(emp.id)!.workspace_path = outside
    expect(service.deleteEmployee(emp.id, true)).toBe(true)
    expect(fs.existsSync(outside)).toBe(true)
    expect(mockState.employees.has(emp.id)).toBe(false)
  })

  it('touchEmployeeLastActive 显式时间戳只增不减', () => {
    const emp = service.createEmployee('员工K')
    service.touchEmployeeLastActive(emp.id, 1000)
    expect(service.getEmployee(emp.id)!.last_active_at).toBe(1000)
    service.touchEmployeeLastActive(emp.id, 500)
    expect(service.getEmployee(emp.id)!.last_active_at).toBe(1000)
    service.touchEmployeeLastActive(emp.id, 2000)
    expect(service.getEmployee(emp.id)!.last_active_at).toBe(2000)
  })

  it('touchEmployeeLastActive 无时间戳时按会话最大时间聚合', () => {
    const emp = service.createEmployee('员工L')
    service.createConversation(emp.id)
    const conv = [...mockState.conversations.values()][0]
    conv.last_message_at = 3000
    service.touchEmployeeLastActive(emp.id)
    expect(service.getEmployee(emp.id)!.last_active_at).toBe(3000)
  })
})

describe('workspace-manager / createConversation 任务工作区', () => {
  it('未知员工且非注册员工时抛错', () => {
    expect(() => service.createConversation('ghost-employee')).toThrow('Employee not found')
  })

  it('顶层会话在员工工作区下创建独立任务目录并写 FTS', () => {
    const emp = service.createEmployee('员工M')
    const conv = service.createConversation(emp.id, undefined, '标题')
    expect(conv.title).toBe('标题')
    expect(conv.parent_conversation_id).toBe('')
    expect(conv.messages_json).toBe('[]')
    expect(conv.workspace_path!.startsWith(emp.workspace_path!)).toBe(true)
    expect(fs.existsSync(conv.workspace_path!)).toBe(true)
    expect(mockState.ftsRows.filter(r => r.conversation_id === conv.id)).toHaveLength(1)
  })

  it('子会话在主会话工作区下建目录且不写 FTS', () => {
    const emp = service.createEmployee('员工N')
    const parent = service.createConversation(emp.id)
    const child = service.createConversation(emp.id, undefined, 'child', undefined, parent.id)
    expect(child.parent_conversation_id).toBe(parent.id)
    expect(child.workspace_path!.startsWith(parent.workspace_path!)).toBe(true)
    expect(mockState.ftsRows.filter(r => r.conversation_id === child.id)).toHaveLength(0)
  })

  it('reuseWorkspacePath 合法时直接复用（不新建目录）', () => {
    const emp = service.createEmployee('员工O')
    const src = service.createConversation(emp.id)
    const reuse = service.createConversation(emp.id, undefined, '复用', undefined, undefined, src.workspace_path!)
    expect(reuse.workspace_path).toBe(src.workspace_path)
  })

  // 回归：非法 reuseWorkspacePath 须回退到正常的员工工作区任务目录创建
  it('reuseWorkspacePath 越界时应回退新建任务目录', () => {
    const emp = service.createEmployee('员工P')
    const outside = path.join(root, 'outside-ws')
    fs.mkdirSync(outside, { recursive: true })
    const conv = service.createConversation(emp.id, undefined, 'x', undefined, undefined, outside)
    expect(conv.workspace_path!.startsWith(emp.workspace_path!)).toBe(true)
  })

  it('reuseWorkspacePath 越界时不落在区外路径上', () => {
    const emp = service.createEmployee('员工P2')
    const outside = path.join(root, 'outside-ws2')
    fs.mkdirSync(outside, { recursive: true })
    const conv = service.createConversation(emp.id, undefined, 'x', undefined, undefined, outside)
    expect(conv.workspace_path).not.toBe('')
    expect(conv.workspace_path).not.toBe(outside)
  })

  it('minimalMode 落库为 1', () => {
    const emp = service.createEmployee('员工Q')
    expect(service.createConversation(emp.id, undefined, '', true).minimal_mode).toBe(1)
  })

  it('getConversationWorkspacePath 未知会话返回空串', () => {
    expect(service.getConversationWorkspacePath('nope')).toBe('')
  })

  it('注册员工无 DB 记录时使用注册员工工作区根目录', () => {
    const registryId = 'builtin:knowledge-base'
    expect(EmployeeRegistryService.getInstance().isRegistered(registryId)).toBe(true)
    const conv = service.createConversation(registryId)
    expect(conv.workspace_path!.startsWith(employeesRoot)).toBe(true)
  })
})

describe('workspace-manager / updateConversation 与转移', () => {
  it('updateConversation 无有效字段或未知会话返回 false', () => {
    const emp = service.createEmployee('员工R')
    const conv = service.createConversation(emp.id)
    expect(service.updateConversation(conv.id, {})).toBe(false)
    expect(service.updateConversation(conv.id, { unknown: 1 } as any)).toBe(false)
    expect(service.updateConversation('nope', { title: 'x' })).toBe(false)
  })

  it('updateConversation 允许的字段被写入，minimal_mode 转 0/1', () => {
    const emp = service.createEmployee('员工S')
    const conv = service.createConversation(emp.id)
    expect(service.updateConversation(conv.id, { title: 'T2', minimal_mode: true, message_count: 5 })).toBe(true)
    const stored = mockState.conversations.get(conv.id)!
    expect(stored.title).toBe('T2')
    expect(stored.minimal_mode).toBe(1)
    expect(stored.message_count).toBe(5)
  })

  it('transferConversations 参数非法 / 目标不存在返回 0', () => {
    const emp = service.createEmployee('员工T')
    expect(service.transferConversations('', emp.id)).toBe(0)
    expect(service.transferConversations(emp.id, emp.id)).toBe(0)
    expect(service.transferConversations(emp.id, 'ghost')).toBe(0)
  })

  it('transferConversations 迁移会话归属并同步 FTS 与工作区目录', () => {
    const from = service.createEmployee('来源')
    const to = service.createEmployee('目标')
    const conv = service.createConversation(from.id)
    const fromRoot = from.workspace_path!
    const toRoot = to.workspace_path!
    const taskDir = conv.workspace_path!
    fs.writeFileSync(path.join(taskDir, 'f.txt'), 'x')

    const moved = service.transferConversations(from.id, to.id)

    expect(moved).toBe(1)
    expect(mockState.conversations.get(conv.id)!.employee_id).toBe(to.id)
    const newDir = path.join(toRoot, path.basename(fromRoot))
    expect(fs.existsSync(newDir)).toBe(true)
    expect(fs.existsSync(fromRoot)).toBe(false)
    expect(mockState.conversations.get(conv.id)!.workspace_path).toBe(
      path.join(newDir, path.basename(taskDir)),
    )
  })

  it('transferConversations 工作区越界时不迁移目录但会话仍转移', () => {
    const from = service.createEmployee('来源2')
    const to = service.createEmployee('目标2')
    const conv = service.createConversation(from.id)
    const outside = path.join(root, 'outside-root')
    fs.mkdirSync(outside, { recursive: true })
    mockState.employees.get(from.id)!.workspace_path = outside

    const moved = service.transferConversations(from.id, to.id)
    expect(moved).toBe(1)
    expect(fs.existsSync(outside)).toBe(true)
    expect(mockState.conversations.get(conv.id)!.employee_id).toBe(to.id)
  })

  it('transferConversations 目标工作区已被同名目录占用时追加短 ID', () => {
    const from = service.createEmployee('来源3')
    const to = service.createEmployee('目标3')
    service.createConversation(from.id)
    const fromRoot = from.workspace_path!
    fs.mkdirSync(path.join(to.workspace_path!, path.basename(fromRoot)), { recursive: true })

    expect(service.transferConversations(from.id, to.id)).toBe(1)
    const siblings = fs.readdirSync(to.workspace_path!)
    expect(siblings.length).toBe(2)
    expect(siblings.some(n => n.startsWith(`${path.basename(fromRoot)}-`))).toBe(true)
  })
})
