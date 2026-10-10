import { describe, it, expect, beforeEach, vi } from 'vitest'

/** 内存表模拟 sub_agent_profiles CRUD */
const rowsState = vi.hoisted(() => {
  const rows: Array<Record<string, unknown>> = []
  return {
    rows,
    reset: () => { rows.length = 0 },
  }
})

vi.mock('../../../electron/main/services/database.service', () => ({
  default: {
    getInstance: () => ({
      getDb: () => ({
        prepare: vi.fn((sql: string) => ({
          get: (...args: any[]) => {
            if (sql.includes('SELECT * FROM sub_agent_profiles WHERE id = ?')) {
              return rowsState.rows.find(r => r.id === args[0])
            }
            return undefined
          },
          all: () => {
            if (sql.includes('SELECT * FROM sub_agent_profiles ORDER BY updated_at DESC')) {
              return [...rowsState.rows].sort((a, b) => (b.updated_at as number) - (a.updated_at as number))
            }
            return []
          },
          run: (...args: any[]) => {
            if (sql.includes('INSERT INTO sub_agent_profiles')) {
              rowsState.rows.push({
                id: args[0], name: args[1], description: args[2], system_prompt: args[3],
                tools_json: args[4], skills_json: args[5], provider_id: args[6], model_id: args[7],
                source: args[8], created_at: args[9], updated_at: args[10],
              })
              return { changes: 1 }
            }
            if (sql.includes('UPDATE sub_agent_profiles')) {
              const row = rowsState.rows.find(r => r.id === args[8])
              if (!row) return { changes: 0 }
              row.name = args[0]
              row.description = args[1]
              row.system_prompt = args[2]
              row.tools_json = args[3]
              row.skills_json = args[4]
              row.provider_id = args[5]
              row.model_id = args[6]
              row.updated_at = args[7]
              return { changes: 1 }
            }
            if (sql.includes('DELETE FROM sub_agent_profiles')) {
              const idx = rowsState.rows.findIndex(r => r.id === args[0])
              if (idx >= 0) rowsState.rows.splice(idx, 1)
              return { changes: idx >= 0 ? 1 : 0 }
            }
            return { changes: 0 }
          },
        })),
      }),
    }),
  },
}))

vi.mock('../../../electron/main/services/common-utils', () => ({
  generateId: vi.fn(() => `id${Math.random().toString(36).slice(2, 8)}`),
}))

import SubAgentProfileService from '../../../electron/main/services/sub-agent-profile.service'

describe('SubAgentProfileService', () => {
  let service: SubAgentProfileService

  beforeEach(() => {
    rowsState.reset()
    service = SubAgentProfileService.getInstance()
  })

  it('create：校验必填并生成可修正错误', () => {
    expect(service.create({}).error).toContain('name')
    expect(service.create({ name: 'A' }).error).toContain('system_prompt')
    expect(service.create({ name: 'x'.repeat(60), system_prompt: 'p' }).error).toContain('超长')
    expect(service.create({ name: '  ', system_prompt: 'p' }).error).toContain('name')
  })

  it('create/list/get：字段归一（tools 数组落 JSON，模型可选）', () => {
    const { profile } = service.create({
      name: '财报分析师',
      description: '分析财报',
      system_prompt: '你是财报分析专家',
      tools: ['file_read', 123, 'web_search'],
      skills: [],
      provider_id: 'p1',
      model_id: 'm1',
    }) as any
    expect(profile.id).toMatch(/^sap-/)
    expect(profile.source).toBe('user')
    expect(JSON.parse(profile.tools_json)).toEqual(['file_read', 'web_search'])
    expect(service.list()).toHaveLength(1)
    expect(service.get(profile.id)?.name).toBe('财报分析师')
  })

  it('update：部分字段合并，不存在时报错', () => {
    const { profile } = service.create({ name: 'A', system_prompt: 'pa' }) as any
    const { profile: updated } = service.update(profile.id, { name: 'B', tools: ['kms_search'] }) as any
    expect(updated.name).toBe('B')
    expect(updated.system_prompt).toBe('pa')
    expect(JSON.parse(updated.tools_json)).toEqual(['kms_search'])
    expect(service.update('no-such', { name: 'C' }).error).toContain('不存在')
  })

  it('remove：仅 user 来源可删', () => {
    const { profile } = service.create({ name: 'A', system_prompt: 'p' }) as any
    expect(service.remove(profile.id).ok).toBe(true)
    expect(service.get(profile.id)).toBeNull()
    expect(service.remove(profile.id).ok).toBe(false)

    const builtin = service.create({ name: 'B', system_prompt: 'p' })!.profile!
    // 模拟内置来源
    const row = rowsState.rows.find(r => r.id === builtin.id)!
    row.source = 'builtin'
    expect(service.remove(builtin.id).ok).toBe(false)
    expect(service.remove(builtin.id).error).toContain('内置')
  })

  it('toEphemeralSpec：模板 → 临时角色规格（模型成对透传）', () => {
    const { profile } = service.create({
      name: '调研员', description: '只读检索', system_prompt: '你是调研员',
      tools: ['web_search'], skills: ['sk'], provider_id: 'p1', model_id: 'm1',
    }) as any
    const spec = service.toEphemeralSpec(service.get(profile.id)!)
    expect(spec).toMatchObject({
      key: profile.id,
      name: '调研员',
      systemPrompt: '你是调研员',
      tools: ['web_search'],
      skills: ['sk'],
      providerId: 'p1',
      modelId: 'm1',
    })
    // 无模型时继承主管（provider/model 为 undefined）
    const { profile: p2 } = service.create({ name: 'C', system_prompt: 'p' }) as any
    const spec2 = service.toEphemeralSpec(service.get(p2.id)!)
    expect(spec2.providerId).toBeUndefined()
    expect(spec2.modelId).toBeUndefined()
  })

  it('seedBuiltinProfiles：播种内置 explore/general（source=builtin，工具白名单/全能力）', () => {
    service.seedBuiltinProfiles()
    const list = service.list()
    expect(list.map(p => p.id).sort()).toEqual(['sap-builtin-explore', 'sap-builtin-general'])
    expect(list.every(p => p.source === 'builtin')).toBe(true)

    const explore = service.get('sap-builtin-explore')!
    expect(JSON.parse(explore.tools_json)).toContain('file_read')
    expect(explore.description).toContain('只读')

    // general 不声明工具白名单 → 继承完整工具集
    expect(service.get('sap-builtin-general')!.tools_json).toBe('[]')
  })

  it('update/remove：内置模板只读（不可改、不可删）', () => {
    service.seedBuiltinProfiles()
    expect(service.update('sap-builtin-explore', { name: 'x' }).error).toContain('内置模板不可修改')
    expect(service.remove('sap-builtin-explore').error).toContain('内置')
  })
})
