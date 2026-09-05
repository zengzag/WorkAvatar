import { BrowserWindow } from 'electron'
import { createLogger } from './logger'
import { IPC_CHANNELS } from '../../shared/ipc-channels'
import type { Employee } from '../../shared/types'
import type { DBEmployee } from '../../shared/db-types'
import DatabaseService from './database.service'

const logger = createLogger('EmployeeRegistry')

/** 注册员工配置存储 key（settings KV）：{ disabled: string[], memoryEnabled: string[] } */
const SETTINGS_KEY = 'registered_employees.config'

/** 内置员工静态声明（随应用发布，运行时注册不落库，用户改动通过另存副本沉淀） */
export interface RegisteredEmployee extends Employee {
  /** 默认启用的工具 id 列表（含插件工具），空/缺省表示全部按宿主默认模式 */
  defaultTools?: string[]
}

interface PluginEmployeeGroup {
  pluginName: string
  employees: RegisteredEmployee[]
}

/**
 * 员工注册表（只读来源员工：内置 + 插件）。
 * - 内置员工：宿主静态声明，随应用发布。
 * - 插件员工：插件 manifest.employees 声明，插件激活成功时注入、禁用/删除/重载时下线。
 * - 注册员工不落库、不可编辑/删除，用户个性化通过「另存副本」生成 user 员工。
 * - 员工全局 id 规则：builtin:<key> / plugin:<pluginId>:<key>，杜绝跨来源冲突。
 */
class EmployeeRegistryService {
  private static instance: EmployeeRegistryService
  private builtin = new Map<string, RegisteredEmployee>()
  private pluginGroups = new Map<string, PluginEmployeeGroup>()

  private constructor() {
    this.seedBuiltin()
  }

  static getInstance(): EmployeeRegistryService {
    if (!EmployeeRegistryService.instance) {
      EmployeeRegistryService.instance = new EmployeeRegistryService()
    }
    return EmployeeRegistryService.instance
  }

  /** 内置员工定义初始化（可扩展新员工只需追加一条） */
  private seedBuiltin(): void {
    const register = (emp: RegisteredEmployee) => {
      this.builtin.set(emp.id, emp)
    }
    register({
      id: 'builtin:knowledge-base',
      source: 'builtin',
      source_key: 'knowledge-base',
      name: '资料搜索助手',
      description: '通用信息搜索助手：本地资料库检索 + 网络搜索双通道，快速定位内部文档与外部资讯，答案自动注明文件路径与网页链接。',
      rules: [
        '你是「资料搜索助手」，面向信息检索场景的通用搜索助理，服务一切「找信息」的需求：既能在本地资料库中查找内部文档，也能联网搜索实时资讯。',
        '定位与职责：',
        '- 信息检索是你的核心能力。用户需要查找、核实、检索任何信息时，由你完成。',
        '- 本地资料优先：涉及内部文档、历史资料、个人笔记、技术手册等本地内容时，调用 kms_search 检索本地资料库（概念性/语义性问题建议 search_mode="hybrid" 兼顾精确匹配与语义相似）。',
        '- 网络搜索兜底：本地无结果，或内容属外部实时/公开信息（新闻、行情、最新技术、公开资料等）时，调用 web_search 联网搜索，必要时用 web_fetch 获取网页正文深入阅读。',
        '- 两条通道可组合：难以判断时效性时先检索本地，再补网络搜索相互印证。',
        '工具使用规范：',
        '- kms_search：检索本地资料库，返回带路径的文档片段；结果自动附带知识卡片与合集摘要。',
        '- kms_get_content：拿到 kms_search 的 file_id 后读取正文细节（view=content/toc/paragraphs 定位）。',
        '- kms_list_collections：了解当前可用的资料合集范围（会话限定了合集时，检索默认在其内进行）。',
        '- web_search：联网搜索，返回标题/链接/摘要；结果不足或需细节时用 web_fetch 抓取网页全文。',
        '- 通道选择：本地历史/内部资料→本地检索；外部实时/公开信息→联网搜索；难以判断→两条通道都尝试并综合回答。',
        '原则：',
        '- 答案必须注明引用来源：本地文档给出文件路径，网络内容给出网页链接。',
        '- 本地与网络都无结果时如实说明，并给出可行建议（调整关键词、换混合检索、扩大合集范围等），绝不臆造内容。',
      ].join('\n'),
      profile_json: JSON.stringify({ roleName: '资料搜索助手' }),
      avatar_type: 'default',
      memory_enabled: false,
      arch_version: 1,
      total_tasks: 0,
      total_approvals: 0,
      created_at: 0,
      updated_at: 0,
      defaultTools: ['kms_search', 'kms_get_content', 'kms_list_collections', 'web_search', 'web_fetch'],
    })
  }

  /** 内置员工（稳定顺序，与 seed 顺序一致） */
  getBuiltinEmployees(): RegisteredEmployee[] {
    return Array.from(this.builtin.values()).map(e => this.withEnabled(e))
  }

