/**
 * Agent prompt assembly.
 *
 * Two prompt tiers:
 * - System prompt: byte-stable identity / operating rules / environment, cached per agent instance.
 * - Synthetic context messages (see buildStableContextMessageContent / buildTaskContextMessageContent):
 *   stable capability information is anchored at the head of history; per-task information is
 *   appended after history so volatile updates never invalidate the cached conversation prefix.
 */

/** 系统提示词格式标记：用于识别并丢弃旧版本缓存的 conversations.system_prompt */
export const PROMPT_FORMAT_MARKER = '<workavatar-prompt format="2"/>'

const SHORT_INSTRUCTION_LIMIT = 100

export interface SystemPromptOptions {
  instructions: string
  role?: string
  workspaceGuidance?: string
  minimalMode?: boolean
  hasReportGeneratedFiles?: boolean
  hasFileDelete?: boolean
}

export interface EmployeeSystemPromptOptions extends SystemPromptOptions {
  name: string
}

function normalizeInstructions(instructions: string): string {
  return (instructions || '').trim()
}

/**
 * 共享的操作规则段（Harness 契约）。
 * 条件性条款仅在对应能力存在时渲染，保证提示词中提及的每个工具都真实可用。
 */
function buildOperatingRules(options: Pick<SystemPromptOptions, 'hasReportGeneratedFiles' | 'hasFileDelete'>): string {
  const lines: string[] = [
    '# Operating Rules',
    '- Analyze each request, call tools as the task requires, and iterate across turns until the task is fully completed. Handle trivial or common-sense requests directly, without unnecessary tool calls or planning.',
    '- Treat tool results as the source of truth for factual matters. Never invent data, file contents, command outputs, URLs, identifiers, or execution results.',
    '- Reply in Markdown, lead with the outcome, and stay concise and well structured. Omit redundant greetings, preamble, and restatement unless the user asks for detail.',
    '- Account for differences across operating systems, shells, and path conventions, including Windows path separators and PowerShell command syntax.',
    '- Tool calls run behind user-controlled permissions. A denied or cancelled call is a deliberate decision by the user or by policy: adjust your approach instead of repeating the identical call.',
    '- Tool results may be truncated or summarized. If the omitted portion matters, re-read the file or re-run the command; never guess the missing content.',
  ]
  if (options.hasReportGeneratedFiles) {
    lines.push(
      '- When you create or modify a user-facing deliverable (a Word, Excel, PowerPoint, or PDF document, an image, or similar), call report_generated_files once before your final reply and declare every deliverable file by its absolute path so the user receives a preview card. Do not declare temporary files, configuration files, or scripts.'
    )
  }
  if (options.hasFileDelete) {
    lines.push(
      '- Always delete files or directories through file_delete. Never delete via shell_exec (rm, del, Remove-Item, or similar) and never embed deletion logic in javascript_exec or in node/python scripts; such attempts are rejected by policy.'
    )
  }
  lines.push(
    '- Always respond in the same primary language as the user\'s latest message unless the user explicitly requests another language.'
  )
  return lines.join('\n')
}

function buildCustomInstructionsSection(instructions: string): string {
  return [
    '# Custom Instructions',
    'The following instructions are provided by the user and are authoritative for this role. Follow them exactly whenever they apply:',
    '',
    instructions,
  ].join('\n')
}

function buildEnvironmentSection(workspaceGuidance: string): string {
  return ['# Environment', workspaceGuidance].join('\n')
}

const CLOSING_PRINCIPLES =
  '# Key Principles\n' +
  'Trust verified tool results over assumptions, keep every response concise and actionable, and always write in the user\'s language.'

