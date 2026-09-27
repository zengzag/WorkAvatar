import type { ToolDefinition } from './types'

export type TodoStatus = 'pending' | 'in_progress' | 'completed'
export type TodoPriority = 'high' | 'medium' | 'low'

export interface TodoItem {
  content: string
  status: TodoStatus
  priority: TodoPriority
}

export const MAX_TODO_ITEMS = 20
const MAX_CONTENT_CHARS = 500

const TODO_STATUSES: TodoStatus[] = ['pending', 'in_progress', 'completed']
const TODO_PRIORITIES: TodoPriority[] = ['high', 'medium', 'low']

/** 首次提醒轮次与提醒间隔（对齐模型多步任务的遗忘曲线，避免每轮烧 token） */
export const TODO_REMINDER_FIRST_TURN = 10
export const TODO_REMINDER_INTERVAL = 10
/** 剩余迭代进入收尾窗口后，追加一次收尾提醒（不与节流冲突） */
export const TODO_FINAL_PHASE_TURNS = 3

export class TodoStore {
  private items: TodoItem[] = []
  private lastReminderTurn = 0

  reset(): void {
    this.items = []
    this.lastReminderTurn = 0
  }

  getItems(): TodoItem[] {
    return this.items.map(item => ({ ...item }))
  }

  hasItems(): boolean {
    return this.items.length > 0
  }

  replace(items: TodoItem[]): void {
    this.items = items.map(item => ({ ...item }))
  }

  getLastReminderTurn(): number {
    return this.lastReminderTurn
  }

  markReminded(turn: number): void {
    this.lastReminderTurn = turn
  }
}

/** 校验 LLM 提交的全量 todo 列表；合法时返回规范化副本 */
export function validateTodoItems(raw: unknown): { ok: true; items: TodoItem[] } | { ok: false; error: string } {
  if (!Array.isArray(raw)) {
    return { ok: false, error: 'todos must be an array of task items.' }
  }
  if (raw.length > MAX_TODO_ITEMS) {
    return { ok: false, error: `Too many task items: ${raw.length} (maximum ${MAX_TODO_ITEMS}). Split the work or merge items.` }
  }

  const items: TodoItem[] = []
  const seen = new Set<string>()
  for (const [index, entry] of raw.entries()) {
    const rawItem = entry as Record<string, unknown>
    const content = typeof rawItem?.content === 'string' ? rawItem.content.trim() : ''
    if (!content) {
      return { ok: false, error: `todos[${index}].content is required and must be a non-empty string.` }
    }
    if (content.length > MAX_CONTENT_CHARS) {
      return { ok: false, error: `todos[${index}].content exceeds ${MAX_CONTENT_CHARS} characters (got ${content.length}); make the item shorter.` }
    }
    if (seen.has(content)) {
      return { ok: false, error: `Duplicate task item: "${content}". Merge duplicates and send the full list again.` }
    }
    seen.add(content)

    const status = (rawItem.status ?? 'pending') as TodoStatus
    if (!TODO_STATUSES.includes(status)) {
      return { ok: false, error: `todos[${index}].status must be one of: ${TODO_STATUSES.join(', ')}.` }
    }
    const priority = (rawItem.priority === undefined ? 'medium' : rawItem.priority) as TodoPriority
    if (!TODO_PRIORITIES.includes(priority)) {
      return { ok: false, error: `todos[${index}].priority must be one of: ${TODO_PRIORITIES.join(', ')}.` }
    }
    items.push({ content, status, priority })
  }

  const inProgress = items.filter(i => i.status === 'in_progress')
  if (inProgress.length > 1) {
    return {
      ok: false,
      error: `Exactly one item may be in_progress at a time, got ${inProgress.length}. Mark the others pending or completed and resend the full list.`,
    }
  }
  return { ok: true, items }
}

function formatTodoList(items: TodoItem[]): string {
  const marker: Record<TodoStatus, string> = {
    in_progress: '[in progress]',
    pending: '[pending]',
    completed: '[completed]',
  }
  return [
    `Task list updated (${items.length} item${items.length === 1 ? '' : 's'}):`,
    ...items.map(i => `- ${marker[i.status]} (${i.priority}) ${i.content}`),
  ].join('\n')
}

