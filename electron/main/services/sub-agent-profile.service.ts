import type { SubAgentProfile, EphemeralSubAgentSpec } from '../../shared/types'
import DatabaseService from './database.service'
import { createLogger } from './logger'

const logger = createLogger('SubAgentProfile')

/** 内置子智能体模板工具白名单：只读检索类（不写入、不删除、不执行命令） */
const EXPLORE_TOOL_ALLOWLIST = [
  'file_read', 'read_image', 'ocr_image', 'report_generated_files',
  'web_search', 'web_fetch', 'date_time',
  'kms_search', 'kms_get_content', 'kms_list_collections',
  'list_employees', 'list_providers',
]

/**
 * 内置子智能体模板（随应用发布，source='builtin'，UI 只读、不可删除/修改）。
 * 作为「开箱即用的预置执行者」，降低主管委托时现场手写 ephemeral_role 的门槛：
 * - explore：只读检索与归纳，适合跨多来源收集信息并给出结论；
 * - general：全能力通用执行者，适合独立的实现/生成/评审子任务。
 * 工具白名单留空表示不限制，继承子会话完整默认工具集。
 */
const BUILTIN_PROFILES: Array<Pick<SubAgentProfile, 'id' | 'name' | 'description' | 'system_prompt' | 'tools_json' | 'skills_json' | 'provider_id' | 'model_id' | 'source'>> = [
  {
    id: 'sap-builtin-explore',
    name: '检索专家',
    description: '只读检索与归纳：跨文件、图片、知识库、网页收集信息并给出结论，不修改任何文件',
    system_prompt: [
      'You are a read-only research specialist. Locate, read, and synthesize information from files, images, the knowledge base, and the web, then return a concise, well-structured answer to the delegating agent.',
      'Rules:',
      '- Never create, modify, or delete files, and never run commands that write to disk; no write tools are available.',
      '- Read only the excerpts needed for the conclusion; do not dump raw content.',
      '- State what you searched and what you could not verify.',
      '- End with the required Delegation Receipt.',
    ].join('\n'),
    tools_json: JSON.stringify(EXPLORE_TOOL_ALLOWLIST),
    skills_json: '[]',
    provider_id: null,
    model_id: null,
    source: 'builtin',
  },
  {
    id: 'sap-builtin-general',
    name: '通用执行者',
    description: '全能力通用执行者：可读写文件、执行命令并产出交付物，适合独立的实现/生成类子任务',
    system_prompt: [
      'You are a general-purpose worker agent. Complete the delegated task end to end with the tools available and deliver concrete results.',
      'Rules:',
      '- The instruction is your only briefing; the delegating agent cannot see your intermediate steps.',
      '- Create user-facing deliverables as real files and declare them via report_generated_files.',
      '- Finish with a self-contained report and the required Delegation Receipt.',
    ].join('\n'),
    tools_json: '[]',
    skills_json: '[]',
    provider_id: null,
    model_id: null,
    source: 'builtin',
  },
]

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

/** 子智能体模板（sub_agent_profiles 表，主库）。
 * 主管可按 profile 委托（等价于一份预置的 ephemeral_role 规格）。
 * 模板由应用内置提供；保留 remove 以便清理历史版本中用户自建的模板行。 */
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

  /**
   * 播种/刷新内置子智能体模板（幂等，启动时调用一次）。
   * 用 UPSERT 覆盖内容：内置模板只读，随应用升级同步最新提示词与工具白名单。
   */
  seedBuiltinProfiles(): void {
    try {
      const stmt = DatabaseService.getInstance().getDb().prepare(
        `INSERT INTO sub_agent_profiles (id, name, description, system_prompt, tools_json, skills_json, provider_id, model_id, source, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           name = excluded.name, description = excluded.description,
           system_prompt = excluded.system_prompt, tools_json = excluded.tools_json,
           skills_json = excluded.skills_json, source = 'builtin', updated_at = excluded.updated_at`
      )
      const ts = now()
      for (const p of BUILTIN_PROFILES) {
        stmt.run(p.id, p.name, p.description, p.system_prompt, p.tools_json, p.skills_json, p.provider_id, p.model_id, p.source, ts, ts)
      }
      // 清理历史版本已下线但仍在库内的内置模板（如早期版本内置的评审/写作/数据分析）
      const ids = BUILTIN_PROFILES.map(p => p.id)
      DatabaseService.getInstance().getDb()
        .prepare(`DELETE FROM sub_agent_profiles WHERE source = 'builtin' AND id NOT IN (${ids.map(() => '?').join(',')})`)
        .run(...ids)
    } catch (err: any) {
      logger.warn('播种内置子智能体模板失败:', err?.message || err)
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