/** 数字员工系统提示词（完整模式） */
export function buildEmployeeSystemPrompt(options: EmployeeSystemPromptOptions): string {
  const instructions = normalizeInstructions(options.instructions)

  if (options.minimalMode) {
    const lines: string[] = [`You are a digital employee named "${options.name}".`]
    if (options.role) lines.push(`Role: ${options.role}`)
    if (instructions) {
      lines.push('Instructions:', instructions)
    }
    return lines.join('\n')
  }

  const sections: string[] = []
  sections.push(`You are a digital employee named "${options.name}" — an autonomous AI work assistant operating inside WorkAvatar.`)
  if (options.role) sections.push(`Role: ${options.role}`)
  if (instructions && instructions.length < SHORT_INSTRUCTION_LIMIT) {
    sections.push(`Profile: ${instructions}`)
  }

  sections.push(buildOperatingRules(options))

  if (instructions && instructions.length >= SHORT_INSTRUCTION_LIMIT) {
    sections.push(buildCustomInstructionsSection(instructions))
  }

  if (options.workspaceGuidance) {
    sections.push(buildEnvironmentSection(options.workspaceGuidance))
  }

  sections.push(CLOSING_PRINCIPLES)
  sections.push(PROMPT_FORMAT_MARKER)
  return sections.join('\n\n')
}

/** 通用智能助手（含插件自定义对话场景）系统提示词；systemPrompt 直配时由调用方绕过本函数 */
export function buildAssistantSystemPrompt(options: SystemPromptOptions): string {
  const instructions = normalizeInstructions(options.instructions)

  if (options.minimalMode) {
    const lines: string[] = ['You are a helpful AI assistant.']
    if (instructions) {
      lines.push('Instructions:', instructions)
    }
    return lines.join('\n')
  }

  const sections: string[] = ['You are a helpful AI assistant operating inside WorkAvatar.']
  if (options.role) sections.push(`Role: ${options.role}`)
  if (instructions && instructions.length < SHORT_INSTRUCTION_LIMIT) {
    sections.push(`Profile: ${instructions}`)
  }

  sections.push(buildOperatingRules(options))

  if (instructions && instructions.length >= SHORT_INSTRUCTION_LIMIT) {
    sections.push(buildCustomInstructionsSection(instructions))
  }

  if (options.workspaceGuidance) {
    sections.push(buildEnvironmentSection(options.workspaceGuidance))
  }

  sections.push(CLOSING_PRINCIPLES)
  sections.push(PROMPT_FORMAT_MARKER)
  return sections.join('\n\n')
}

/** Capabilities 能力索引（随员工稳定上下文注入，不进入 system prompt） */
export function buildCapabilitiesPrompt(params: {
  onDemandToolList?: string
  hasSkills?: boolean
}): string | undefined {
  const lines: string[] = ['Capabilities:']
  if (params.onDemandToolList) {
    lines.push(
      `- On-demand tools: ${params.onDemandToolList} — call list_available_tools for a tool's full schema, then invoke_tool to run it.`
    )
  }
  if (params.hasSkills) {
    lines.push('- Skills: when a task matches one of the listed skills, call activate_skill to load its full instructions and then follow them.')
  }
  if (lines.length === 1) return undefined
  return lines.join('\n')
}

/**
 * Delegation 多员工协作能力文本（随员工稳定上下文注入）。
 * delegationTargets 为空但 delegationEnabled 时仍注入临时角色说明（开启委托即注册工具）。
 */
