import { LightAgent, createBuiltinTools, ToolRegistry, SkillManager } from './index'

async function testAgent() {
  console.log('🚀 初始化 LightAgent 组件...')

  // 测试 ToolRegistry
  console.log('\n🧪 测试 ToolRegistry...')
  const registry = new ToolRegistry()
  const builtinTools = createBuiltinTools()
  registry.registerTools(builtinTools)
  console.log('✅ ToolRegistry 注册工具数量:', registry.getTools().length)
  console.log('📦 注册的工具:', registry.getTools().map(t => t.name))

  // 测试 SkillManager
  console.log('\n🧪 测试 SkillManager...')
  const skillManager = new SkillManager(['skills'])
  const skills = skillManager.discoverSkills()
  console.log('✅ 发现技能数量:', skills.length)
  console.log('🎯 技能列表:', skills.map(s => s.name))

  // 测试 LightAgent
  console.log('\n🧪 测试 LightAgent...')
  const agent = new LightAgent({
    name: '测试助手',
    instructions: '你是一个有帮助的测试助手',
    role: '测试助手',
    model: 'gpt-4o-mini',
    apiKey: process.env.OPENAI_API_KEY,
    baseUrl: process.env.OPENAI_BASE_URL,
    skillsDirectories: ['skills'],
    autoDiscoverSkills: true,
    debug: true,
    logLevel: 'debug'
  })

  // 注册内置工具
  agent.registerTools(builtinTools)

  // 注册技能工具
  const skillTools = agent.createSkillTools()
  agent.registerTools(skillTools)

  console.log('✅ 工具注册完成')
  console.log('📦 可用工具:', agent.getTools().map(t => t.function.name))

  console.log('\n✅ 测试完成！')
}

// 运行测试
testAgent().catch(console.error)
