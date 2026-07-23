import type { ToolDefinition } from './types'
import CalendarService from '../../calendar/calendar.service'
import { interactionContext } from '../../unified-interaction.service'
import type {
  CalendarEvent,
  CalendarTodo,
  CalendarTodoStats,
  CreateEventInput,
  UpdateEventInput,
  CreateTodoInput,
  UpdateTodoInput,
  EventColor,
  TodoPriority,
  TodoStatus,
  RecurrenceRule,
} from '../../../../shared/ipc-channels'

/**
 * 日历工具（合并精炼为 2 个）：
 * - calendar_event：日程 CRUD（list / create / update / delete）
 * - calendar_todo：TODO CRUD + 完成 + 统计（list / create / update / delete / complete / stats）
 *
 * 设计要点：
 * - 用 operation 字段分发，避免工具数量爆炸
 * - 时间支持两种传参：unix 秒（start_at 等 number）或日期时间字符串（start_time 等 string）
 *   字符串示例："2026-07-24 15:00"、"2026-07-24"、"2026/07/24 15:30:00"
 *   优先使用 number；提供 string 时由 parseNaturalTime 服务端解析，LLM 无需再调用 date_time/calculator
 * - 创建 / 修改后由 handlers 广播 CALENDAR_DATA_CHANGED 事件，前端实时刷新
 * - agent 创建的记录 source = 'agent'，便于区分
 */

function getEmployeeId(): string | null {
  const ctx = interactionContext.getStore()
  return ctx?.employeeId ?? null
}

function parseRecurrenceRule(rule: any): RecurrenceRule | null {
  if (!rule || typeof rule !== 'object') return null
  const freq = rule.freq
  const validFreqs = ['daily', 'weekdays', 'weekly', 'monthly', 'yearly']
  if (!validFreqs.includes(freq)) return null
  const interval = Math.max(1, Math.floor(Number(rule.interval) || 1))
  const result: RecurrenceRule = { freq, interval } as RecurrenceRule
  if (typeof rule.count === 'number') result.count = Math.max(1, Math.floor(rule.count))
  if (typeof rule.until === 'number') result.until = Math.floor(rule.until)
  return result
}

// ====== 日期时间字符串解析 ======

/**
 * 将时间字符串解析为 unix 秒。支持：
 * - unix 秒/毫秒数字串
 * - ISO / 常见日期格式：2026-07-24、2026-07-24 15:00、2026/07/24 15:30:00、2026-07-24T15:00:00
 * 解析失败返回 null。
 */
export function parseNaturalTime(input: any): number | null {
  if (input == null) return null
  if (typeof input === 'number' && !isNaN(input)) return Math.floor(input)
  const raw = String(input).trim()
  if (!raw) return null

  // unix 秒 / 毫秒
  if (/^\d{10}$/.test(raw)) return parseInt(raw, 10)
  if (/^\d{13}$/.test(raw)) return Math.floor(parseInt(raw, 10) / 1000)

  // 绝对日期（仅日期）—— 本地时区 00:00，避免 ISO date-only 被当作 UTC
  const dateOnly = raw.match(/^(\d{4})[\/\-.](\d{1,2})[\/\-.](\d{1,2})$/)
  if (dateOnly) {
    const d = new Date(parseInt(dateOnly[1]), parseInt(dateOnly[2]) - 1, parseInt(dateOnly[3]))
    return Math.floor(d.getTime() / 1000)
  }
  // 绝对日期时间 —— 本地时区
  const dateTime = raw.match(/^(\d{4})[\/\-.](\d{1,2})[\/\-.](\d{1,2})[ T](\d{1,2})[:：](\d{1,2})(?:[:：](\d{1,2}))?/)
  if (dateTime) {
    const d = new Date(
      parseInt(dateTime[1]),
      parseInt(dateTime[2]) - 1,
      parseInt(dateTime[3]),
      parseInt(dateTime[4]),
      parseInt(dateTime[5]),
      dateTime[6] ? parseInt(dateTime[6]) : 0
    )
    return Math.floor(d.getTime() / 1000)
  }

  // 兜底：交给 Date 解析
  const fallback = new Date(raw)
  if (!isNaN(fallback.getTime())) {
    return Math.floor(fallback.getTime() / 1000)
  }
  return null
}