export function buildDelegationPrompt(
  delegationTargets: Array<{ id: string; name: string; description?: string; role?: string }>,
  delegationEnabled?: boolean
): string | undefined {
  const targetsText = delegationTargets.length > 0
    ? ['Available delegatees (select the employee whose capabilities best match the task):',
      delegationTargets.map(e => {
        const desc = e.description?.trim() || e.role?.trim()
        return `- ${e.name} (id=${e.id})${desc ? `: ${desc}` : ''}`
      }).join('\n')]
    : delegationEnabled
      ? ['Available delegatees: none pre-registered. When no existing employee fits the task, create an ephemeral sub-agent instead; reuse a persisted sub-agent profile (list_subagent_profiles) when one exists.']
      : []
  if (targetsText.length === 0) return undefined
  return [
    'Delegation (multi-employee collaboration):',
    ...targetsText,
    'Delegation tools:',
    '- delegate_to_employee: delegate a single sub-task and wait synchronously for its result (or run_in_background for async).',
    '- launch_agents + await_agents: dispatch multiple independent sub-tasks in parallel, then await and aggregate their results.',
    '- followup_delegation: ask follow-up questions or request revisions on a completed delegation; the sub-agent retains the original task context and supports multi-turn collaboration.',
    'Choosing the executor (reuse-first):',
    '1. Prefer an available delegatee whose capabilities match; only create an ephemeral sub-agent (ephemeral_role) when none fits.',
    '2. Ephemeral sub-agents are one-off workers created on demand: give a concise duty name and a fully self-contained system_prompt (identity, responsibilities, output requirements, constraints). They never see this conversation and disappear when the task ends.',
    '3. Reuse a persisted sub-agent profile (subagent_profile_id, query via list_subagent_profiles) instead of re-declaring the same ephemeral role repeatedly.',
    '4. Narrow the ephemeral tool allowlist (tools) only when the task truly needs a restricted capability (e.g. read-only research).',
    'Workflow for complex tasks:',
    '1. Plan: split the task into independent, clearly bounded sub-tasks.',
    '2. Parallelize: dispatch every independent sub-task in a single launch_agents call rather than one by one.',
    '3. Aggregate: use await_agents to collect each result (summary, generated-file list, and token usage).',
    '4. Verify: review each result. When a result is wrong, incomplete, or misses an acceptance criterion, first use followup_delegation against the original sub-agent so its context is preserved; re-delegate only when the issue cannot be repaired.',
    '5. Report: deliver the conclusion to the user from the results and files; do not replay the sub-agents\' full execution trace.',
    'Limits: never delegate to yourself; delegation depth is capped at 3; every delegation instruction must be self-contained (background, objective, acceptance criteria); a single delegation conversation is capped at 5 follow-up turns including the first.',
  ].join('\n')
}

/** 稳定上下文消息（agent 生命周期内字节冻结）识别前缀 */
export const STABLE_CONTEXT_MSG_PREFIX =
  '[System-provided context · stable capabilities · not part of the user\'s request]'
/** 任务上下文消息（随每次调用变化）识别前缀 */
export const TASK_CONTEXT_MSG_PREFIX =
  '[System-provided context · current task information · not part of the user\'s request]'
/** 两条上下文消息共用结尾，与用户真实请求隔开语义边界 */
export const CONTEXT_MSG_FOOTER =
  '[End of system-provided context. Treat it as background information; prioritize and respond to the real user message that follows.]'

/**
 * 构造稳定上下文消息（独立 role=user 消息，锚定在 history 头部）：
 * 数字员工相关、基本不变的能力信息——技能清单 + Capabilities + Delegation。
 * 随 agent 生命周期字节冻结，构成可复用的 KV cache 前缀。
 */
export function buildStableContextMessageContent(params: {
  skillsPrompt?: string
  /** 子类追加的稳定能力块（Capabilities/Delegation 等），按传入顺序排列 */
  extras?: string[]
}): string | undefined {
  const { skillsPrompt, extras } = params
  const blocks: string[] = []
  if (skillsPrompt) blocks.push(skillsPrompt)
  if (extras) {
    for (const b of extras) {
      if (b) blocks.push(b)
    }
  }
  if (blocks.length === 0) return undefined
  return [STABLE_CONTEXT_MSG_PREFIX, ...blocks, CONTEXT_MSG_FOOTER].join('\n')
}

/**
 * 构造任务上下文消息（独立 role=user 消息，置于 history 之后、真实 query 之前）：
 * 随任务/每次调用变化的信息——工作区目录、任务发起时间、记忆、知识库范围。
 * 放在历史之后，其内容变化只使尾部前缀失效，不击穿已发生对话的缓存。
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