  /** 插件员工分组（仅激活成功且声明了员工的插件） */
  getPluginGroups(): Array<{ pluginId: string; pluginName: string; employees: RegisteredEmployee[] }> {
    const groups: Array<{ pluginId: string; pluginName: string; employees: RegisteredEmployee[] }> = []
    for (const [pluginId, group] of this.pluginGroups) {
      if (group.employees.length === 0) continue
      groups.push({ pluginId, pluginName: group.pluginName, employees: group.employees.map(e => this.withEnabled(e)) })
    }
    return groups
  }

  /** 全部注册员工（内置在前，插件按注册顺序） */
  listRegistered(): RegisteredEmployee[] {
    return [...this.getBuiltinEmployees(), ...this.getPluginGroups().flatMap(g => g.employees)]
  }

  getRegistered(id: string): RegisteredEmployee | null {
    const found = this.builtin.get(id) ?? this.findInPluginGroups(id)
    return found ? this.withEnabled(found) : null
  }

  /** 在返回的注册员工对象上附加启用状态与记忆开关状态 */
  private withEnabled(e: RegisteredEmployee): RegisteredEmployee {
    return { ...e, is_enabled: this.isEnabled(e.id), memory_enabled: this.isMemoryEnabled(e.id) }
  }

  private findInPluginGroups(id: string): RegisteredEmployee | null {
    for (const group of this.pluginGroups.values()) {
      const found = group.employees.find(e => e.id === id)
      if (found) return found
    }
    return null
  }

  isRegistered(id: string): boolean {
    return this.getRegistered(id) !== null
  }

  // ====== 配置状态（settings KV，重启持久）：{ disabled, memoryEnabled } ======

  private readConfig(): { disabled: Set<string>; memoryEnabled: Set<string> } {
    try {
      const row = DatabaseService.getInstance().getDb()
        .prepare('SELECT value FROM settings WHERE key = ?').get(SETTINGS_KEY) as { value: string } | undefined
      if (!row?.value) return { disabled: new Set(), memoryEnabled: new Set() }
      const parsed = JSON.parse(row.value)
      return {
        disabled: new Set(Array.isArray(parsed?.disabled) ? parsed.disabled : []),
        memoryEnabled: new Set(Array.isArray(parsed?.memoryEnabled) ? parsed.memoryEnabled : []),
      }
    } catch {
      return { disabled: new Set(), memoryEnabled: new Set() }
    }
  }

  private writeConfig(config: { disabled: Set<string>; memoryEnabled: Set<string> }): void {
    DatabaseService.getInstance().getDb()
      .prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
      .run(SETTINGS_KEY, JSON.stringify({
        disabled: Array.from(config.disabled),
        memoryEnabled: Array.from(config.memoryEnabled),
      }))
  }

  isEnabled(id: string): boolean {
    return !this.readConfig().disabled.has(id)
  }

  /** 启用/禁用员工（注册员工与 user 员工均生效），变更后广播刷新员工库 */
  setEnabled(id: string, enabled: boolean): boolean {
    const inRegistry = this.getRegistered(id) !== null
    const inDb = (() => {
      try {
        const { default: WorkspaceManagerService } = require('./workspace-manager.service') as typeof import('./workspace-manager.service')
        return WorkspaceManagerService.getInstance().getEmployee(id) !== null
      } catch {
        return false
      }
    })()
    if (!inRegistry && !inDb) return false
    const config = this.readConfig()
    if (enabled) config.disabled.delete(id)
    else config.disabled.add(id)
    this.writeConfig(config)
    this.broadcastEmployeeChanged()
    return true
  }

  isMemoryEnabled(id: string): boolean {
    return this.readConfig().memoryEnabled.has(id)
  }

  /** 开启/关闭注册员工的跨任务记忆（记忆数据按注册员工 id 存取） */
  setMemoryEnabled(id: string, enabled: boolean): boolean {
    if (!this.getRegistered(id)) return false
    const config = this.readConfig()
    if (enabled) config.memoryEnabled.add(id)
    else config.memoryEnabled.delete(id)
    this.writeConfig(config)
    this.broadcastEmployeeChanged()
    // 记忆开关影响 agent 构造，清理缓存使下次对话生效
    const { default: EmployeeAgentService } = require('./employee-agent.service') as typeof import('./employee-agent.service')
    try { EmployeeAgentService.getInstance().clearAgentCache(id) } catch { /* ignore */ }
    return true
  }

