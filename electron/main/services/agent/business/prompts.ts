export function buildEmployeeSystemPrompt(options: {
  name: string
  instructions: string
  role?: string
  skillsXml?: string
  activeSkillInstructions?: string[]
  knowledgeGuidance?: string
  workspaceGuidance?: string
}): string {
  const parts: string[] = []

  parts.push(`## 名称：${options.name}`)
  parts.push(`## 指令：${options.instructions}`)

  if (options.role) {
    parts.push(`## 身份：${options.role}`)
  }

  parts.push(
    '逐步分析问题，按需调用工具获取信息，直至完整回答用户问题。',
    '可调用知识库工具查询相关知识。'
  )

  if (options.knowledgeGuidance) {
    parts.push(options.knowledgeGuidance)
  }

  if (options.workspaceGuidance) {
    parts.push(options.workspaceGuidance)
  }

  if (options.skillsXml) {
    parts.push(`\n## 可用技能\n${options.skillsXml}`)
    parts.push('当用户需求与某个技能描述匹配时，请先使用 activate_skill 工具加载完整指令。')
  }

  if (options.activeSkillInstructions && options.activeSkillInstructions.length > 0) {
    parts.push(`\n## 已激活技能指令\n${options.activeSkillInstructions.join('\n\n---\n\n')}`)
  }

  return parts.join('\n')
}

export const KNOWLEDGE_QUERY_GUIDANCE = '查询知识时遵循：先概览 → 再检索 → 最后精准定位。'
