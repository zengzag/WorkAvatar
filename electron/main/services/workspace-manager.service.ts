import fs from 'fs'
import path from 'path'
import { BrowserWindow } from 'electron'
import type { Employee, Conversation } from '../../shared/types'
import DatabaseService from './database.service'
import PathService from './path.service'
import { generateId, generateShortId, extractMessagePreview, moveToTrash } from './common-utils'
import { createLogger } from './logger'
import { IPC_CHANNELS } from '../../shared/ipc-channels'

const logger = createLogger('WorkspaceManager')

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
      INSERT INTO employees (id, workspace_path, name, description, rules, profile_json, avatar_type, arch_version, total_tasks, total_approvals, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, 'default', 1, 0, 0, ?, ?)
    `).run(employeeId, workspacePath, name, description, rules, profileJson, now, now)

    this.broadcastEmployeeChanged()

    this.notifyPluginEvent('employee:created', { id: employeeId, name })
    return this.getEmployee(employeeId)!
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
  }): Employee | null {
    const employee = this.getEmployee(id)
    if (!employee) return null

    const updates: string[] = []
    const values: any[] = []

    const ALLOWED_COLUMNS = [
      'name', 'description', 'rules', 'profile_json',
      'default_skill_id',
      'memory_enabled', 'workspace_path', 'avatar_type'
    ]

    Object.entries(data).forEach(([key, value]) => {
      if (value !== undefined && ALLOWED_COLUMNS.includes(key)) {
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
        // 安全校验：workspace_path 必须位于数据目录的 employees/ 子目录下，
        // 防止 DB 被篡改后通过 workspace_path 递归删除任意系统目录
        const basePath = PathService.getInstance().getDataDir()
        const employeesRoot = path.resolve(basePath, 'employees')
        const workspaceRoot = path.resolve(employee.workspace_path)
        const relative = path.relative(employeesRoot, workspaceRoot)
        const isWithinEmployees = relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))
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

  getConversationList(employeeId?: string): Conversation[] {
    if (employeeId) {
      return this.db.getDb().prepare(
        `SELECT id, employee_id, skill_id, title, message_count, minimal_mode, status, workspace_path, parent_conversation_id, created_at, updated_at, last_message_at, context_stats_json, default_model_json
         FROM conversations
         WHERE employee_id = ? AND (parent_conversation_id = '' OR parent_conversation_id IS NULL)
         ORDER BY COALESCE(last_message_at, created_at) DESC`
      ).all(employeeId) as Conversation[]
    }
    return this.db.getDb().prepare(
      `SELECT id, employee_id, skill_id, title, message_count, minimal_mode, status, workspace_path, parent_conversation_id, created_at, updated_at, last_message_at, context_stats_json, default_model_json
       FROM conversations
       WHERE parent_conversation_id = '' OR parent_conversation_id IS NULL
       ORDER BY COALESCE(last_message_at, created_at) DESC`
    ).all() as Conversation[]
  }

  /** 获取所有对话（跨员工），附带员工名称，仅返回有消息的顶层对话，支持分页 */
  getAllConversationsWithEmployee(params?: { limit?: number; offset?: number; employee_ids?: string[] }): Array<Conversation & { employee_name: string }> {
    let sql = `SELECT c.id, c.employee_id, c.skill_id, c.title, c.message_count, c.minimal_mode, c.status, c.workspace_path, c.parent_conversation_id, c.created_at, c.updated_at, c.last_message_at, c.context_stats_json, c.default_model_json,
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
    return this.db.getDb().prepare(sql).all(...values) as Array<Conversation & { employee_name: string }>
  }

  getConversation(id: string): Conversation | null {
    return this.db.getDb().prepare('SELECT * FROM conversations WHERE id = ?').get(id) as Conversation || null
  }

  createConversation(employeeId: string, skillId?: string, title: string = '', minimalMode?: boolean, parentConversationId?: string, reuseWorkspacePath?: string): Conversation {
    const employee = this.db.getDb().prepare('SELECT id, workspace_path FROM employees WHERE id = ?').get(employeeId) as { id: string; workspace_path: string | null } | undefined
    if (!employee) {
      throw new Error(`Employee not found: ${employeeId}`)
    }

    const conversationId = generateId()
    const now = Math.floor(Date.now() / 1000)

    // 任务工作区目录策略：
    // - 有 parentConversationId（委托子会话）：在主管会话的工作区目录下创建子目录
    // - 无 parentConversationId（顶层会话）：在员工工作区下创建独立目录
    let workspacePath = ''
    if (reuseWorkspacePath) {
      // 分支任务：直接复用原任务工作区路径，不新建目录（保证 KV cache 前缀一致）
      workspacePath = reuseWorkspacePath
    } else if (parentConversationId) {
      const parent = this.db.getDb().prepare('SELECT workspace_path FROM conversations WHERE id = ?').get(parentConversationId) as { workspace_path?: string } | undefined
      const parentWs = parent?.workspace_path || ''
      workspacePath = parentWs ? this.createTaskWorkspace(parentWs) : ''
    } else {
      workspacePath = employee.workspace_path ? this.createTaskWorkspace(employee.workspace_path) : ''
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

  /** 在员工工作区下创建任务独立目录（YYYYMMDD_HHmmss，碰撞时追加序号） */
  private createTaskWorkspace(employeeWorkspace: string): string {
    const ts = new Date()
    const pad = (n: number) => String(n).padStart(2, '0')
    const base = `${ts.getFullYear()}${pad(ts.getMonth() + 1)}${pad(ts.getDate())}_${pad(ts.getHours())}${pad(ts.getMinutes())}${pad(ts.getSeconds())}`
    let dir = path.join(employeeWorkspace, base)
    let i = 1
    while (fs.existsSync(dir)) {
      dir = path.join(employeeWorkspace, `${base}_${i}`)
      i++
    }
    fs.mkdirSync(dir, { recursive: true })
    return dir
  }

  /** 获取对话的任务工作区目录（未分配返回空字符串） */
  getConversationWorkspacePath(conversationId: string): string {
    const row = this.db.getDb().prepare('SELECT workspace_path FROM conversations WHERE id = ?').get(conversationId) as { workspace_path?: string } | undefined
    return row?.workspace_path || ''
  }

  private syncConversationFTS(id: string, employeeId: string, title: string, summary: string, messagesJson: string): void {
    this.db.getDb().prepare('DELETE FROM conversations_fts WHERE conversation_id = ?').run(id)
    const preview = extractMessagePreview(messagesJson)
    this.db.getDb().prepare(
      'INSERT INTO conversations_fts (title, summary, content_preview, conversation_id, employee_id) VALUES (?, ?, ?, ?, ?)'
    ).run(title || '', summary || '', preview, id, employeeId)
  }

  updateConversation(id: string, data: { title?: string; messages_json?: string; message_count?: number; status?: string; minimal_mode?: boolean; last_message_at?: number; employee_id?: string; context_stats_json?: string; default_model_json?: string }): boolean {
    const ALLOWED_CONVERSATION_COLUMNS = [
      'title', 'messages_json', 'message_count',
      'status', 'minimal_mode', 'last_message_at', 'employee_id',
      'context_stats_json', 'default_model_json'
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

    const delTx = this.db.getDb().transaction(() => {
      for (const cid of toDelete) {
        this.db.getDb().prepare('DELETE FROM conversations_fts WHERE conversation_id = ?').run(cid)
        this.db.getDb().prepare('DELETE FROM conversations WHERE id = ?').run(cid)
      }
    })
    delTx()
    const ok = toDelete.length > 0

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
  deleteTaskWorkspace(taskDirPath: string): boolean {
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
      moveToTrash(target)
      return true
    } catch (error) {
      logger.warn('Failed to remove task workspace directory', target, error)
      return false
    }
  }

  /**
   * 跨智能体检索历史对话（FTS5 优先，无结果降级 LIKE）
   * - 支持 employeeIds 过滤（为空则搜索全部员工）
   * - snippet 来自 conversations_fts 的 content_preview 列，高亮匹配片段
   * - 排序：标题相似度优先（精确 > 开头 > 包含），其次内容命中次数，最后时间降序
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
    const ftsQuery = buildFtsQuery(query)
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

    // Phase 1: FTS5 隐式 AND 匹配（rank 已包含内容相关度，叠加标题命中加成）
    let results: any[] = []
    if (ftsQuery) {
      const employeePlaceholders = employeeIds.length > 0
        ? `AND c.employee_id IN (${employeeIds.map(() => '?').join(',')})`
        : ''
      const employeeParams = employeeIds

      results = this.db.getDb().prepare(`
        SELECT
          c.id, c.employee_id, e.name as employee_name,
          c.title, c.summary, c.last_message_at, c.message_count,
          snippet(conversations_fts, 2, '<highlight>', '</highlight>', '...', 30) as preview_snippet,
          ${titleScoreExpr} as title_score
        FROM conversations_fts f
        JOIN conversations c ON c.id = f.conversation_id
        JOIN employees e ON e.id = c.employee_id
        WHERE conversations_fts MATCH ?
          AND c.status = 'active'
          AND (c.parent_conversation_id = '' OR c.parent_conversation_id IS NULL)
          ${employeePlaceholders}
        ORDER BY title_score DESC, f.rank ASC
        LIMIT ?
      `).all(queryNoSpace, titleStartPattern, titleLikePattern, ftsQuery, ...employeeParams, limit) as any[]
    }

    // Phase 2: FTS 无结果降级 LIKE（逐 token AND）
    // 叠加标题分 + content_preview 中查询出现次数，实现内容相似度排序
    if (results.length === 0) {
      const likeTokens = query.split(/\s+/).filter((t) => t.length > 0)
      if (likeTokens.length > 0) {
        const tokenCond = `(c.title LIKE ? ESCAPE '\\' OR COALESCE(c.summary, '') LIKE ? ESCAPE '\\' OR EXISTS (SELECT 1 FROM conversations_fts f WHERE f.conversation_id = c.id AND f.content_preview LIKE ? ESCAPE '\\'))`
        const andClause = likeTokens.map(() => tokenCond).join(' AND ')
        const tokenParams = likeTokens.flatMap((t) => {
          const p = `%${t.replace(/[%_]/g, (m) => '\\' + m)}%`
          return [p, p, p]
        })

        const employeePlaceholders = employeeIds.length > 0
          ? `AND c.employee_id IN (${employeeIds.map(() => '?').join(',')})`
          : ''
        const employeeParams = employeeIds

        // content_preview 中 queryNoSpace 出现次数（LENGTH 差值法）
        const contentHitsExpr = `COALESCE((
          SELECT (LENGTH(f.content_preview) - LENGTH(REPLACE(LOWER(f.content_preview), LOWER(?), ''))) / MAX(LENGTH(?), 1)
          FROM conversations_fts f WHERE f.conversation_id = c.id
        ), 0)`

        results = this.db.getDb().prepare(`
          SELECT
            c.id, c.employee_id, e.name as employee_name,
            c.title, c.summary, c.last_message_at, c.message_count,
            '' as preview_snippet,
            ${titleScoreExpr} as title_score,
            ${contentHitsExpr} as content_hits
          FROM conversations c
          JOIN employees e ON e.id = c.employee_id
          WHERE c.status = 'active'
            AND (c.parent_conversation_id = '' OR c.parent_conversation_id IS NULL)
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
      previewSnippet: r.preview_snippet || r.summary || '',
      lastMessageAt: r.last_message_at,
      messageCount: r.message_count || 0,
    }))
  }
}

/**
 * 构建 FTS5 MATCH 表达式：
 * - 英文 token 追加 * 实现前缀匹配
 * - 中文 token 逐字拆分后用空格连接（FTS5 隐式 AND，要求所有字出现但不要求连续）
 *   避免 FTS5 将整个中文串当作 phrase（要求连续）导致短查询结果反常偏少
 */
function buildFtsQuery(query: string): string {
  const cleaned = query.replace(/["*()^+\-]/g, '').trim()
  if (!cleaned) return ''
  const tokens = cleaned.split(/\s+/).filter((t) => t.length > 0)
  return tokens
    .map((tok) => {
      if (/^[a-zA-Z0-9]+$/.test(tok) && tok.length >= 2) {
        return `${tok}*`
      }
      // 中文逐字拆分，用空格连接 → FTS5 隐式 AND（所有字都出现即可，不要求连续）
      return tok.split('').join(' ')
    })
    .join(' ')
}

export default WorkspaceManagerService