/** 优先用 number，否则解析 string。两者都缺失返回 undefined */
function resolveTime(numVal: any, strVal: any): number | undefined {
  if (numVal !== undefined && numVal !== null && !isNaN(Number(numVal))) return Number(numVal)
  if (strVal !== undefined && strVal !== null && String(strVal).trim() !== '') {
    const parsed = parseNaturalTime(strVal)
    if (parsed !== null) return parsed
  }
  return undefined
}

function formatEvent(e: CalendarEvent): string {
  const start = new Date(e.start_at * 1000).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
  const end = new Date(e.end_at * 1000).toLocaleString('zh-CN', { hour: '2-digit', minute: '2-digit' })
  const repeat = e.recurrence_rule ? ` 重复:${e.recurrence_rule.freq}` : ''
  return `• ${e.title} | ${start}-${end}${e.all_day ? '(全天)' : ''}${e.location ? ` @${e.location}` : ''}${repeat} [id=${e.id}]`
}

function formatTodo(t: CalendarTodo): string {
  const due = t.due_at ? new Date(t.due_at * 1000).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }) : '无截止'
  const tags = t.tags.length > 0 ? ` #${t.tags.join(' #')}` : ''
  return `• [${t.status === 'completed' ? 'x' : ' '}] ${t.title} | 截止:${due} | 优先级:${t.priority}${tags} [id=${t.id}]`
}

const TIME_HINT = '时间支持两种传参：unix 秒（start_at 等 number）或日期时间字符串（start_time 等 string，如 "2026-07-24 15:00"、"2026-07-24"、"2026/07/24 15:30:00"）。提供字符串时由服务端解析，无需调用 date_time/calculator。'

// ====== calendar_event 工具 ======

