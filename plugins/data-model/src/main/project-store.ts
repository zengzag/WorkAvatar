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
  employeeId: string
  title: string
  updatedAt: number
}

export interface DataModelSettings {
  defaultEmployeeId?: string
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
        employee_id TEXT NOT NULL,
        title TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      )
    `)
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS plugin_kv (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      )
    `)
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
      'INSERT INTO dm_chats (conversation_id, employee_id, title, updated_at) VALUES (?, ?, ?, ?) ' +
      'ON CONFLICT(conversation_id) DO UPDATE SET employee_id = excluded.employee_id, title = excluded.title, updated_at = excluded.updated_at'
    ).run(chat.conversationId, chat.employeeId, chat.title, Date.now())
  }

  listChats(employeeId?: string): ChatRecord[] {
    const rows = (employeeId
      ? this.requireDb().prepare('SELECT conversation_id, employee_id, title, updated_at FROM dm_chats WHERE employee_id = ? ORDER BY updated_at DESC').all(employeeId)
      : this.requireDb().prepare('SELECT conversation_id, employee_id, title, updated_at FROM dm_chats ORDER BY updated_at DESC').all()) as any[]
    return rows.map((r) => ({
      conversationId: r.conversation_id,
      employeeId: r.employee_id,
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
