export function buildEmployeeSystemPrompt(options: {
  name: string
  instructions: string
  role?: string
  skillsXml?: string
  workspaceGuidance?: string
  memoryPrompt?: string
  kbContextPrompt?: string
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
    '## 工具使用',
    '常用工具（文件读写、计算、时间、搜索、提问等）可直接调用。',
    '其他工具（资料库检索、日程管理、文档生成、Shell命令等）需先调用 list_available_tools 浏览可用工具并获取详细参数说明，再通过 invoke_tool 调用。',
    '不确定是否需要某工具时，先调用 list_available_tools 查看可用工具列表。'
  )

  if (options.workspaceGuidance) {
    parts.push(options.workspaceGuidance)
  }

  if (options.skillsXml) {
    parts.push(`\n## 可用技能\n${options.skillsXml}`)
    parts.push('当用户需求与某个技能描述匹配时，请先使用 activate_skill 工具加载完整指令。')
  }

  if (options.memoryPrompt) {
    parts.push(`\n## 跨任务记忆（关于该用户的持久信息）\n${options.memoryPrompt}`)
  }

  if (options.kbContextPrompt) {
    parts.push(`\n## ${options.kbContextPrompt}`)
  }

  return parts.join('\n')
}
