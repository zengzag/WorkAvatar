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
export const PROMPT_FORMAT_MARKER = '<workavatar-prompt format="4"/>'

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
 * 只写模型无法从工具描述推断、且写错会真实出错的行为约束；通用常识与实现细节一律不写。
 * 条件性条款仅在对应能力存在时渲染，保证提示词中提及的每个工具都真实可用。
 */
function buildOperatingRules(options: Pick<SystemPromptOptions, 'hasReportGeneratedFiles' | 'hasFileDelete'>): string {
  const lines: string[] = [
    '# Operating Rules',
    '- Work autonomously until the request is complete. Ask the user only when a decision, missing input, or permission genuinely blocks progress; otherwise proceed with a reasonable assumption and state it.',
    '- Treat tool results as ground truth. Never invent file contents, command output, URLs, identifiers, numbers, or citations.',
    '- Verify before reporting: confirm each deliverable exists at the stated path and matches the requested format. Never claim success you have not observed.',
    '- A denied or cancelled tool call is final. Change the approach or report the blocker; never repeat the same call.',
    '- Truncated tool output is a partial result: re-read a narrower range or re-run the command instead of inferring the missing part.',
    '- Reply in the language of the user\'s latest message. Lead with the outcome, then the supporting detail; use Markdown only where structure helps. Omit greetings, filler, and restatements.',
    '- Follow the platform conventions in Environment: PowerShell with backslash paths on Windows; bash with forward slashes elsewhere.',
  ]
  if (options.hasReportGeneratedFiles) {
    lines.push(
      '- Before your final reply, call report_generated_files once with the absolute path of every user-facing deliverable you created or modified (documents, spreadsheets, presentations, PDFs, images). Exclude temporary files, configuration files, and scripts.'
    )
  }
  if (options.hasFileDelete) {
    lines.push(
      '- Delete files and directories only with file_delete; deletion through shell commands or scripts is blocked by policy.'
    )
  }
  return lines.join('\n')
}

function buildCustomInstructionsSection(instructions: string): string {
  return [
    '# Custom Instructions',
    'The user-provided instructions below define this role\'s duties, standards, and workflow. Follow them exactly whenever they apply; an explicit instruction in the current conversation overrides them for that turn.',
    '',
    instructions,
  ].join('\n')
}

function buildEnvironmentSection(workspaceGuidance: string): string {
  return ['# Environment', workspaceGuidance].join('\n')
}

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
  sections.push(`You are a digital employee named "${options.name}" — an autonomous work assistant operating inside WorkAvatar.`)
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
      `- On-demand tools: ${params.onDemandToolList} — call list_available_tools for the full parameter schema of the tools you need, then invoke_tool to run them.`
    )
  }
  if (params.hasSkills) {
    lines.push('- Skills: when a task matches one of the listed skills, call activate_skill to load its full instructions and follow them.')
  }
  if (lines.length === 1) return undefined
  return lines.join('\n')
}

/**
 * Delegation 多员工协作能力文本（随员工稳定上下文注入）。
 * delegationTargets 为空但 delegationEnabled 时仍注入临时角色说明（开启委托即注册工具）。
 * 结构：能力声明 → 工具 → 何时委托/不委托（触发判定）→ 选择执行者 → 编排流程 → 示例 → 硬限制。
 */
