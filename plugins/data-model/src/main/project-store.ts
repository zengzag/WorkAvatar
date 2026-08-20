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
        updated_at INTEGER NOT NULL
      )
    `)
    this.migrateChatsSchema()
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
          updated_at INTEGER NOT NULL
        );
        INSERT INTO dm_chats_new (conversation_id, employee_id, title, updated_at)
          SELECT conversation_id, employee_id, title, updated_at FROM dm_chats;
        DROP TABLE dm_chats;
        ALTER TABLE dm_chats_new RENAME TO dm_chats;
      `)
    })()
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

  createBlank(name?: string): DataModel {
    const model = createDataModel({ name: name || '未命名数据模型' })
    this.save(model)
    return model
  }

  // ====== 数据模型对话记录 ======

  saveChat(chat: ChatRecord): void {
    this.requireDb().prepare(
      'INSERT INTO dm_chats (conversation_id, employee_id, title, updated_at) VALUES (?, NULL, ?, ?) ' +
      'ON CONFLICT(conversation_id) DO UPDATE SET title = excluded.title, updated_at = excluded.updated_at'
    ).run(chat.conversationId, chat.title, Date.now())
  }

  listChats(): ChatRecord[] {
    const rows = this.requireDb().prepare('SELECT conversation_id, title, updated_at FROM dm_chats ORDER BY updated_at DESC').all() as any[]
    return rows.map((r) => ({
      conversationId: r.conversation_id,
      title: r.title,
      updatedAt: r.updated_at
    }))
  }

  deleteChat(conversationId: string): void {
    this.requireDb().prepare('DELETE FROM dm_chats WHERE conversation_id = ?').run(conversationId)
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