const calendarEventTool: ToolDefinition = {
  id: 'calendar_event',
  name: 'calendar_event',
  title: '日程管理',
  description: `管理用户的日历日程事件。支持 list / create / update / delete 四种操作。
- list：列出指定时间区间内的日程（返回展开后的实例，包含重复日程）。需要 range_start/range_end 或 range_start_time/range_end_time。
- create：创建日程。需要 title、start_at 或 start_time；可选 end_at/end_time、all_day、location、description、color、recurrence_rule、reminders。
- update：修改日程。需要 id；其它字段可选。
- delete：删除日程。需要 id。

recurrence_rule 格式：{"freq":"daily|weekdays|weekly|monthly|yearly","interval":数字,"count":可选,"until":可选unix秒}
reminders：分钟偏移数组，如 [0,-10,-60] 表示事件开始时、前10分钟、前60分钟各提醒一次。
color：default / blue / green / orange / red / purple。

${TIME_HINT}`,
  parameters: {
    type: 'object',
    properties: {
      operation: {
        type: 'string',
        enum: ['list', 'create', 'update', 'delete'],
        description: '操作类型',
      },
      id: { type: 'string', description: '日程ID（update/delete 必填）' },
      title: { type: 'string', description: '日程主题（create 必填）' },
      description: { type: 'string', description: '日程描述' },
      location: { type: 'string', description: '地点' },
      start_at: { type: 'number', description: '开始时间 unix 秒' },
      start_time: { type: 'string', description: '开始时间日期字符串（与 start_at 二选一，如 "2026-07-24 15:00"）' },
      end_at: { type: 'number', description: '结束时间 unix 秒（默认为开始时间+1小时）' },
      end_time: { type: 'string', description: '结束时间日期字符串（与 end_at 二选一）' },
      all_day: { type: 'boolean', description: '是否全天事件' },
      color: {
        type: 'string',
        enum: ['default', 'blue', 'green', 'orange', 'red', 'purple'],
        description: '颜色标签',
      },
      recurrence_rule: {
        type: 'object',
        description: '重复规则',
        properties: {
          freq: { type: 'string', enum: ['daily', 'weekdays', 'weekly', 'monthly', 'yearly'] },
          interval: { type: 'number', minimum: 1 },
          count: { type: 'number', minimum: 1 },
          until: { type: 'number' },
        },
      },
      reminders: {
        type: 'array',
        items: { type: 'number' },
        description: '提醒分钟偏移数组（负数表示提前，0表示开始时）',
      },
      range_start: { type: 'number', description: 'list 操作的区间起点 unix 秒' },
      range_start_time: { type: 'string', description: 'list 区间起点日期字符串（与 range_start 二选一）' },
      range_end: { type: 'number', description: 'list 操作的区间终点 unix 秒' },
      range_end_time: { type: 'string', description: 'list 区间终点日期字符串（与 range_end 二选一）' },
    },
    required: ['operation'],
  },
  handler: async (args: any) => {
    try {
      const service = CalendarService.getInstance()
      const op = String(args.operation || '')

      switch (op) {
        case 'list': {
          const startAt = resolveTime(args.range_start ?? args.start_at, args.range_start_time ?? args.start_time)
          const endAt = resolveTime(args.range_end ?? args.end_at, args.range_end_time ?? args.end_time)
          if (!startAt || !endAt) {
            return { success: false, error: 'list 操作需要 range_start/range_end（或对应的 _time 日期字符串）' }
          }
          const instances = service.listEvents({ start_at: startAt, end_at: endAt })
          if (instances.length === 0) {
            return { success: true, output: '该时间区间内无日程。', events: [] }
          }
          return {
            success: true,
            output: `找到 ${instances.length} 个日程：\n${instances.map(formatEvent).join('\n')}`,
            events: instances,
          }
        }
        case 'create': {
          if (!args.title) return { success: false, error: 'create 操作需要 title' }
          const startAt = resolveTime(args.start_at, args.start_time)
          if (!startAt) return { success: false, error: 'create 操作需要 start_at 或 start_time' }
          const endAt = resolveTime(args.end_at, args.end_time)
          const input: CreateEventInput = {
            title: String(args.title),
            description: args.description ? String(args.description) : undefined,
            location: args.location ? String(args.location) : undefined,
            start_at: startAt,
            end_at: endAt,
            all_day: args.all_day === true,
            color: args.color as EventColor | undefined,
            recurrence_rule: parseRecurrenceRule(args.recurrence_rule),
            reminders: Array.isArray(args.reminders) ? args.reminders.map(Number) : undefined,
            employee_id: getEmployeeId(),
            source: 'agent',
          }
          const event = service.createEvent(input)
          return {
            success: true,
            output: `已创建日程：${formatEvent(event)}`,
            event,
          }
        }
        case 'update': {
          if (!args.id) return { success: false, error: 'update 操作需要 id' }
          const startAt = resolveTime(args.start_at, args.start_time)
          const endAt = resolveTime(args.end_at, args.end_time)
          const input: UpdateEventInput = {
            id: String(args.id),
            title: args.title !== undefined ? String(args.title) : undefined,
            description: args.description !== undefined ? String(args.description) : undefined,
            location: args.location !== undefined ? String(args.location) : undefined,
            start_at: startAt,
            end_at: endAt,
            all_day: args.all_day !== undefined ? args.all_day === true : undefined,
            color: args.color as EventColor | undefined,
            recurrence_rule: args.recurrence_rule !== undefined ? parseRecurrenceRule(args.recurrence_rule) : undefined,
            reminders: Array.isArray(args.reminders) ? args.reminders.map(Number) : undefined,
          }
          const event = service.updateEvent(input)
          if (!event) return { success: false, error: '日程不存在' }
          return {
            success: true,
            output: `已更新日程：${formatEvent(event)}`,
            event,
          }
        }
        case 'delete': {
          if (!args.id) return { success: false, error: 'delete 操作需要 id' }
          const ok = service.deleteEvent(String(args.id))
          if (!ok) return { success: false, error: '日程不存在或已删除' }
          return { success: true, output: `已删除日程 id=${args.id}` }
        }
        default:
          return { success: false, error: `不支持的操作: ${op}` }
      }
    } catch (err: any) {
      return { success: false, error: `日程操作失败: ${err.message || err}` }
    }
  },
  source: 'builtin',
  permission: 'safe',
}