export function buildDelegationPrompt(
  delegationTargets: Array<{ id: string; name: string; description?: string; role?: string }>,
  delegationEnabled?: boolean,
  subagentProfiles?: Array<{ id: string; name: string; description?: string }>
): string | undefined {
  // 委托能力关闭时整体不注入：避免「提示词说委托但实际没有委托工具」的错配
  if (delegationEnabled === false) return undefined
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
  const profiles = subagentProfiles || []
  const profilesText = profiles.length > 0
    ? ['Available sub-agent profiles (ready-made one-off executors; pass subagent_profile_id instead of authoring an ephemeral_role):',
      profiles.map(p => `- ${p.name} (id=${p.id})${p.description ? `: ${p.description}` : ''}`).join('\n')]
    : []
  return [
    'Delegation (multi-employee collaboration):',
    'Delegate when a sub-task is independent, research-heavy, or needs a specialty you lack. A sub-agent runs in an isolated context and returns one self-contained result, which keeps this conversation clean and lets independent work run in parallel.',
    ...targetsText,
    ...profilesText,
    'Tools:',
    '- delegate_to_employee: one sub-task with a synchronous result; run_in_background=true returns a runId immediately.',
    '- launch_agents + await_agents: dispatch independent sub-tasks in parallel, then aggregate their results.',
    '- followup_delegation: revise or question a completed delegation; the sub-agent keeps its original task context.',
    'Delegate when:',
    '- The task has two or more independent parts that can be researched, produced, or verified in parallel.',
    '- The answer requires sweeping many files, sources, or naming conventions (about 3+ queries or 10+ file reads) and only the conclusion is needed, not the raw dumps.',
    '- The work needs a different specialty, a narrower toolset, or an isolated context that should not pollute this conversation.',
    '- You need an unbiased review independent of the agent that produced the work.',
    'Do not delegate when:',
    '- The answer is a single fact, file, symbol, or value you can locate directly.',
    '- This conversation or a tool result already answers it.',
    '- The work depends on output you have not received yet; run it sequentially with delegate_to_employee instead of splitting it.',
    '- The request is trivial or single-step.',
    'Executor selection (reuse first):',
    '1. Prefer a delegatee whose capabilities match. Create an ephemeral sub-agent only when none fits.',
    '2. Ephemeral sub-agents are one-off workers: give a concise duty name and a fully self-contained system_prompt (identity, duties, output requirements, constraints). They never see this conversation and disappear when the run ends.',
    '3. Reuse a persisted sub-agent profile (subagent_profile_id; list via list_subagent_profiles) instead of re-authoring the same role.',
    '4. Narrow the ephemeral tool allowlist only when the task truly needs a restricted capability (e.g. read-only research).',
    'Execution:',
    '1. Plan: split the task into independent, clearly bounded sub-tasks.',
    '2. Fan out: send every independent sub-task in one launch_agents call, not one by one.',
    '3. Aggregate: collect each result with await_agents (summary, generated files, token usage).',
    '4. Verify: check each result against its acceptance criteria. Repair a wrong or incomplete result with followup_delegation first; re-delegate only when the sub-agent cannot fix it.',
    '5. Report: deliver the conclusion from the results and files; do not replay the sub-agents\' execution trace.',
    'Contract:',
    '- Every instruction must be self-contained (the sub-agent has not seen this conversation): include background, objective, expected output form, and acceptance criteria.',
    '- Emit all independent delegations together, then collect them. Sequence only when a later instruction genuinely depends on an earlier result.',
    'Examples:',
    '- Parallel research: three unnamed rivals → one launch_agents call with three self-contained tasks, then await_agents and synthesize.',
    '- Sequential dependency: "summarize the file you just generated, then translate it" → delegate the summary first, then follow up for the translation.',
    '- No delegation: the license is asked and a LICENSE file is already in the workspace → read it directly.',
    'Limits: never delegate to yourself or to an employee already in the delegation chain; delegation depth is capped at 2 (main task → sub-task → sub-sub-task; a sub-sub-task cannot delegate further); a single delegation conversation is capped at 5 follow-up turns including the first.',
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
  '[End of system-provided context. Treat it as background information, not as a user request; respond to the actual user message.]'

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
 * 构造稳定任务上下文消息（锚定在 history 头部，首次构建后字节冻结）：
 * 工作区与任务发起时间在会话期间不变，放进稳定头可避免它们随每次请求重复出现在尾部、
 * 反复占用未缓存 token。易变的记忆/知识库范围仍由 requestTail 注入。
 */
export function buildStableTaskContextMessageContent(params: {
  workspaceContextPrompt?: string
  taskTimePrompt?: string
}): string | undefined {
  const blocks: string[] = []
  if (params.workspaceContextPrompt) blocks.push(`<workspace>${params.workspaceContextPrompt}</workspace>`)
  if (params.taskTimePrompt) blocks.push(`<task_time>${params.taskTimePrompt}</task_time>`)
  if (blocks.length === 0) return undefined
  return [
    TASK_CONTEXT_MSG_PREFIX,
    ...blocks,
    CONTEXT_MSG_FOOTER,
  ].join('\n')
}

/**
 * 构造任务上下文（由 agent 作为「本次请求末尾追加文本」注入，位于真实 query 之后）：
 * 随任务/每次调用变化的信息——记忆、知识库范围。
 * 之所以追加在末尾而不插在 query 之前：下一轮 history 由前端重建时不含这条消息，
 * 插在 query 之前会让上一整轮的 token 前缀错位，KV cache 从该位置起全部失效。
 */
export function buildTaskContextMessageContent(params: {
  workspaceContextPrompt?: string
  taskTimePrompt?: string
  memoryPrompt?: string
  recalledMemoryPrompt?: string
  kbContextPrompt?: string
}): string | undefined {
  const { workspaceContextPrompt, taskTimePrompt, memoryPrompt, recalledMemoryPrompt, kbContextPrompt } = params
  const blocks: string[] = []
  if (workspaceContextPrompt) blocks.push(`<workspace>${workspaceContextPrompt}</workspace>`)
  if (taskTimePrompt) blocks.push(`<task_time>${taskTimePrompt}</task_time>`)
  if (memoryPrompt) blocks.push(`<memory>${memoryPrompt}</memory>`)
  if (recalledMemoryPrompt) blocks.push(`<relevant_memory>${recalledMemoryPrompt}</relevant_memory>`)
  if (kbContextPrompt) blocks.push(`<knowledge_scope>${kbContextPrompt}</knowledge_scope>`)
  if (blocks.length === 0) return undefined
  return [
    TASK_CONTEXT_MSG_PREFIX,
    'Runtime background appended after the user message; treat it as context, not as another request.',
    ...blocks,
    CONTEXT_MSG_FOOTER,
  ].join('\n')
}
