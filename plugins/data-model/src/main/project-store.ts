// 数据模型项目存储（插件分库 sqlite）

import type { PluginContext, PluginDatabase } from '../../../plugin-sdk/src'
import type { DataModel } from '../shared/domain'
import { createDataModel } from '../shared/domain'

export interface ProjectRecord {
  id: string
  name: string
  model: DataModel
  updatedAt: number
}

export interface ChatRecord {
  conversationId: string
  title: string
  updatedAt: number
  /** 任务工作区目录（新对话创建，可读写文件） */
  workspacePath?: string | null
}

export interface DataModelSettings {
  defaultProviderId?: string
  defaultModelId?: string
}

const SETTINGS_KEY = 'data-model-settings'

class ProjectStore {
  private db: PluginDatabase | null = null

  init(ctx: PluginContext): void {
    this.db = ctx.storage.openSqlite('index')
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS dm_projects (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        model TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      )
    `)
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS dm_chats (
        conversation_id TEXT PRIMARY KEY,
        employee_id TEXT,
        title TEXT NOT NULL,
        updated_at INTEGER NOT NULL,
        workspace_path TEXT
      )
    `)
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS dm_messages (
        conversation_id TEXT PRIMARY KEY,
        messages_json TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      )
    `)
    this.migrateChatsSchema()
    this.migrateChatsWorkspacePath()
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS plugin_kv (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      )
    `)
  }

  /**
   * 兼容旧库迁移：旧版 dm_chats.employee_id 为 NOT NULL，但通用对话不再绑定员工
   * （saveChat 写入 NULL）。CREATE TABLE IF NOT EXISTS 不迁移已有表，需重建去约束。
   */
  private migrateChatsSchema(): void {
    const db = this.requireDb()
    const cols = db.prepare('PRAGMA table_info(dm_chats)').all() as Array<{ name: string; notnull: number }>
    const employeeId = cols.find((c) => c.name === 'employee_id')
    if (!employeeId || employeeId.notnull === 0) return
    db.transaction(() => {
      db.exec(`
        CREATE TABLE dm_chats_new (
          conversation_id TEXT PRIMARY KEY,
          employee_id TEXT,
          title TEXT NOT NULL,
          updated_at INTEGER NOT NULL,
          workspace_path TEXT
        );
        INSERT INTO dm_chats_new (conversation_id, employee_id, title, updated_at)
          SELECT conversation_id, employee_id, title, updated_at FROM dm_chats;
        DROP TABLE dm_chats;
        ALTER TABLE dm_chats_new RENAME TO dm_chats;
      `)
    })()
  }

  /** 兼容旧库迁移：为 dm_chats 补充 task 工作区目录列 */
  private migrateChatsWorkspacePath(): void {
    const db = this.requireDb()
    const cols = db.prepare('PRAGMA table_info(dm_chats)').all() as Array<{ name: string }>
    if (cols.some((c) => c.name === 'workspace_path')) return
    db.exec('ALTER TABLE dm_chats ADD COLUMN workspace_path TEXT')
  }

  private requireDb(): PluginDatabase {
    if (!this.db) throw new Error('ProjectStore 未初始化')
    return this.db
  }

  list(): ProjectRecord[] {
    const rows = this.requireDb().prepare('SELECT id, name, model, updated_at FROM dm_projects ORDER BY updated_at DESC').all() as any[]
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      model: JSON.parse(r.model) as DataModel,
      updatedAt: r.updated_at
    }))
  }

  get(id: string): ProjectRecord | null {
    const row = this.requireDb().prepare('SELECT id, name, model, updated_at FROM dm_projects WHERE id = ?').get(id) as any
    if (!row) return null
    return { id: row.id, name: row.name, model: JSON.parse(row.model) as DataModel, updatedAt: row.updated_at }
  }

  save(model: DataModel): void {
    this.requireDb().prepare(
      'INSERT INTO dm_projects (id, name, model, updated_at) VALUES (?, ?, ?, ?) ' +
      'ON CONFLICT(id) DO UPDATE SET name = excluded.name, model = excluded.model, updated_at = excluded.updated_at'
    ).run(model.id, model.name, JSON.stringify(model), Date.now())
  }

  delete(id: string): void {
    this.requireDb().prepare('DELETE FROM dm_projects WHERE id = ?').run(id)
  }

  rename(id: string, name: string): void {
    this.requireDb().prepare('UPDATE dm_projects SET name = ?, updated_at = ? WHERE id = ?').run(name, Date.now(), id)
  }

  createBlank(name?: string): DataModel {
    const model = createDataModel({ name: name || '未命名数据模型' })
    this.save(model)
    return model
  }

  // ====== 数据模型对话记录 ======

  saveChat(chat: ChatRecord): void {
    this.requireDb().prepare(
      'INSERT INTO dm_chats (conversation_id, employee_id, title, updated_at, workspace_path) VALUES (?, NULL, ?, ?, ?) ' +
      'ON CONFLICT(conversation_id) DO UPDATE SET title = excluded.title, updated_at = excluded.updated_at, workspace_path = COALESCE(excluded.workspace_path, workspace_path)'
    ).run(chat.conversationId, chat.title, Date.now(), chat.workspacePath ?? null)
  }

  listChats(): ChatRecord[] {
    const rows = this.requireDb().prepare('SELECT conversation_id, title, updated_at, workspace_path FROM dm_chats ORDER BY updated_at DESC').all() as any[]
    return rows.map((r) => ({
      conversationId: r.conversation_id,
      title: r.title,
      updatedAt: r.updated_at,
      workspacePath: r.workspace_path ?? null
    }))
  }

  getChatWorkspacePath(conversationId: string): string | null {
    const row = this.requireDb().prepare('SELECT workspace_path FROM dm_chats WHERE conversation_id = ?').get(conversationId) as { workspace_path: string | null } | undefined
    return row?.workspace_path ?? null
  }

  deleteChat(conversationId: string): void {
    this.requireDb().prepare('DELETE FROM dm_chats WHERE conversation_id = ?').run(conversationId)
    this.requireDb().prepare('DELETE FROM dm_messages WHERE conversation_id = ?').run(conversationId)
  }

  // ====== 数据模型对话消息（插件分库持久化，独立于宿主 conversations 表） ======

  saveMessages(conversationId: string, msgs: unknown[]): void {
    this.requireDb().prepare(
      'INSERT INTO dm_messages (conversation_id, messages_json, updated_at) VALUES (?, ?, ?) ' +
      'ON CONFLICT(conversation_id) DO UPDATE SET messages_json = excluded.messages_json, updated_at = excluded.updated_at'
    ).run(conversationId, JSON.stringify(msgs), Date.now())
  }

  getMessages(conversationId: string): unknown[] {
    const row = this.requireDb().prepare('SELECT messages_json FROM dm_messages WHERE conversation_id = ?').get(conversationId) as { messages_json: string } | undefined
    if (!row) return []
    try {
      const arr = JSON.parse(row.messages_json)
      return Array.isArray(arr) ? arr : []
    } catch {
      return []
    }
  }

  // ====== 插件设置 ======

  getSettings(): DataModelSettings {
    const row = this.requireDb().prepare('SELECT value FROM plugin_kv WHERE key = ?').get(SETTINGS_KEY) as { value: string } | undefined
    if (!row) return {}
    try {
      return JSON.parse(row.value) as DataModelSettings
    } catch {
      return {}
    }
  }

  setSettings(settings: DataModelSettings): void {
    this.requireDb().prepare(
      'INSERT INTO plugin_kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
    ).run(SETTINGS_KEY, JSON.stringify(settings))
  }
}

export const projectStore = new ProjectStore()