// ====== calendar_todo 工具 ======

const calendarTodoTool: ToolDefinition = {
  id: 'calendar_todo',
  name: 'calendar_todo',
  title: '待办管理',
  description: `管理用户的 TODO 待办任务。支持 list / create / update / delete / complete / stats 六种操作。
- list：列出 TODO。可选筛选 filter_status / filter_priority / filter_tag / overdue_only / due_today / limit。
- create：创建 TODO。需要 title；可选 due_at/due_time、priority、status、tags、description、recurrence_rule、reminders。
- update：修改 TODO。需要 id；其它字段可选。
- delete：删除 TODO。需要 id。
- complete：标记完成 / 取消完成。需要 id、completed(bool)。
- stats：返回 TODO 总览统计（总数 / 待办 / 进行中 / 已完成 / 已逾期 / 今日到期 / 本周到期 / 完成率）。

priority：none / low / medium / high
status：pending / in_progress / completed
recurrence_rule、reminders 格式同 calendar_event 工具。
${TIME_HINT}`,
  parameters: {
    type: 'object',
    properties: {
      operation: {
        type: 'string',
        enum: ['list', 'create', 'update', 'delete', 'complete', 'stats'],
        description: '操作类型',
      },
      id: { type: 'string', description: 'TODO ID（update/delete/complete 必填）' },
      title: { type: 'string', description: 'TODO 标题（create 必填）' },
      description: { type: 'string', description: '详细描述' },
      due_at: { type: 'number', description: '截止时间 unix 秒' },
      due_time: { type: 'string', description: '截止时间日期字符串（与 due_at 二选一，如 "2026-07-24 18:00"）' },
      priority: {
        type: 'string',
        enum: ['none', 'low', 'medium', 'high'],
        description: '优先级',
      },
      status: {
        type: 'string',
        enum: ['pending', 'in_progress', 'completed'],
        description: '状态',
      },
      tags: {
        type: 'array',
        items: { type: 'string' },
        description: '标签列表',
      },
      recurrence_rule: {
        type: 'object',
        description: '重复规则',
        properties: {
          freq: { type: 'string', enum: ['daily', 'weekdays', 'weekly', 'monthly', 'yearly'] },
          interval: { type: 'number', minimum: 1 },
          count: { type: 'number', minimum: 1 },
          until: { type: 'number' },
        },
      },
      reminders: {
        type: 'array',
        items: { type: 'number' },
        description: '提醒分钟偏移数组（负数表示提前）',
      },
      filter_status: {
        type: 'string',
        enum: ['pending', 'in_progress', 'completed'],
        description: 'list 时按状态筛选',
      },
      filter_priority: {
        type: 'string',
        enum: ['none', 'low', 'medium', 'high'],
        description: 'list 时按优先级筛选',
      },
      filter_tag: { type: 'string', description: 'list 时按标签筛选' },
      overdue_only: { type: 'boolean', description: 'list 时仅返回已逾期' },
      due_today: { type: 'boolean', description: 'list 时仅返回今日到期' },
      limit: { type: 'number', description: 'list 返回条数上限' },
      completed: { type: 'boolean', description: 'complete 操作是否标记为完成' },
    },
    required: ['operation'],
  },
  handler: async (args: any) => {
    try {
      const service = CalendarService.getInstance()
      const op = String(args.operation || '')

      switch (op) {
        case 'list': {
          const todos = service.listTodos({
            status: args.filter_status as TodoStatus | undefined,
            priority: args.filter_priority as TodoPriority | undefined,
            tag: args.filter_tag ? String(args.filter_tag) : undefined,
            overdue_only: args.overdue_only === true,
            due_today: args.due_today === true,
            limit: args.limit ? Number(args.limit) : undefined,
          })
          if (todos.length === 0) {
            return { success: true, output: '未找到匹配的 TODO。', todos: [] }
          }
          return {
            success: true,
            output: `找到 ${todos.length} 个 TODO：\n${todos.map(formatTodo).join('\n')}`,
            todos,
          }
        }
        case 'create': {
          if (!args.title) return { success: false, error: 'create 操作需要 title' }
          const dueAt = resolveTime(args.due_at, args.due_time)
          const input: CreateTodoInput = {
            title: String(args.title),
            description: args.description ? String(args.description) : undefined,
            due_at: dueAt !== undefined ? dueAt : null,
            priority: args.priority as TodoPriority | undefined,
            status: args.status as TodoStatus | undefined,
            tags: Array.isArray(args.tags) ? args.tags.map(String) : undefined,
            recurrence_rule: parseRecurrenceRule(args.recurrence_rule),
            reminders: Array.isArray(args.reminders) ? args.reminders.map(Number) : undefined,
            employee_id: getEmployeeId(),
            source: 'agent',
          }
          const todo = service.createTodo(input)
          return {
            success: true,
            output: `已创建 TODO：${formatTodo(todo)}`,
            todo,
          }
        }
        case 'update': {
          if (!args.id) return { success: false, error: 'update 操作需要 id' }
          const dueAt = resolveTime(args.due_at, args.due_time)
          const input: UpdateTodoInput = {
            id: String(args.id),
            title: args.title !== undefined ? String(args.title) : undefined,
            description: args.description !== undefined ? String(args.description) : undefined,
            due_at: dueAt,
            priority: args.priority as TodoPriority | undefined,
            status: args.status as TodoStatus | undefined,
            tags: Array.isArray(args.tags) ? args.tags.map(String) : undefined,
            recurrence_rule: args.recurrence_rule !== undefined ? parseRecurrenceRule(args.recurrence_rule) : undefined,
            reminders: Array.isArray(args.reminders) ? args.reminders.map(Number) : undefined,
          }
          const todo = service.updateTodo(input)
          if (!todo) return { success: false, error: 'TODO 不存在' }
          return {
            success: true,
            output: `已更新 TODO：${formatTodo(todo)}`,
            todo,
          }
        }
        case 'delete': {
          if (!args.id) return { success: false, error: 'delete 操作需要 id' }
          const ok = service.deleteTodo(String(args.id))
          if (!ok) return { success: false, error: 'TODO 不存在或已删除' }
          return { success: true, output: `已删除 TODO id=${args.id}` }
        }
        case 'complete': {
          if (!args.id) return { success: false, error: 'complete 操作需要 id' }
          const todo = service.completeTodo(String(args.id), args.completed === true)
          if (!todo) return { success: false, error: 'TODO 不存在' }
          return {
            success: true,
            output: `已${args.completed === true ? '完成' : '取消完成'} TODO：${formatTodo(todo)}`,
            todo,
          }
        }
        case 'stats': {
          const stats: CalendarTodoStats = service.getTodoStats()
          return {
            success: true,
            output: `TODO 总览：共 ${stats.total} 条 | 待办 ${stats.pending} | 进行中 ${stats.in_progress} | 已完成 ${stats.completed} | 已逾期 ${stats.overdue} | 今日到期 ${stats.due_today} | 本周到期 ${stats.due_this_week} | 完成率 ${stats.completion_rate}%`,
            stats,
          }
        }
        default:
          return { success: false, error: `不支持的操作: ${op}` }
      }
    } catch (err: any) {
      return { success: false, error: `TODO 操作失败: ${err.message || err}` }
    }
  },
  source: 'builtin',
  permission: 'safe',
}

export const calendarTools: ToolDefinition[] = [calendarEventTool, calendarTodoTool]
