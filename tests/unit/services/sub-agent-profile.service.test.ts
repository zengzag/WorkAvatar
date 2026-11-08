import { describe, it, expect, beforeEach, vi } from 'vitest'

/** 内存表模拟 sub_agent_profiles 读写 */
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
              const idx = rowsState.rows.findIndex(r => r.id === args[0])
              const row = {
                id: args[0], name: args[1], description: args[2], system_prompt: args[3],
                tools_json: args[4], skills_json: args[5], provider_id: args[6], model_id: args[7],
                source: args[8], created_at: args[9], updated_at: args[10],
              }
              if (idx >= 0) rowsState.rows[idx] = row
              else rowsState.rows.push(row)
              return { changes: 1 }
            }
            if (sql.includes('DELETE FROM sub_agent_profiles')) {
              if (sql.includes('NOT IN')) {
                for (let i = rowsState.rows.length - 1; i >= 0; i--) {
                  const row = rowsState.rows[i]
                  if (row.source === 'builtin' && !args.includes(row.id)) rowsState.rows.splice(i, 1)
                }
                return { changes: 1 }
              }
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

import SubAgentProfileService from '../../../electron/main/services/sub-agent-profile.service'

describe('SubAgentProfileService', () => {
  let service: SubAgentProfileService

  beforeEach(() => {
    rowsState.reset()
    service = SubAgentProfileService.getInstance()
  })

  it('seedBuiltinProfiles：播种探索/通用两个内置模板（source=builtin，幂等不重复）', () => {
    service.seedBuiltinProfiles()
    service.seedBuiltinProfiles()
    const list = service.list()
    expect(list.map(p => p.id).sort()).toEqual([
      'sap-builtin-explore',
      'sap-builtin-general',
    ])
    expect(list.every(p => p.source === 'builtin')).toBe(true)
    expect(list.every(p => p.system_prompt.length > 0)).toBe(true)
    expect(list.every(p => p.description.length > 0)).toBe(true)
  })

  it('seedBuiltinProfiles：检索类声明只读工具白名单，通用类继承完整工具集，并清理已下线内置模板', () => {
    rowsState.rows.push({
      id: 'sap-builtin-retired', name: '已下线', description: '', system_prompt: 'p',
      tools_json: '[]', skills_json: '[]', provider_id: null, model_id: null,
      source: 'builtin', created_at: 1, updated_at: 1,
    })
    service.seedBuiltinProfiles()

    const explore = service.get('sap-builtin-explore')!
    expect(JSON.parse(explore.tools_json)).toContain('file_read')
    expect(JSON.parse(explore.tools_json)).not.toContain('file_write')
    expect(explore.description).toContain('只读')

    expect(service.get('sap-builtin-general')!.tools_json).toBe('[]')
    expect(service.get('sap-builtin-retired')).toBeNull()
  })

  it('remove：内置模板不可删除，历史用户模板可删除', () => {
    service.seedBuiltinProfiles()
    expect(service.remove('sap-builtin-explore').ok).toBe(false)
    expect(service.remove('sap-builtin-explore').error).toContain('内置')

    rowsState.rows.push({
      id: 'sap-legacy', name: '旧模板', description: '', system_prompt: 'p',
      tools_json: '[]', skills_json: '[]', provider_id: null, model_id: null,
      source: 'user', created_at: 1, updated_at: 1,
    })
    expect(service.remove('sap-legacy').ok).toBe(true)
    expect(service.get('sap-legacy')).toBeNull()
    expect(service.remove('sap-legacy').ok).toBe(false)
  })

  it('toEphemeralSpec：模板 → 临时角色规格（无模型覆盖时继承主管）', () => {
    service.seedBuiltinProfiles()
    const explore = service.get('sap-builtin-explore')!
    const spec = service.toEphemeralSpec(explore)
    expect(spec).toMatchObject({
      key: 'sap-builtin-explore',
      name: explore.name,
      systemPrompt: explore.system_prompt,
    })
    expect(spec.tools).toContain('file_read')
    expect(spec.skills).toEqual([])
    expect(spec.providerId).toBeUndefined()
    expect(spec.modelId).toBeUndefined()
  })
})