  /** 注册员工 → DBEmployee 兼容形状（供 agent 创建 / 对话创建等链路回退解析） */
  toDBEmployee(id: string): DBEmployee | null {
    const emp = this.getRegistered(id)
    if (!emp) return null
    return {
      id: emp.id,
      workspace_path: null,
      name: emp.name,
      description: emp.description,
      rules: emp.rules,
      avatar_type: emp.avatar_type,
      status: 'active',
      default_skill_id: emp.default_skill_id || null,
      profile_json: emp.profile_json,
      delegation_json: null,
      memory_enabled: this.isMemoryEnabled(id) ? 1 : 0,
      arch_version: 1,
      total_tasks: 0,
      total_approvals: 0,
      created_at: 0,
      updated_at: 0,
    }
  }

  /** 注册员工上下线后广播，通知前端刷新员工库（与 workspace-manager 的变更事件一致） */
  private broadcastEmployeeChanged(): void {
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) {
        try { win.webContents.send(IPC_CHANNELS.EMPLOYEE_ON_CHANGED, { ts: Date.now() }) } catch { /* ignore */ }
      }
    }
  }

  /** 插件激活成功时注册其 manifest 声明的员工（重复注册以最新为准） */
  registerPluginEmployees(pluginId: string, pluginName: string, employees: RegisteredEmployee[]): void {
    if (!employees || employees.length === 0) return
    for (const emp of employees) {
      emp.id = `plugin:${pluginId}:${emp.source_key || emp.id}`
      emp.source = 'plugin'
      emp.plugin_id = pluginId
      emp.plugin_name = pluginName
    }
    this.pluginGroups.set(pluginId, { pluginName, employees })
    logger.info(`插件员工注册: ${pluginId} 共 ${employees.length} 个`)
    this.syncRegisteredToDb()
    this.broadcastEmployeeChanged()
  }

  /**
   * 确保注册员工（内置/插件）在 employees 表存在影子记录。
   * 影子记录仅作 conversations 等表外键引用的占位（id 为稳定注册 id，幂等 UPSERT，跨版本不变），
   * 不参与员工列表展示；插件下线时保留记录以避免外键级联删除既有会话。
   */
  ensureDbRecords(): void {
    try {
      this.syncRegisteredToDb()
    } catch (err: any) {
      logger.warn('同步注册员工影子记录失败:', err?.message || err)
    }
  }

  private syncRegisteredToDb(): void {
    const employees = this.listRegistered()
    if (employees.length === 0) return
    const db = DatabaseService.getInstance().getDb()
    const now = Math.floor(Date.now() / 1000)
    const stmt = db.prepare(`
      INSERT INTO employees (id, workspace_path, name, description, rules, profile_json, avatar_type, arch_version, total_tasks, total_approvals, is_registered, created_at, updated_at)
      VALUES (?, NULL, ?, ?, ?, ?, 'default', 1, 0, 0, 1, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        workspace_path = excluded.workspace_path,
        name = excluded.name,
        description = excluded.description,
        rules = excluded.rules,
        profile_json = excluded.profile_json,
        avatar_type = excluded.avatar_type,
        is_registered = 1,
        updated_at = excluded.updated_at
    `)
    const tx = db.transaction((rows: RegisteredEmployee[]) => {
      for (const e of rows) {
        stmt.run(e.id, e.name, e.description || '', e.rules || '', e.profile_json || '', now, now)
      }
    })
    tx(employees)
  }

  /** 插件禁用/删除/重载时下线其员工 */
  unregisterPluginEmployees(pluginId: string): void {
    const group = this.pluginGroups.get(pluginId)
    if (!group) return
    this.pluginGroups.delete(pluginId)
    logger.info(`插件员工下线: ${pluginId} 共 ${group.employees.length} 个`)
    this.broadcastEmployeeChanged()
  }

  /** 热重载时清理全部插件员工（内置保留） */
  resetPluginEmployees(): void {
    if (this.pluginGroups.size > 0) {
      this.pluginGroups.clear()
      this.broadcastEmployeeChanged()
    }
  }

  /** 注册员工默认工具模式：命中声明返回覆盖表，否则 null（走宿主默认） */
  getDefaultToolModes(employeeId: string): Map<string, 'on' | 'on_demand'> | null {
    const emp = this.getRegistered(employeeId)
    if (!emp?.defaultTools || emp.defaultTools.length === 0) return null
    const map = new Map<string, 'on' | 'on_demand'>()
    for (const id of emp.defaultTools) map.set(id, 'on')
    return map
  }

  /**
   * 另存副本：把内置/插件员工复制为用户员工（DB 落库，规则/画像一并带入）。
   * 名称追加「副本」后缀避免与原型混淆；workspace 由 createEmployee 重新生成。
   */
  duplicateAsUser(id: string): Employee | null {
    const emp = this.getRegistered(id)
    if (!emp) return null
    const { default: WorkspaceManagerService } = require('./workspace-manager.service') as typeof import('./workspace-manager.service')
    const workspace = WorkspaceManagerService.getInstance()
    const copyName = /副本$/.test(emp.name) ? emp.name : `${emp.name}（副本）`
    return workspace.createEmployee(copyName, emp.description, emp.profile_json, emp.rules)
  }
}

export default EmployeeRegistryService