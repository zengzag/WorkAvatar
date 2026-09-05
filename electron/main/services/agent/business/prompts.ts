export function buildEmployeeSystemPrompt(options: {
  name: string
  instructions: string
  role?: string
  workspaceGuidance?: string
  minimalMode?: boolean
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

/** [CAPABILITIES] 能力索引文本（随员工稳定上下文注入，不再嵌入 system prompt） */
export function buildCapabilitiesPrompt(params: {
  onDemandToolList?: string
  hasSkills?: boolean
}): string | undefined {
  const capabilities: string[] = []
  if (params.onDemandToolList) {
    capabilities.push(
      `按需工具：【${params.onDemandToolList}】→ 先 list_available_tools 查详情，再 invoke_tool 调用。`
    )
  }
  if (params.hasSkills) {
    // 技能清单本身随 <skills> 上下文块注入，此处仅声明激活方式
    capabilities.push('技能：匹配到技能时，先 activate_skill 加载完整指令，再按指令执行。')
  }
  if (capabilities.length === 0) return undefined
  return ['[CAPABILITIES] 能力索引：', ...capabilities].join('\n')
}

/** [DELEGATION] 任务委托能力文本（随员工稳定上下文注入，不再嵌入 system prompt） */
export function buildDelegationPrompt(
  delegationTargets: Array<{ id: string; name: string; description?: string; role?: string }>
): string | undefined {
  if (delegationTargets.length === 0) return undefined
  const listText = delegationTargets
    .map(e => {
      const desc = e.description?.trim() || e.role?.trim()
      return `- ${e.name} (id=${e.id})${desc ? `：${desc}` : ''}`
    })
    .join('\n')
  return [
    '[DELEGATION] 任务委托（多员工协作）：',
    '可委托员工列表（依据能力描述选择最匹配任务的员工）：',
    listText,
    '委托方式：',
    '- delegate_to_employee：单个子任务串行委托，同步等待结果返回。',
    '- launch_agents + await_agents：多个相互独立的子任务并行派发，随后统一聚合结果。',
    '- followup_delegation：对已完成委托的结果追问/补充要求，子智能体保留原任务上下文，支持多轮协作。',
    '编排工作流（处理复杂任务时）：',
    '1. 规划：将大任务拆解为相互独立、边界清晰的子任务。',
    '2. 并行：launch_agents 一次性派发全部子任务（不要逐个串行派发）。',
    '3. 聚合：await_agents 等待并收集每个子任务的结果（摘要 + 生成文件清单 + token 用量）。',
    '4. 验证：审查各子任务结果——发现错误、缺失细节或不达验收标准时，优先用 followup_delegation 向原子智能体追问修正（保留其任务上下文）；无法补救或需换人时才重新委托。',
    '5. 汇总：基于结果与文件向用户交付结论，不复述子任务完整执行过程。',
    '限制：不能委托给自己；委托深度上限 3 层；委托指令需完整自包含（含背景、目标与验收标准）；同一委托对话追问轮数上限 5 轮（含首轮）。',
  ].join('\n')
}

/** 稳定上下文消息（数字员工能力）识别前缀：随 agent 生命周期基本不变 */
export const STABLE_CONTEXT_MSG_PREFIX = '【系统注入的上下文 · 数字员工能力信息 · 非本次用户请求】'
/** 任务上下文消息识别前缀：随任务/每次调用可能变化 */
export const TASK_CONTEXT_MSG_PREFIX = '【系统注入的上下文 · 本次任务信息 · 非本次用户请求】'
/** 两条上下文消息共用结尾，与用户真实请求隔开语义边界 */
export const CONTEXT_MSG_FOOTER = '【上下文结束 · 请优先响应随后到来的用户消息】'

/**
 * 构造稳定上下文消息（独立 role=user 消息第 1 条）：
 * 数字员工相关、基本不变的能力信息——技能清单 + [CAPABILITIES] + [DELEGATION]，
 * 随 agent 生命周期冻结，字节级稳定 → KV cache 前缀高命中。
 */
export function buildStableContextMessageContent(params: {
  skillsPrompt?: string
  /** 子类追加的稳定能力块（[CAPABILITIES]/[DELEGATION] 等），按传入顺序排列 */
  extras?: string[]
}): string | undefined {
  const { skillsPrompt, extras } = params
  const blocks: string[] = []
  if (skillsPrompt) blocks.push(skillsPrompt) // getSkillsXml() 已自带 <skills> 包裹
  if (extras) {
    for (const b of extras) {
      if (b) blocks.push(b)
    }
  }
  if (blocks.length === 0) return undefined
  return [STABLE_CONTEXT_MSG_PREFIX, ...blocks, CONTEXT_MSG_FOOTER].join('\n')
}

/**
 * 构造任务上下文消息（独立 role=user 消息第 2 条）：
 * 随任务/每次调用变化的信息——工作区目录、任务发起时间、记忆、知识库范围。
 * 稳定在前、易变在后，最大化前序前缀的 KV cache 命中。
 */
export function buildTaskContextMessageContent(params: {
  workspaceContextPrompt?: string
  taskTimePrompt?: string
  memoryPrompt?: string
  kbContextPrompt?: string
}): string | undefined {
  const { workspaceContextPrompt, taskTimePrompt, memoryPrompt, kbContextPrompt } = params
  const blocks: string[] = []
  if (workspaceContextPrompt) blocks.push(`<workspace>${workspaceContextPrompt}</workspace>`)
  if (taskTimePrompt) blocks.push(`<task_time>${taskTimePrompt}</task_time>`)
  if (memoryPrompt) blocks.push(`<memory>${memoryPrompt}</memory>`)
  if (kbContextPrompt) blocks.push(`<knowledge_scope>${kbContextPrompt}</knowledge_scope>`)
  if (blocks.length === 0) return undefined
  return [TASK_CONTEXT_MSG_PREFIX, ...blocks, CONTEXT_MSG_FOOTER].join('\n')
}
