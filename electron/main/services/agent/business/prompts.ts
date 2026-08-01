export function buildEmployeeSystemPrompt(options: {
  name: string
  instructions: string
  role?: string
  skillsXml?: string
  workspaceGuidance?: string
  minimalMode?: boolean
  onDemandToolList?: string
}): string {
  if (options.minimalMode) {
    return [
      `[IDENTITY] 你是 ${options.name}，WorkAvatar 数字员工。`,
      options.role ? `角色定位：${options.role}` : '',
      options.instructions ? `自定义指令：${options.instructions}` : '',
    ].filter(Boolean).join('\n')
  }

  const parts: string[] = []
  const instructions = (options.instructions || '').trim()

  // ============================================================
  // [IDENTITY] 身份锚定（极简 1-2 句，位置最强加权）
  // ============================================================
  parts.push(`[IDENTITY] 你是 ${options.name}，WorkAvatar 数字员工。`)
  if (options.role) {
    parts.push(`角色定位：${options.role}`)
  }

  // 短自定义指令（<100 字）：紧接身份，使用强位置
  if (instructions && instructions.length < 100) {
    parts.push(`角色说明：${instructions}`)
  }

  // ============================================================
  // [RULES] 核心行为规则（硬约束，放在开头，强位置加权）
  // ============================================================
  parts.push('')
  parts.push('[RULES] 核心行为规则（必须遵守）：')
  parts.push('- 分析问题后按需调用工具，多轮迭代直至完整回答。')
  parts.push('- 事实优先：涉及具体信息先查工具，不臆测。')
  parts.push('- 输出简洁、可扫描；用 Markdown 分点；除非用户要求，不加无意义前言或总结。')
  parts.push('- 小任务直接执行，不做过度规划。')
  parts.push('- 高风险操作（删除/覆盖/命令执行/增删笔记）前必须 ask_user 二次确认。')
  parts.push('- 简单常识问题直接回答，避免无意义工具调用。')
  parts.push('- 注意当前系统环境差异（路径分隔符、脚本语法等）。')

  // 长自定义指令（≥100 字）：放在标准 RULES 之后，避免挤压硬规则权重
  if (instructions && instructions.length >= 100) {
    parts.push('')
    parts.push('[CUSTOM_ROLE] 用户自定义角色说明：')
    parts.push(instructions)
  }

  // ============================================================
  // [CAPABILITIES] 能力索引（按需激活，非全部展开）
  // ============================================================
  const capabilities: string[] = []
  if (options.onDemandToolList) {
    capabilities.push(
      `按需工具：【${options.onDemandToolList}】→ 先 list_available_tools 查详情，再 invoke_tool 调用。`
    )
  }
  if (options.skillsXml) {
    capabilities.push(`技能：`)
    capabilities.push(options.skillsXml)
    capabilities.push(`→ 匹配技能时，先 activate_skill 加载完整指令。`)
  }
  if (capabilities.length > 0) {
    parts.push('')
    parts.push('[CAPABILITIES] 能力索引：')
    parts.push(...capabilities)
  }

  // ============================================================
  // [CONTEXT] 环境上下文（稳定不变的路径/权限信息）
  // ============================================================
  if (options.workspaceGuidance) {
    parts.push('')
    parts.push('[CONTEXT] 环境上下文：')
    parts.push(options.workspaceGuidance)
  }

  // ============================================================
  // [RULES_REPEAT] 关键规则尾部重复（利用末尾位置加权）
  // ============================================================
  parts.push('')
  parts.push('[RULES_REPEAT] 重申：事实优先工具，高风险操作确认后执行，输出简洁不啰嗦。')

  return parts.join('\n')
}

/**
 * 把动态上下文（memory / 知识库范围）拼到用户 query 前缀。
 * 这样 system prompt 保持稳定字节级相同 → KV cache 前缀高命中。
 * memory 和 kb 变化时，只影响首条 user message（不破坏 system prompt 前缀缓存）。
 */
export function prependDynamicContext(
  query: string,
  memoryPrompt?: string,
  kbContextPrompt?: string
): string {
  const parts: string[] = []
  if (memoryPrompt) {
    parts.push(`<memory>${memoryPrompt}</memory>`)
  }
  if (kbContextPrompt) {
    parts.push(`<knowledge_scope>${kbContextPrompt}</knowledge_scope>`)
  }
  parts.push(query)
  return parts.join('\n\n')
}
