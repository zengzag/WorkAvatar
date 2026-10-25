import fs from 'fs'
import path from 'path'
import crypto from 'crypto'
import { BrowserWindow } from 'electron'
import type { Employee, Conversation } from '../../shared/types'
import DatabaseService from './database.service'
import PathService from './path.service'
import EmployeeRegistryService from './employee-registry.service'
import SkillRegistryService from './skill-registry.service'
import { generateId, generateShortId, moveToTrash } from './common-utils'
import {
  buildConversationFtsMatch,
  buildConversationLikeTerms,
  buildConversationPreview,
  buildConversationSnippet,
  segmentConversationText,
} from './conversation-fts'
import { createLogger } from './logger'
import { IPC_CHANNELS } from '../../shared/ipc-channels'

const logger = createLogger('WorkspaceManager')

/** 默认员工播种标记（settings KV）：只在首次安装时创建一次，用户删除后不再重建 */
const DEFAULT_EMPLOYEE_SEEDED_KEY = 'bootstrap.default_employee_seeded'

/** 新用户开箱即用的默认员工（普通员工，非内置注册员工，可编辑可删除） */
const DEFAULT_EMPLOYEE = {
  name: '通用专家',
  description: '全能型数字员工：信息检索、文档写作、表格与演示、数据处理、代码脚本及日常事务，开箱即用。',
  rules: [
    'You are "General Expert", a general-purpose digital employee who takes everyday work requests from start to finish: research, writing, document processing, data analysis, spreadsheets and presentations, coding/scripting, and file management.',
    'Working style:',
    '- Clarify the goal first, then plan the steps and carry them out yourself instead of asking the user to do manual work.',
    '- Choose the right tools: search the local knowledge base or the web for facts, use file and scripting tools for the actual work, and activate a skill when a task matches one.',
    '- Prefer internal knowledge and existing files, then fall back to external sources.',
    '- Keep every deliverable inside the task workspace. Anything outside it needs the user\'s confirmation.',
    '- Ask the user only when the request is genuinely ambiguous or the decision is theirs to make; otherwise make a reasonable choice and state it.',
    'Output:',
    '- Report concisely what was done, where the result is (file path or URL), and what still needs the user\'s attention.',
  ].join('\n'),
}

class WorkspaceManagerService {
  private db: DatabaseService
  private static instance: WorkspaceManagerService

  private constructor() {
    this.db = DatabaseService.getInstance()
  }

  static getInstance(): WorkspaceManagerService {
    if (!WorkspaceManagerService.instance) {
      WorkspaceManagerService.instance = new WorkspaceManagerService()
    }
    return WorkspaceManagerService.instance
  }

  /** 向订阅插件广播宿主事件（插件宿主不可用/未初始化时静默忽略） */
  private notifyPluginEvent(event: string, payload: unknown): void {
    try {
      const { default: PluginHostService } = require('./plugin/plugin-host.service')
      PluginHostService.getInstance().notifyKernelEvent(event, payload)
    } catch { /* ignore */ }
  }

  getEmployeeList(): Employee[] {
    return this.db.getDb().prepare(
      'SELECT * FROM employees ORDER BY COALESCE(last_active_at, 0) DESC, updated_at DESC'
    ).all() as Employee[]
  }

  /**
   * 刷新员工最近活跃时间（取该员工下所有对话的最大 last_message_at / created_at）。
   * 若 timestamp 传入则直接使用（如发送消息场景），否则从 conversations 表聚合。
   */
  touchEmployeeLastActive(employeeId: string, timestamp?: number): void {
    if (timestamp !== undefined) {
      this.db.getDb().prepare(
        'UPDATE employees SET last_active_at = MAX(COALESCE(last_active_at, 0), ?) WHERE id = ?'
      ).run(timestamp, employeeId)
      return
    }
    const row = this.db.getDb().prepare(
      `SELECT MAX(COALESCE(last_message_at, created_at)) AS latest FROM conversations WHERE employee_id = ?`
    ).get(employeeId) as { latest: number | null } | undefined
    const val = row?.latest ?? null
    this.db.getDb().prepare('UPDATE employees SET last_active_at = ? WHERE id = ?').run(val, employeeId)
  }

