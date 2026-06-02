export function buildEmployeeSystemPrompt(options: {
  name: string
  instructions: string
  role?: string
  skillsXml?: string
  workspaceGuidance?: string
  memoryPrompt?: string
  kbContextPrompt?: string
  skillInstructions?: string[]
  toolPlanningHint?: string
  minimalMode?: boolean
}): string {
  const parts: string[] = []

  parts.push(`## 名称：${options.name}`)
  parts.push(`## 指令：${options.instructions}`)

  if (options.role) {
    parts.push(`## 身份：${options.role}`)
  }

  if (options.minimalMode) {
    return parts.join('\n')
  }

  parts.push(
    '逐步分析问题，按需调用工具获取信息，直至完整回答用户问题。',
    '可调用知识库工具查询相关知识。',
    KNOWLEDGE_QUERY_GUIDANCE
  )

  if (options.workspaceGuidance) {
    parts.push(options.workspaceGuidance)
  }

  if (options.skillsXml) {
    parts.push(`\n## 可用技能\n${options.skillsXml}`)
    parts.push('当用户需求与某个技能描述匹配时，请先使用 activate_skill 工具加载完整指令。')
  }

  if (options.memoryPrompt) {
    parts.push(`\n## 跨会话记忆（关于该用户的持久信息）\n${options.memoryPrompt}`)
  }

  if (options.kbContextPrompt) {
    parts.push(`\n## ${options.kbContextPrompt}`)
  }

  if (options.skillInstructions && options.skillInstructions.length > 0) {
    parts.push(`\n## 已激活技能指令\n${options.skillInstructions.join('\n\n---\n\n')}`)
  }

  if (options.toolPlanningHint) {
    parts.push(`\n## ${options.toolPlanningHint}`)
  }

  return parts.join('\n')
}

export const KNOWLEDGE_QUERY_GUIDANCE = '查询知识时遵循渐进式检索：kb_list 了解知识库 → kb_overview 确定目标文档 → kb_get_toc 查看目录 → kb_get_paragraphs 获取相关章节摘要 → kb_get_content 读取完整内容。信息不足时用 kb_search 补充搜索。'
