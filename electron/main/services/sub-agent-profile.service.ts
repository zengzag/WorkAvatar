import type { SubAgentProfile, EphemeralSubAgentSpec } from '../../shared/types'
import DatabaseService from './database.service'
import { generateId } from './common-utils'
import { createLogger } from './logger'

const logger = createLogger('SubAgentProfile')

/** 名称长度上限 */
const MAX_NAME_CHARS = 50
/** 描述长度上限 */
const MAX_DESC_CHARS = 200

function now(): number {
  return Math.floor(Date.now() / 1000)
}

function rowToProfile(r: any): SubAgentProfile {
  return {
    id: r.id,
    name: r.name,
    description: r.description || '',
    system_prompt: r.system_prompt || '',
    tools_json: r.tools_json || '[]',
    skills_json: r.skills_json || '[]',
    provider_id: r.provider_id || null,
    model_id: r.model_id || null,
    source: r.source === 'builtin' ? 'builtin' : 'user',
    created_at: r.created_at,
    updated_at: r.updated_at,
  }
}

/** 可复用子智能体模板 CRUD（sub_agent_profiles 表，主库）。
 * 主管可按 profile 委托（等价于一份预置的 ephemeral_role 规格）。 */
class SubAgentProfileService {
  private static instance: SubAgentProfileService

  private constructor() {}

  static getInstance(): SubAgentProfileService {
    if (!SubAgentProfileService.instance) {
      SubAgentProfileService.instance = new SubAgentProfileService()
    }
    return SubAgentProfileService.instance
  }

  list(): SubAgentProfile[] {
    try {
      const rows = DatabaseService.getInstance().getDb()
        .prepare('SELECT * FROM sub_agent_profiles ORDER BY updated_at DESC').all() as any[]
      return rows.map(rowToProfile)
    } catch {
      return []
    }
  }

  get(id: string): SubAgentProfile | null {
    try {
      const row = DatabaseService.getInstance().getDb()
        .prepare('SELECT * FROM sub_agent_profiles WHERE id = ?').get(id) as any
      return row ? rowToProfile(row) : null
    } catch {
      return null
    }
  }

  /** 创建模板；返回 created 或 { error } */
  create(input: {
    name?: unknown
    description?: unknown
    system_prompt?: unknown
    tools?: unknown
    skills?: unknown
    provider_id?: unknown
    model_id?: unknown
  }): { profile?: SubAgentProfile; error?: string } {
    const name = typeof input.name === 'string' ? input.name.trim() : ''
    const systemPrompt = typeof input.system_prompt === 'string' ? input.system_prompt.trim() : ''
    if (!name) return { error: 'name 不能为空' }
    if (name.length > MAX_NAME_CHARS) return { error: `name 超长（最多 ${MAX_NAME_CHARS} 字）` }
    if (!systemPrompt) return { error: 'system_prompt 不能为空' }
    const description = typeof input.description === 'string' ? input.description.slice(0, MAX_DESC_CHARS) : ''
    const profile: SubAgentProfile = {
      id: `sap-${generateId()}`,
      name,
      description,
      system_prompt: systemPrompt,
      tools_json: JSON.stringify(this.parseStringArray(input.tools)),
      skills_json: JSON.stringify(this.parseStringArray(input.skills)),
      provider_id: typeof input.provider_id === 'string' && input.provider_id ? input.provider_id : null,
      model_id: typeof input.model_id === 'string' && input.model_id ? input.model_id : null,
      source: 'user',
      created_at: now(),
      updated_at: now(),
    }
    try {
      DatabaseService.getInstance().getDb().prepare(
        `INSERT INTO sub_agent_profiles (id, name, description, system_prompt, tools_json, skills_json, provider_id, model_id, source, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(profile.id, profile.name, profile.description, profile.system_prompt, profile.tools_json, profile.skills_json, profile.provider_id, profile.model_id, profile.source, profile.created_at, profile.updated_at)
      return { profile }
    } catch (err: any) {
      logger.warn('创建子智能体模板失败:', err?.message || err)
      return { error: '创建失败（数据库异常）' }
    }
  }

  update(id: string, input: Record<string, unknown>): { profile?: SubAgentProfile; error?: string } {
    const existing = this.get(id)
    if (!existing) return { error: `模板不存在: ${id}` }
    const merged = {
      name: typeof input.name === 'string' && input.name.trim() ? input.name.trim() : existing.name,
      description: typeof input.description === 'string' ? input.description.slice(0, MAX_DESC_CHARS) : existing.description,
      system_prompt: typeof input.system_prompt === 'string' && input.system_prompt.trim() ? input.system_prompt.trim() : existing.system_prompt,
      tools: input.tools !== undefined ? this.parseStringArray(input.tools) : JSON.parse(existing.tools_json),
      skills: input.skills !== undefined ? this.parseStringArray(input.skills) : JSON.parse(existing.skills_json),
      provider_id: input.provider_id === undefined ? existing.provider_id : (typeof input.provider_id === 'string' && input.provider_id ? input.provider_id : null),
      model_id: input.model_id === undefined ? existing.model_id : (typeof input.model_id === 'string' && input.model_id ? input.model_id : null),
    }
    if (merged.name.length > MAX_NAME_CHARS) return { error: `name 超长（最多 ${MAX_NAME_CHARS} 字）` }
    try {
      DatabaseService.getInstance().getDb().prepare(
        `UPDATE sub_agent_profiles SET name = ?, description = ?, system_prompt = ?, tools_json = ?, skills_json = ?, provider_id = ?, model_id = ?, updated_at = ? WHERE id = ?`
      ).run(merged.name, merged.description, merged.system_prompt, JSON.stringify(merged.tools), JSON.stringify(merged.skills), merged.provider_id, merged.model_id, now(), id)
      return { profile: this.get(id)! }
    } catch (err: any) {
      logger.warn('更新子智能体模板失败:', err?.message || err)
      return { error: '更新失败（数据库异常）' }
    }
  }

  /** 删除模板（仅 user 来源；builtin 拒绝） */
  remove(id: string): { ok: boolean; error?: string } {
    const existing = this.get(id)
    if (!existing) return { ok: false, error: `模板不存在: ${id}` }
    if (existing.source === 'builtin') return { ok: false, error: '内置模板不可删除' }
    try {
      DatabaseService.getInstance().getDb().prepare('DELETE FROM sub_agent_profiles WHERE id = ?').run(id)
      return { ok: true }
    } catch (err: any) {
      return { ok: false, error: err?.message || String(err) }
    }
  }

  /** 模板 → 临时子智能体规格（主管委托时的即时转换；无模型覆盖时继承主管） */
  toEphemeralSpec(profile: SubAgentProfile): EphemeralSubAgentSpec {
    return {
      key: profile.id,
      name: profile.name,
      description: profile.description,
      systemPrompt: profile.system_prompt,
      tools: this.parseStringArray(profile.tools_json),
      skills: this.parseStringArray(profile.skills_json),
      providerId: profile.provider_id || undefined,
      modelId: profile.model_id || undefined,
    }
  }

  private parseStringArray(raw: unknown): string[] {
    if (Array.isArray(raw)) return raw.filter((x): x is string => typeof x === 'string')
    if (typeof raw === 'string') {
      try {
        const parsed = JSON.parse(raw)
        return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string') : []
      } catch {
        return []
      }
    }
    return []
  }
}

export default SubAgentProfileService
