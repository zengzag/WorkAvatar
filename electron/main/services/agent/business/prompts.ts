export function buildEmployeeSystemPrompt(options: {
  name: string
  instructions: string
  role?: string
  hasSkills?: boolean
  workspaceGuidance?: string
  minimalMode?: boolean
  onDemandToolList?: string
  hasReportGeneratedFiles?: boolean
}): string {
  if (options.minimalMode) {
    return [
      `[IDENTITY] 你是一名数字员工，称呼为 ${options.name}。`,
      options.role ? `角色定位：${options.role}` : '',
      options.instructions ? `自定义指令：${options.instructions}` : '',
    ].filter(Boolean).join('\n')
  }

  const parts: string[] = []
  const instructions = (options.instructions || '').trim()

  // ============================================================
  // [IDENTITY] 身份锚定（极简 1-2 句，位置最强加权）
  // ============================================================
  parts.push(`[IDENTITY] 你是一名数字员工，称呼为 ${options.name}。`)
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
  parts.push('- 事实优先：涉及具体信息时以工具结果为准，不臆测。')
  parts.push('- 回复力求简洁、重点突出，采用 Markdown 分点呈现；除非用户明确要求，不添加冗余的开场白或总结。')
  parts.push('- 小任务或常识性问题直接执行或直接回答，避免过度规划与不必要的工具调用。')
  parts.push('- 注意系统运行环境差异（如路径分隔符、脚本语法等）。')
  if (options.hasReportGeneratedFiles) {
    parts.push('- 创建或修改了用户能直接消费的成品文档（Word/Excel/PPT/PDF/图片等）时，在最终回复前调用一次 report_generated_files 声明文件路径，使其在消息下方展示可预览卡片；临时文件/配置/脚本不要声明。')
  }

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
  if (options.hasSkills) {
    // 技能清单不再嵌入 system prompt（保持字节级稳定），实际清单随 <skills> 上下文块注入
    capabilities.push('技能：匹配到技能时，先 activate_skill 加载完整指令，再按指令执行。')
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
  parts.push('[RULES_REPEAT] 重申核心原则：涉及具体信息时以工具结果为准；回复保持简洁精炼。')

  return parts.join('\n')
}

/**
 * 构造独立的上下文消息内容（放在一条独立 role=user 消息中，不与本轮请求混在同一消息）。
 * 消息边界 = 语义边界，LLM 绝不会把"记忆/偏好"当成本轮用户请求执行。
 * 返回 undefined 表示无上下文，不需要插入额外消息。
 */
export function buildContextMessageContent(params: {
  skillsPrompt?: string
  memoryPrompt?: string
  kbContextPrompt?: string
  workspaceContextPrompt?: string
}): string | undefined {
  const { skillsPrompt, memoryPrompt, kbContextPrompt, workspaceContextPrompt } = params
  const blocks: string[] = []
  // skills 在前（字节级稳定），workspace 次之（任务工作区随会话稳定），memory 次之，kb 范围最后
  if (skillsPrompt) blocks.push(skillsPrompt) // getSkillsXml() 已自带 <skills> 包裹
  if (workspaceContextPrompt) blocks.push(`<workspace>${workspaceContextPrompt}</workspace>`)
  if (memoryPrompt) blocks.push(`<memory>${memoryPrompt}</memory>`)
  if (kbContextPrompt) blocks.push(`<knowledge_scope>${kbContextPrompt}</knowledge_scope>`)
  if (blocks.length === 0) return undefined

  const header = '【上下文注入 · 非本次用户请求】'
  const footer = '【上下文结束 · 请优先响应随后到来的用户消息】'
  return [header, ...blocks, footer].join('\n')
}