  private broadcastEmployeeChanged(): void {
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) {
        try { win.webContents.send(IPC_CHANNELS.EMPLOYEE_ON_CHANGED, { ts: Date.now() }) } catch { /* ignore */ }
      }
    }
  }

  getEmployee(id: string): Employee | null {
    return this.db.getDb().prepare('SELECT * FROM employees WHERE id = ?').get(id) as Employee || null
  }

  createEmployee(name: string, description: string = '', profileJson: string = '', rules: string = ''): Employee {
    const employeeId = generateId()
    const now = Math.floor(Date.now() / 1000)

    const basePath = PathService.getInstance().getDataDir()
    const employeesRoot = path.join(basePath, 'employees')
    // 目录名使用 8 字符短 ID（与 24 字符 DB 主键解耦），重试至多 10 次避免极小概率碰撞
    let workspacePath = ''
    for (let attempt = 0; attempt < 10; attempt++) {
      const candidate = path.join(employeesRoot, generateShortId())
      if (!fs.existsSync(candidate)) {
        workspacePath = candidate
        break
      }
    }
    if (!workspacePath) {
      // 兜底：拼接 employeeId 前缀确保唯一
      workspacePath = path.join(employeesRoot, `${generateShortId()}-${employeeId.slice(0, 4)}`)
    }

    if (!fs.existsSync(workspacePath)) {
      fs.mkdirSync(workspacePath, { recursive: true })
    }

    this.db.getDb().prepare(`
      INSERT INTO employees (id, workspace_path, name, description, rules, profile_json, avatar_type, arch_version, total_tasks, total_approvals, memory_enabled, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, 'default', 1, 0, 0, 1, ?, ?)
    `).run(employeeId, workspacePath, name, description, rules, profileJson, now, now)

    // 新员工默认开启内置 office 技能（pptx/docx/xlsx）
    try {
      SkillRegistryService.getInstance().assignDefaultSkillsToEmployee(employeeId, ['pptx', 'docx', 'xlsx'])
    } catch (err: any) {
      logger.warn(`assign default skills failed: ${err?.message || err}`)
    }

    this.broadcastEmployeeChanged()

    this.notifyPluginEvent('employee:created', { id: employeeId, name })
    return this.getEmployee(employeeId)!
  }

  /**
   * 首次安装播种默认员工「通用专家」，让新用户开箱即用。
   * 仅在从未播种且库中没有任何用户员工时创建（老用户升级不受影响）；
   * 播种后写标记，用户删除后不再重建。
   */
  ensureDefaultEmployee(): void {
    const db = this.db.getDb()
    try {
      const seeded = db.prepare('SELECT value FROM settings WHERE key = ?')
        .get(DEFAULT_EMPLOYEE_SEEDED_KEY) as { value: string } | undefined
      if (seeded?.value === '1') return
      const hasUserEmployee = this.getEmployeeList().some(e => !e.is_registered)
      if (!hasUserEmployee) {
        this.createEmployee(
          DEFAULT_EMPLOYEE.name,
          DEFAULT_EMPLOYEE.description,
          JSON.stringify({ roleName: DEFAULT_EMPLOYEE.name, roleDescription: DEFAULT_EMPLOYEE.rules }),
          DEFAULT_EMPLOYEE.rules,
        )
        logger.info(`已创建默认员工：${DEFAULT_EMPLOYEE.name}`)
      }
      db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
        .run(DEFAULT_EMPLOYEE_SEEDED_KEY, '1')
    } catch (err: any) {
      logger.warn('默认员工播种失败:', err?.message || err)
    }
  }

  updateEmployee(id: string, data: {
    name?: string
    description?: string
    rules?: string
    profile_json?: string
    default_skill_id?: string
    workspace_path?: string | null
    memory_enabled?: boolean
    avatar_type?: string
    avatar_icon?: string
    avatar_color?: string
    delegation_json?: string
  }): Employee | null {
    const employee = this.getEmployee(id)
    if (!employee) return null

    const updates: string[] = []
    const values: any[] = []

    const ALLOWED_COLUMNS = [
      'name', 'description', 'rules', 'profile_json',
      'default_skill_id',
      'memory_enabled', 'workspace_path', 'avatar_type',
      'avatar_icon', 'avatar_color',
      'delegation_json'
    ]

    Object.entries(data).forEach(([key, value]) => {
      if (value !== undefined && ALLOWED_COLUMNS.includes(key)) {
        // workspace_path 是 FilePermissionService 的授权边界，必须位于 employees/ 下，
        // 防止渲染层被注入后把员工授权根指到任意目录（null/空串表示重置，放行）
        if (key === 'workspace_path') {
          if (value === null || value === '') {
            // 允许重置
          } else if (typeof value !== 'string' || !this.isWithinEmployeesRoot(value)) {
            logger.warn(`Rejected employee workspace_path outside employees root: ${value}`)
            return
          }
        }
        if (key === 'memory_enabled') {
          updates.push(`${key} = ?`)
          values.push(value ? 1 : 0)
        } else {
          updates.push(`${key} = ?`)
          values.push(value)
        }
      }
    })

    if (updates.length > 0) {
      updates.push('updated_at = unixepoch()')
      values.push(id)

      this.db.getDb().prepare(`
        UPDATE employees SET ${updates.join(', ')} WHERE id = ?
      `).run(...values)

      this.broadcastEmployeeChanged()
    }

    this.notifyPluginEvent('employee:updated', { id, data })
    return this.getEmployee(id)
  }

  deleteEmployee(id: string, deleteWorkspace: boolean = false): boolean {
    if (deleteWorkspace) {
      const employee = this.getEmployee(id)
      if (employee && employee.workspace_path) {
        // 安全校验：workspace_path 必须位于数据目录的 employees/ 子目录下（且不能是
        // employees 根自身——防止 DB 被篡改后递归删除全部员工工作区）
        const basePath = PathService.getInstance().getDataDir()
        const employeesRoot = path.resolve(basePath, 'employees')
        const workspaceRoot = path.resolve(employee.workspace_path)
        const relative = path.relative(employeesRoot, workspaceRoot)
        const isWithinEmployees = relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative)
        if (!isWithinEmployees) {
          logger.warn(`Refused to delete workspace outside employees root: ${employee.workspace_path}`)
        } else if (fs.existsSync(workspaceRoot)) {
          try { fs.rmSync(workspaceRoot, { recursive: true, force: true }) } catch (error) { logger.warn('Failed to remove workspace directory', workspaceRoot, error) }
        }
      }
    }
    const result = this.db.getDb().prepare('DELETE FROM employees WHERE id = ?').run(id)
    if (result.changes > 0) {
      this.broadcastEmployeeChanged()
      this.notifyPluginEvent('employee:deleted', { id })
    }
    return result.changes > 0
  }

  /**
   * 将员工的全部对话转移到目标员工名下（含委托子会话，避免孤儿记录），
   * 并把员工工作区根目录整体迁入目标员工工作区，保证转移对话的任务文件仍可用。
   * 返回转移的对话数。
   */
  transferConversations(fromEmployeeId: string, toEmployeeId: string): number {
    if (!fromEmployeeId || !toEmployeeId || fromEmployeeId === toEmployeeId) return 0
    const target = this.db.getDb().prepare('SELECT id, workspace_path FROM employees WHERE id = ?').get(toEmployeeId) as { id: string; workspace_path: string | null } | undefined
    if (!target) return 0

    const result = this.db.getDb().prepare(
      'UPDATE conversations SET employee_id = ?, updated_at = unixepoch() WHERE employee_id = ?'
    ).run(toEmployeeId, fromEmployeeId)
    // FTS 员工归属同步（conversations_fts 按 employee_id 过滤检索）
    this.db.getDb().prepare(
      'UPDATE conversations_fts SET employee_id = ? WHERE employee_id = ?'
    ).run(toEmployeeId, fromEmployeeId)

    // 工作区根目录迁移：源员工根 → 目标员工根/原名[-短ID]，避免删除源员工时连带清除已转移对话的任务文件
    const source = this.db.getDb().prepare('SELECT workspace_path FROM employees WHERE id = ?').get(fromEmployeeId) as { workspace_path: string | null } | undefined
    const sourceRoot = source?.workspace_path || ''
    const targetRoot = target.workspace_path
      ?? (EmployeeRegistryService.getInstance().isRegistered(toEmployeeId) ? this.getRegistryWorkspaceRoot(toEmployeeId) : '')
    if (sourceRoot && targetRoot && fs.existsSync(sourceRoot) && fs.existsSync(targetRoot)) {
      const employeesRoot = path.resolve(PathService.getInstance().getDataDir(), 'employees')
      const fromAbs = path.resolve(sourceRoot)
      const relative = path.relative(employeesRoot, fromAbs)
      const isWithinEmployees = relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))
      if (!isWithinEmployees) {
        logger.warn(`Refused to move workspace outside employees root: ${sourceRoot}`)
      } else {
        let dest = path.join(targetRoot, path.basename(fromAbs))
        if (fs.existsSync(dest)) dest = path.join(targetRoot, `${path.basename(fromAbs)}-${generateShortId()}`)
        try {
          fs.renameSync(fromAbs, dest)
          // 重写该员工名下所有对话的 workspace_path 前缀（含子会话）
          const pattern = fromAbs.replace(/[\\%_]/g, (m) => '\\' + m) + '%'
          // SQLite substr 按字符（code point）计数，不能用 JS 的 UTF-16 长度，
          // 路径含代理对字符（emoji）时偏移会错位；[...str].length 即 code point 数
          const fromAbsCharCount = [...fromAbs].length
          this.db.getDb().prepare(
            "UPDATE conversations SET workspace_path = ? || substr(workspace_path, ?), updated_at = unixepoch() WHERE workspace_path LIKE ? ESCAPE '\\'"
          ).run(dest, fromAbsCharCount + 1, pattern)
        } catch (error) {
          logger.warn('Failed to move employee workspace root', fromAbs, error)
        }
      }
    }

    this.touchEmployeeLastActive(fromEmployeeId)
    this.touchEmployeeLastActive(toEmployeeId)
    return Number(result.changes)
  }

  getConversationList(employeeId?: string): Conversation[] {
    if (employeeId) {
      return this.db.getDb().prepare(
        `SELECT id, employee_id, skill_id, title, message_count, minimal_mode, status, workspace_path, parent_conversation_id, created_at, updated_at, last_message_at, context_stats_json, default_model_json, collection_ids_json
         FROM conversations
         WHERE employee_id = ? AND (parent_conversation_id = '' OR parent_conversation_id IS NULL)
         ORDER BY COALESCE(last_message_at, created_at) DESC`
      ).all(employeeId) as Conversation[]
    }
    return this.db.getDb().prepare(
      `SELECT id, employee_id, skill_id, title, message_count, minimal_mode, status, workspace_path, parent_conversation_id, created_at, updated_at, last_message_at, context_stats_json, default_model_json, collection_ids_json
       FROM conversations
       WHERE parent_conversation_id = '' OR parent_conversation_id IS NULL
       ORDER BY COALESCE(last_message_at, created_at) DESC`
    ).all() as Conversation[]
  }

  /** 获取所有对话（跨员工），附带员工名称，仅返回有消息的顶层对话，支持分页 */
  getAllConversationsWithEmployee(params?: { limit?: number; offset?: number; employee_ids?: string[] }): Array<Conversation & { employee_name: string }> {
    let sql = `SELECT c.id, c.employee_id, c.skill_id, c.title, c.message_count, c.minimal_mode, c.status, c.workspace_path, c.parent_conversation_id, c.created_at, c.updated_at, c.last_message_at, c.context_stats_json, c.default_model_json, c.collection_ids_json,
                e.name as employee_name
         FROM conversations c
         LEFT JOIN employees e ON c.employee_id = e.id
         WHERE c.message_count > 0 AND (c.parent_conversation_id = '' OR c.parent_conversation_id IS NULL)`
    const values: any[] = []
    if (params?.employee_ids && params.employee_ids.length > 0) {
      const placeholders = params.employee_ids.map(() => '?').join(',')
      sql += ` AND c.employee_id IN (${placeholders})`
      values.push(...params.employee_ids)
    }
    sql += ` ORDER BY COALESCE(c.last_message_at, c.created_at) DESC`
    if (params?.limit !== undefined) {
      sql += ` LIMIT ?`
      values.push(params.limit)
    }
    if (params?.offset !== undefined) {
      sql += ` OFFSET ?`
      values.push(params.offset)
    }
    const rows = this.db.getDb().prepare(sql).all(...values) as Array<Conversation & { employee_name: string | null }>
    // 注册员工（内置/插件）无 DB 记录，LEFT JOIN 拿不到名称：回退注册表补齐
    return rows.map(row => {
      if (row.employee_name) return row as Conversation & { employee_name: string }
      const reg = EmployeeRegistryService.getInstance().getRegistered(row.employee_id)
      return reg ? { ...row, employee_name: reg.name } : (row as Conversation & { employee_name: string })
    })
  }

  getConversation(id: string): Conversation | null {
    return this.db.getDb().prepare('SELECT * FROM conversations WHERE id = ?').get(id) as Conversation || null
  }

  createConversation(employeeId: string, skillId?: string, title: string = '', minimalMode?: boolean, parentConversationId?: string, reuseWorkspacePath?: string): Conversation {
    // 注册员工（内置/插件）提前同步影子记录到 employees 表，保证 conversations 外键引用有效（id 稳定不变）
    if (EmployeeRegistryService.getInstance().isRegistered(employeeId)) {
      EmployeeRegistryService.getInstance().ensureDbRecords()
    }
    const employee = this.db.getDb().prepare('SELECT id, workspace_path FROM employees WHERE id = ?').get(employeeId) as { id: string; workspace_path: string | null } | undefined
    // 注册员工（内置/插件）无 DB 记录：回退注册表，工作区落在独立的注册员工工作区根目录
    const employeeWorkspace = employee?.workspace_path
      ?? (EmployeeRegistryService.getInstance().isRegistered(employeeId) ? this.getRegistryWorkspaceRoot(employeeId) : undefined)
    if (!employee && !employeeWorkspace) {
      throw new Error(`Employee not found: ${employeeId}`)
    }

    const conversationId = generateId()
    const now = Math.floor(Date.now() / 1000)

    // 任务工作区目录策略：
    // - 有 parentConversationId（委托子会话）：在主管会话的工作区目录下创建子目录
    // - 无 parentConversationId（顶层会话）：在员工工作区下创建独立目录
    let workspacePath = ''
    // 分支任务：直接复用原任务工作区路径，不新建目录（保证 KV cache 前缀一致）。
    // 安全校验：路径必须位于数据目录 employees/ 下（该路径是 FilePermissionService
    // 的授权边界），非法路径直接忽略并回退正常创建，防止把授权根指到任意目录
    const canReuseWorkspace = !!reuseWorkspacePath && this.isWithinEmployeesRoot(reuseWorkspacePath)
    if (reuseWorkspacePath && !canReuseWorkspace) {
      logger.warn(`Rejected reuseWorkspacePath outside employees root: ${reuseWorkspacePath}`)
    }
    if (canReuseWorkspace) {
      workspacePath = reuseWorkspacePath!
    } else if (parentConversationId) {
      const parent = this.db.getDb().prepare('SELECT workspace_path FROM conversations WHERE id = ?').get(parentConversationId) as { workspace_path?: string } | undefined
      const parentWs = parent?.workspace_path || ''
      workspacePath = parentWs ? this.createTaskWorkspace(parentWs) : ''
    } else {
      workspacePath = employeeWorkspace ? this.createTaskWorkspace(employeeWorkspace) : ''
    }

    this.db.getDb().prepare(`
      INSERT INTO conversations (id, employee_id, skill_id, title, messages_json, message_count, minimal_mode, status, workspace_path, parent_conversation_id, created_at, updated_at)
      VALUES (?, ?, ?, ?, '[]', 0, ?, 'active', ?, ?, ?, ?)
    `).run(conversationId, employeeId, skillId || null, title, minimalMode ? 1 : 0, workspacePath, parentConversationId || '', now, now)

    // 子会话（有 parentConversationId）不写入 FTS 索引，避免污染检索结果
    if (!parentConversationId) {
      this.syncConversationFTS(conversationId, employeeId, title, '', '[]')
    }
    this.touchEmployeeLastActive(employeeId, now)

    const conv = this.getConversation(conversationId)!
    this.notifyPluginEvent('conversation:created', { id: conv.id, employeeId, title, parentConversationId })
    return conv
  }

  /**
   * 计算任务独立目录路径（YYYYMMDD_HHmmss，碰撞时追加序号），但不实际创建目录。
   * 工作区懒创建：只有真正写入/执行（file_write / file_copy / shell_exec 等）时才落盘，
   * 避免"任务从不使用工作区"却产生大量空目录；工作区路径本身仍会写入 conversations 供授权与展示使用。
   */
  private createTaskWorkspace(employeeWorkspace: string): string {
    const ts = new Date()
    const pad = (n: number) => String(n).padStart(2, '0')
    const base = `${ts.getFullYear()}${pad(ts.getMonth() + 1)}${pad(ts.getDate())}_${pad(ts.getHours())}${pad(ts.getMinutes())}${pad(ts.getSeconds())}`
    let dir = path.join(employeeWorkspace, base)
    let i = 1
    while (this.isTaskWorkspaceTaken(dir)) {
      dir = path.join(employeeWorkspace, `${base}_${i}`)
      i++
    }
    return dir
  }

  /** 任务工作区目录是否已被占用：目录已存在或已分配给某个会话（懒创建下目录可能尚未落盘，需查 DB 兜底） */
  private isTaskWorkspaceTaken(dir: string): boolean {
    if (fs.existsSync(dir)) return true
    try {
      const row = this.db.getDb().prepare('SELECT 1 FROM conversations WHERE workspace_path = ? LIMIT 1').get(dir)
      return !!row
    } catch {
      return false
    }
  }

  /** 注册员工（内置/插件）的工作区根目录：与用户员工一致置于 dataDir/employees/<8位稳定ID>（id 哈希派生，跨版本不变） */
  getRegistryWorkspaceRoot(employeeId: string): string {
    // 注册员工 id 含 ':' 等路径非法字符，用稳定哈希派生目录名（sha1 前 8 hex，与 generateShortId 同构、可复现）
    const dirName = crypto.createHash('sha1').update(employeeId).digest('hex').slice(0, 8)
    const root = path.join(PathService.getInstance().getDataDir(), 'employees', dirName)
    fs.mkdirSync(root, { recursive: true })
    return root
  }

  /** 获取对话的任务工作区目录（未分配返回空字符串） */
  getConversationWorkspacePath(conversationId: string): string {
    const row = this.db.getDb().prepare('SELECT workspace_path FROM conversations WHERE id = ?').get(conversationId) as { workspace_path?: string } | undefined
    return row?.workspace_path || ''
  }

  /** 路径是否位于数据目录 employees/ 下（任务工作区的合法边界，deleteTaskWorkspace 与 workspace_path 复用共用） */
  isWithinEmployeesRoot(p: string): boolean {
    const basePath = PathService.getInstance().getDataDir()
    const employeesRoot = path.resolve(basePath, 'employees')
    const target = path.resolve(p)
    const relative = path.relative(employeesRoot, target)
    return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative)
  }

  private syncConversationFTS(id: string, employeeId: string, title: string, summary: string, messagesJson: string): void {
    this.db.getDb().prepare('DELETE FROM conversations_fts WHERE conversation_id = ?').run(id)
    // 索引列存 jieba 分词结果（unicode61 无法切分中文），content_raw 保留原文供结果片段展示
    const rawPreview = buildConversationPreview(messagesJson)
    this.db.getDb().prepare(
      'INSERT INTO conversations_fts (title, summary, content_preview, content_raw, conversation_id, employee_id) VALUES (?, ?, ?, ?, ?, ?)'
    ).run(
      segmentConversationText(title || ''),
      segmentConversationText(summary || ''),
      segmentConversationText(rawPreview),
      rawPreview,
      id,
      employeeId
    )
  }

  updateConversation(id: string, data: { title?: string; messages_json?: string; message_count?: number; status?: string; minimal_mode?: boolean; last_message_at?: number; employee_id?: string; context_stats_json?: string; default_model_json?: string; collection_ids_json?: string }): boolean {
    const ALLOWED_CONVERSATION_COLUMNS = [
      'title', 'messages_json', 'message_count',
      'status', 'minimal_mode', 'last_message_at', 'employee_id',
      'context_stats_json', 'default_model_json', 'collection_ids_json'
    ]

    const updates: string[] = []
    const values: any[] = []

    Object.entries(data).forEach(([key, value]) => {
      if (value !== undefined && ALLOWED_CONVERSATION_COLUMNS.includes(key)) {
        if (key === 'minimal_mode') {
          updates.push(`${key} = ?`)
          values.push(value ? 1 : 0)
        } else {
          updates.push(`${key} = ?`)
          values.push(value)
        }
      }
    })

    if (updates.length === 0) return false

    updates.push('updated_at = unixepoch()')
    values.push(id)

    const result = this.db.getDb().prepare(`
      UPDATE conversations SET ${updates.join(', ')} WHERE id = ?
    `).run(...values)

    if (result.changes === 0) return false

    // 同步员工最近活跃时间：有 last_message_at 传值，或迁移了 employee_id 时更新
    if (data.last_message_at !== undefined || data.employee_id !== undefined) {
      const convRow = this.db.getDb().prepare(
        'SELECT employee_id, COALESCE(last_message_at, created_at) AS ts FROM conversations WHERE id = ?'
      ).get(id) as { employee_id: string; ts: number } | undefined
      if (convRow) {
        this.touchEmployeeLastActive(convRow.employee_id, data.last_message_at ?? convRow.ts)
      }
    }

    // FTS 同步：在 title / messages_json / employee_id 变化时执行
    // 优化：避免 SELECT * 加载完整 messages_json 大字段，只查必要的小字段
    if (data.title !== undefined || data.messages_json !== undefined || data.employee_id !== undefined) {
      const needMessagesJson = data.messages_json === undefined
      const cols = needMessagesJson
        ? 'employee_id, title, summary, messages_json'
        : 'employee_id, title, summary'
      const row = this.db.getDb().prepare(
        `SELECT ${cols} FROM conversations WHERE id = ?`
      ).get(id) as any
      if (row) {
        this.syncConversationFTS(
          id,
          row.employee_id,
          data.title !== undefined ? data.title : row.title,
          row.summary || '',
          data.messages_json !== undefined ? data.messages_json : (row.messages_json || '[]')
        )
      }
    }

    this.notifyPluginEvent('conversation:updated', { id, data })
    return true
  }

  deleteConversation(id: string): { ok: boolean; taskDir?: string; taskDirNonEmpty?: boolean } {
    // 递归收集所有子会话（含自身），用于级联删除
    const toDelete: string[] = []
    const collectChildren = (parentId: string) => {
      toDelete.push(parentId)
      const children = this.db.getDb().prepare(
        'SELECT id FROM conversations WHERE parent_conversation_id = ?'
      ).all(parentId) as { id: string }[]
      for (const child of children) {
        collectChildren(child.id)
      }
    }
    collectChildren(id)

    const conv = this.db.getDb().prepare('SELECT workspace_path FROM conversations WHERE id = ?').get(id) as { workspace_path?: string } | undefined

    // 以实际删除行数为准：传入不存在的 id 不再误报成功（避免调用方误清缓存并通知插件）
    let deletedCount = 0
    const delTx = this.db.getDb().transaction(() => {
      for (const cid of toDelete) {
        this.db.getDb().prepare('DELETE FROM conversations_fts WHERE conversation_id = ?').run(cid)
        const r = this.db.getDb().prepare('DELETE FROM conversations WHERE id = ?').run(cid)
        deletedCount += r.changes
      }
    })
    delTx()
    const ok = deletedCount > 0

    // 清理子会话运行记录并中止在途 run（懒加载避免循环依赖）
    if (ok) {
      try {
        const { default: SubAgentRuntime } = require('./agent-runtime/runtime')
        SubAgentRuntime.getInstance().clearRunsByConversations(toDelete)
      } catch { /* ignore */ }
      // 释放会话级 agent 缓存（含插件删除通道，避免缓存随会话数持续增长）
      try {
        const { default: EmployeeAgentService } = require('./employee-agent.service')
        EmployeeAgentService.getInstance().clearAgentCacheForConversations(toDelete)
      } catch { /* ignore */ }
    }

    // 任务目录处理：空目录直接删除；非空目录保留并上报，由前端决定是否删除
    // 子会话的工作区目录位于主会话目录下，删除主会话目录时会一并清理子目录
    let taskDir: string | undefined
    let taskDirNonEmpty: boolean | undefined
    if (ok && conv?.workspace_path && fs.existsSync(conv.workspace_path)) {
      try {
        const entries = fs.readdirSync(conv.workspace_path)
        if (entries.length === 0) {
          fs.rmdirSync(conv.workspace_path)
        } else {
          taskDir = conv.workspace_path
          taskDirNonEmpty = true
        }
      } catch { /* 目录清理失败不影响删除结果 */ }
    }
    return { ok, taskDir, taskDirNonEmpty }
  }

  /** 获取指定会话的所有子会话 ID（递归，含自身） */
  getChildConversationIds(conversationId: string): string[] {
    const ids: string[] = []
    const collect = (parentId: string) => {
      ids.push(parentId)
      const children = this.db.getDb().prepare(
        'SELECT id FROM conversations WHERE parent_conversation_id = ?'
      ).all(parentId) as { id: string }[]
      for (const child of children) {
        collect(child.id)
      }
    }
    collect(conversationId)
    return ids
  }

  deleteAllConversations(employeeId: string): number {
    // 查出该员工的所有顶层会话，逐个级联删除（含子会话）
    const topConvs = this.db.getDb().prepare(
      `SELECT id FROM conversations WHERE employee_id = ? AND (parent_conversation_id = '' OR parent_conversation_id IS NULL)`
    ).all(employeeId) as { id: string }[]
    let deleted = 0
    for (const c of topConvs) {
      if (this.deleteConversation(c.id).ok) deleted++
    }
    return deleted
  }

  /**
   * 删除任务工作区目录（移至回收站）。安全校验：必须位于数据目录 employees/ 下，
   * 防止 DB 被篡改后通过任意路径递归删除系统目录。
   */
  async deleteTaskWorkspace(taskDirPath: string): Promise<boolean> {
    const basePath = PathService.getInstance().getDataDir()
    const employeesRoot = path.resolve(basePath, 'employees')
    const target = path.resolve(taskDirPath)
    const relative = path.relative(employeesRoot, target)
    const isWithinEmployees = relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative)
    if (!isWithinEmployees) {
      logger.warn(`Refused to delete task workspace outside employees root: ${taskDirPath}`)
      return false
    }
    if (!fs.existsSync(target)) return true
    try {
      // moveToTrash 回退路径（rmSync）可能抛真实错误，必须 await 才能捕获到失败
      await moveToTrash(target)
      return true
    } catch (error) {
      logger.warn('Failed to remove task workspace directory', target, error)
      return false
    }
  }

  /**
   * 跨智能体检索历史对话（FTS5 优先，无结果降级 LIKE）
   * - 支持 employeeIds 过滤（为空则搜索全部员工）
   * - 索引/查询两侧统一 jieba 预分词，中文按词命中（unicode61 无法切分中文）
   * - snippet 由原始预览 content_raw 在应用层截取并高亮
   * - 排序：标题相似度优先（精确 > 开头 > 包含），其次 BM25/内容命中次数，最后时间降序
   */
  searchConversationsGlobal(params: {
    query: string
    employeeIds?: string[]
    limit?: number
  }): Array<{
    conversationId: string
    employeeId: string
    employeeName: string
    title: string
    summary: string
    previewSnippet: string
    lastMessageAt: number | null
    messageCount: number
  }> {
    const query = String(params.query || '').trim()
    if (!query) return []

    const limit = Math.min(Math.max(params.limit ?? 20, 1), 50)
    const employeeIds = params.employeeIds?.filter(Boolean) ?? []
    // 先按"全部词命中"精确检索，无结果再放宽为"任一词命中"，避免长查询直接零召回
    const ftsQueries = Array.from(new Set([
      buildConversationFtsMatch(query, 'all'),
      buildConversationFtsMatch(query, 'any'),
    ].filter((q): q is string => !!q)))
    // 去空格版本，用于标题/内容的子串匹配（用户用空格分词，不应把空格当作必须出现的字符）
    const queryNoSpace = query.replace(/\s+/g, '')
    const titleLikePattern = `%${queryNoSpace.replace(/[%_]/g, (m) => '\\' + m)}%`

    // 标题相似度评分 SQL 片段（精确匹配 > 标题以查询开头 > 标题包含查询）
    const titleScoreExpr = `CASE
      WHEN c.title = ? THEN 100000
      WHEN c.title LIKE ? ESCAPE '\\' THEN 50000
      WHEN c.title LIKE ? ESCAPE '\\' THEN 20000
      ELSE 0
    END`
    // 标题匹配参数顺序：精确匹配 queryNoSpace / 开头匹配 queryNoSpace% / 包含匹配 %queryNoSpace%
    const titleStartPattern = `${queryNoSpace.replace(/[%_]/g, (m) => '\\' + m)}%`

    // Phase 1: FTS5 匹配（索引侧 jieba 预分词 + 查询侧同分词器，AND 优先 / OR 兜底，
    // BM25 让命中词更多的对话排前面，再叠加标题命中加成）
    let results: any[] = []
    for (const ftsQuery of ftsQueries) {
      if (results.length > 0) break
      const employeePlaceholders = employeeIds.length > 0
        ? `AND c.employee_id IN (${employeeIds.map(() => '?').join(',')})`
        : ''
      const employeeParams = employeeIds

      // FTS 异常（语法/表损坏）时降级 Phase 2 的 LIKE 检索，不让搜索整体失败
      try {
        results = this.db.getDb().prepare(`
        SELECT
          c.id, c.employee_id, e.name as employee_name,
          c.title, c.summary, c.last_message_at, c.message_count,
          COALESCE(f.content_raw, '') as preview_raw,
          ${titleScoreExpr} as title_score
        FROM conversations_fts f
        JOIN conversations c ON c.id = f.conversation_id
        JOIN employees e ON e.id = c.employee_id
        WHERE conversations_fts MATCH ?
          AND c.status = 'active'
          AND (c.parent_conversation_id = '' OR c.parent_conversation_id IS NULL)
          AND c.employee_id NOT LIKE 'inline:%'
          ${employeePlaceholders}
        ORDER BY title_score DESC, f.rank ASC
        LIMIT ?
      `).all(queryNoSpace, titleStartPattern, titleLikePattern, ftsQuery, ...employeeParams, limit) as any[]
      } catch (err: any) {
        logger.warn('FTS5 搜索失败，降级 LIKE 检索:', err?.message || err)
      }
    }

    // Phase 2: FTS 无结果降级 LIKE（按 jieba 词粒度 AND，覆盖词典未收录的子串）
    // 叠加标题分 + content_raw 中查询出现次数，实现内容相似度排序
    if (results.length === 0) {
      const likeTokens = buildConversationLikeTerms(query)
      if (likeTokens.length > 0) {
        const tokenCond = `(c.title LIKE ? ESCAPE '\\' OR COALESCE(c.summary, '') LIKE ? ESCAPE '\\' OR EXISTS (SELECT 1 FROM conversations_fts f WHERE f.conversation_id = c.id AND f.content_raw LIKE ? ESCAPE '\\'))`
        const andClause = likeTokens.map(() => tokenCond).join(' AND ')
        const tokenParams = likeTokens.flatMap((t) => {
          const p = `%${t.replace(/[%_]/g, (m) => '\\' + m)}%`
          return [p, p, p]
        })

        const employeePlaceholders = employeeIds.length > 0
          ? `AND c.employee_id IN (${employeeIds.map(() => '?').join(',')})`
          : ''
        const employeeParams = employeeIds

        // content_raw 中 queryNoSpace 出现次数（LENGTH 差值法）
        const contentHitsExpr = `COALESCE((
          SELECT (LENGTH(f.content_raw) - LENGTH(REPLACE(LOWER(f.content_raw), LOWER(?), ''))) / MAX(LENGTH(?), 1)
          FROM conversations_fts f WHERE f.conversation_id = c.id
        ), 0)`

        results = this.db.getDb().prepare(`
          SELECT
            c.id, c.employee_id, e.name as employee_name,
            c.title, c.summary, c.last_message_at, c.message_count,
            COALESCE((SELECT f.content_raw FROM conversations_fts f WHERE f.conversation_id = c.id), '') as preview_raw,
            ${titleScoreExpr} as title_score,
            ${contentHitsExpr} as content_hits
          FROM conversations c
          JOIN employees e ON e.id = c.employee_id
          WHERE c.status = 'active'
            AND (c.parent_conversation_id = '' OR c.parent_conversation_id IS NULL)
            AND c.employee_id NOT LIKE 'inline:%'
            ${employeePlaceholders}
            AND (${andClause})
          ORDER BY title_score DESC, content_hits DESC, COALESCE(c.last_message_at, c.created_at) DESC
          LIMIT ?
        `).all(
          queryNoSpace, titleStartPattern, titleLikePattern,
          queryNoSpace, queryNoSpace,
          ...employeeParams, ...tokenParams, limit,
        ) as any[]
      }
    }

    return results.map((r) => ({
      conversationId: r.id,
      employeeId: r.employee_id,
      employeeName: r.employee_name || '',
      title: r.title || '',
      summary: r.summary || '',
      previewSnippet: buildConversationSnippet(r.preview_raw || '', query) || r.summary || '',
      lastMessageAt: r.last_message_at,
      messageCount: r.message_count || 0,
    }))
  }
}

export default WorkspaceManagerService
