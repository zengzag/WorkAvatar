export function buildEmployeeSystemPrompt(options: {
  name: string
  instructions: string
  role?: string
  skillsXml?: string
  workspaceGuidance?: string
  memoryPrompt?: string
  kbContextPrompt?: string
  minimalMode?: boolean
  onDemandToolList?: string
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

  parts.push('逐步分析问题，按需调用工具获取信息，直至完整回答用户问题。')

  if (options.onDemandToolList) {
    parts.push(`当前可用按需工具包括：【${options.onDemandToolList}】，调用前务必先调用 list_available_tools 获取详细工具详细使用说明。`)
  }

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