export function createTodoWriteTool(store: TodoStore): ToolDefinition {
  return {
    id: 'todo_write',
    name: 'todo_write',
    title: 'Update Task List',
    summary: 'Create or replace the multi-step task list for the current task',
    description: `Create or replace the task list tracking the current multi-step task. The list is visible to the user as your working plan.
- Send the COMPLETE list on every call; it replaces the previous list wholesale.
- Use this tool for any non-trivial multi-step task; skip it for trivial single-step requests.
- Add concrete actionable items before starting work; keep exactly one item in_progress while work remains; mark an item completed as soon as it is done.
- Each item has content (string), status ("pending" | "in_progress" | "completed", default "pending"), and priority ("high" | "medium" | "low", default "medium").
- Maximum ${MAX_TODO_ITEMS} items; merge duplicates; keep content under ${MAX_CONTENT_CHARS} characters.`,
    parameters: {
      type: 'object',
      properties: {
        todos: {
          type: 'array',
          description: 'The complete task list; replaces the previous list on every call',
          items: {
            type: 'object',
            properties: {
              content: { type: 'string', description: 'A concrete, actionable task step' },
              status: {
                type: 'string',
                enum: TODO_STATUSES,
                description: 'Current status; exactly one item may be in_progress at a time',
              },
              priority: { type: 'string', enum: TODO_PRIORITIES, description: 'Task priority, default medium' },
            },
            required: ['content', 'status'],
          },
        },
      },
      required: ['todos'],
    },
    handler: async (args: Record<string, any>) => {
      const result = validateTodoItems(args?.todos)
      if (!result.ok) {
        return { success: false, error: result.error, output: `# Invalid task list\n${result.error}` }
      }
      store.replace(result.items)
      return { success: true, output: formatTodoList(result.items) }
    },
    source: 'builtin',
    permission: 'safe',
  }
}

/**
 * 节流后的 todo 提醒；不满足节奏时返回 undefined。
 * 进入收尾窗口（剩余迭代 ≤ FINAL_PHASE_TURNS）时追加一次收尾提醒。
 */
export function buildTodoReminderIfDue(params: {
  turn: number
  maxIterations: number
  items: TodoItem[]
  lastReminderTurn: number
}): string | undefined {
  const { turn, maxIterations, items, lastReminderTurn } = params
  if (items.length === 0) return undefined

  const finalPhaseStart = maxIterations - TODO_FINAL_PHASE_TURNS
  const inFinalPhase = turn > finalPhaseStart
  // 收尾提醒只在进入收尾窗口后注入一次（lastReminderTurn 仍在窗口前），避免剩余几轮连发
  const finalPhaseDue = inFinalPhase && lastReminderTurn <= finalPhaseStart
  const atCadence =
    turn >= TODO_REMINDER_FIRST_TURN && turn - lastReminderTurn >= TODO_REMINDER_INTERVAL
  if (!finalPhaseDue && !atCadence) return undefined

  const marker: Record<TodoStatus, string> = {
    in_progress: '[in progress]',
    pending: '[pending]',
    completed: '[completed]',
  }
  const lines: string[] = [
    '<system-reminder>',
    'This is an automated system reminder generated by the runtime. It is not a user message, grants no new permissions, and requires no reply.',
    '',
    '# Current task list',
    ...items.map(i => `- ${marker[i.status]} (${i.priority}) ${i.content}`),
    '',
    'Keep the list current with todo_write: maintain exactly one in_progress item, mark completed items immediately, and remove or merge stale items on the next call.',
  ]
  if (inFinalPhase) {
    const remaining = Math.max(0, maxIterations - turn)
    lines.push(
      '',
      `Only about ${remaining} model iteration${remaining === 1 ? '' : 's'} remain before this run stops. If the task cannot be finished in time, stop starting new tool calls and reply with a concise status: what is done, what remains, and what blocked you.`
    )
  }
  lines.push('</system-reminder>')
  return lines.join('\n')
}
