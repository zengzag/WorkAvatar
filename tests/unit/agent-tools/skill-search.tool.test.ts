import { describe, it, expect, vi, beforeEach } from 'vitest'

const h = vi.hoisted(() => ({
  installed: [] as any[],
}))

vi.mock('../../../electron/main/services/skill-registry.service', () => ({
  default: { getInstance: () => ({ getInstalledSkills: () => h.installed }) },
}))

vi.mock('../../../electron/main/services/agent/core/pi-agent-adapter', () => ({
  runPiAgentLoop: vi.fn(),
}))

vi.mock('../../../electron/main/services/logger', () => ({
  createLogger: () => ({ debug: () => {}, info: () => {}, warn: () => {}, error: () => {} }),
}))

import { GenericAgent } from '../../../electron/main/services/agent/business/generic-agent'

const skill = (over: Partial<any> & { name: string }) => ({
  description: `desc-${over.name}`,
  skillMdContent: `instructions-${over.name}`,
  installPath: `/skills/${over.name}`,
  is_enabled: true,
  references: [],
  tags: [],
  manifest: {},
  ...over,
})

const createTool = () => {
  const agent = new GenericAgent({ model: 'gpt-x', providerType: 'openai', autoDiscoverSkills: true })
  const tool = agent.createSkillTools().find((item) => item.id === 'search_skills')
  if (!tool) throw new Error('search_skills tool not registered')
  return tool
}

beforeEach(() => {
  h.installed = []
})

describe('search_skills 工具', () => {
  it('空查询返回参数错误', async () => {
    const result = await createTool().handler({ query: '   ' })
    expect(result.success).toBe(false)
    expect(result.error).toContain('query')
  })

  it('无匹配时返回已启用技能名，便于模型自我纠正', async () => {
    h.installed = [skill({ name: 'patent-disclosure' })]
    const result = await createTool().handler({ query: 'quantum chromodynamics' })
    expect(result.success).toBe(true)
    expect(result.output).toContain('No skill matched')
    expect(result.output).toContain('patent-disclosure')
  })

  it('高置信唯一匹配直接激活并返回技能指令', async () => {
    h.installed = [skill({ name: 'patent-disclosure' })]
    const result = await createTool().handler({ query: 'patent-disclosure' })
    expect(result.success).toBe(true)
    expect(result.output).toContain('Activated skill "patent-disclosure"')
    expect(result.output).toContain('instructions-patent-disclosure')
  })

  it('歧义匹配返回候选并提示改用 activate_skill', async () => {
    h.installed = [
      skill({ name: 'patent-disclosure', description: 'Draft patent disclosure documents.' }),
      skill({ name: 'patent-search', description: 'Search patent documents and prior art.' }),
    ]
    const result = await createTool().handler({ query: 'patent' })
    expect(result.success).toBe(true)
    expect(result.output).toContain('patent-disclosure')
    expect(result.output).toContain('patent-search')
    expect(result.output).toContain('activate_skill')
    expect(result.output).not.toContain('Activated skill')
  })
})
