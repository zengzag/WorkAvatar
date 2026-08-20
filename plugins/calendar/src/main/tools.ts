/**
 * 日历 agent 工具（由宿主 calendar.tool.ts 迁移而来，10 个独立工具）。
 * 差异点：
 * - 工具类型改用 PluginToolDefinition（无 source 字段）
 * - employee_id 从 handler 的 context 注入（context.employeeId），不再读 interactionContext
 * - CalendarService 走插件单例 getCalendarService()
 */
import type { PluginToolDefinition } from '../../../plugin-sdk/src'
import { getCalendarService } from './calendar-service'
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
} from './calendar-service'

const WEEKDAY_MAP: Record<string, string> = {
  '1': 'MO', '2': 'TU', '3': 'WE', '4': 'TH', '5': 'FR', '6': 'SA', '0': 'SU',
  mo: 'MO', tu: 'TU', we: 'WE', th: 'TH', fr: 'FR', sa: 'SA', su: 'SU',
  monday: 'MO', tuesday: 'TU', wednesday: 'WE', thursday: 'TH', friday: 'FR', saturday: 'SA', sunday: 'SU',
}

function parseRecurrenceRule(rule: any): RecurrenceRule | null {
  if (!rule || typeof rule !== 'object') return null
  let freq = rule.freq
  // 兼容旧版 'weekdays' → weekly + byday(工作日)
  if (freq === 'weekdays') freq = 'weekly'
  const validFreqs = ['daily', 'weekly', 'monthly', 'yearly']
  if (!validFreqs.includes(freq)) return null
  const interval = Math.max(1, Math.floor(Number(rule.interval) || 1))
  const result: RecurrenceRule = { freq, interval } as RecurrenceRule
  if (typeof rule.count === 'number') result.count = Math.max(1, Math.floor(rule.count))
  if (typeof rule.until === 'number') result.until = Math.floor(rule.until)
  // 兼容旧版 'weekdays' 自动补充工作日 byday
  if (rule.freq === 'weekdays') result.byday = ['MO', 'TU', 'WE', 'TH', 'FR']
  if (Array.isArray(rule.byday)) {
    const days = rule.byday.map((d: any) => WEEKDAY_MAP[String(d).toLowerCase()] ?? (typeof d === 'string' ? d.toUpperCase() : null)).filter(Boolean)
    if (days.length > 0) result.byday = days
  }
  if (Array.isArray(rule.bymonthday)) {
    const days = rule.bymonthday.map((d: any) => Number(d)).filter((d: number) => d >= 1 && d <= 31)
    if (days.length > 0) result.bymonthday = days
  }
  if (Array.isArray(rule.bymonth)) {
    const months = rule.bymonth.map((m: any) => Number(m)).filter((m: number) => m >= 1 && m <= 12)
    if (months.length > 0) result.bymonth = months
  }
  if (typeof rule.bysetpos === 'number') result.bysetpos = Math.floor(rule.bysetpos)
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

/** 解析时间参数（接受 Unix 秒或日期字符串），缺失返回 undefined */
function resolveTime(val: any): number | undefined {
  if (val === undefined || val === null) return undefined
  const parsed = parseNaturalTime(val)
  return parsed !== null ? parsed : undefined
}

function formatEvent(e: CalendarEvent): string {
  const start = new Date(e.start_at * 1000).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
  const end = new Date(e.end_at * 1000).toLocaleString('zh-CN', { hour: '2-digit', minute: '2-digit' })
  const repeat = e.recurrence_rule ? ` 重复:${e.recurrence_rule.freq}` : ''
  return `• ${e.title} | ${start}-${end}${e.all_day ? '(全天)' : ''}${repeat} [id=${e.id}]`
}

function formatTodo(t: CalendarTodo): string {
  const due = t.due_at ? new Date(t.due_at * 1000).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }) : '无截止'
  return `• [${t.status === 'completed' ? 'x' : ' '}] ${t.title} | 截止:${due} | 优先级:${t.priority} [id=${t.id}]`
}

const TIME_HINT = '时间参数接受 Unix 秒（number）或日期字符串（string，如 "2026-07-24 15:00"、"2026-07-24"、"2026/07/24 15:30:00"），由服务端解析，无需调用 date_time/calculator。'

// ==================== 日程工具 ====================

const calendarEventListTool: PluginToolDefinition = {
  id: 'calendar_event_list',
  name: 'calendar_event_list',
  title: '列出日程',
  summary: '列出指定时间区间内的日程（含重复展开）。查看某段时间的日程时使用。',
  description: `列出指定时间区间内的日历日程（返回展开后的实例，包含重复日程）。
- 需要 range_start_time / range_end_time 指定查询区间。
${TIME_HINT}`,
  parameters: {
    type: 'object',
    properties: {
      range_start_time: { type: 'string', description: '查询区间起点，接受 Unix 秒或日期字符串' },
      range_end_time: { type: 'string', description: '查询区间终点，接受 Unix 秒或日期字符串' },
    },
    required: ['range_start_time', 'range_end_time'],
  },
  handler: async (args: any) => {
    try {
      const startAt = resolveTime(args.range_start_time)
      const endAt = resolveTime(args.range_end_time)
      if (!startAt || !endAt) {
        return { success: false, error: '需要 range_start_time/range_end_time' }
      }
      const instances = getCalendarService().listEvents({ start_at: startAt, end_at: endAt })
      if (instances.length === 0) {
        return { success: true, output: '该时间区间内无日程。', events: [] }
      }
      return {
        success: true,
        output: `找到 ${instances.length} 个日程：\n${instances.map(formatEvent).join('\n')}`,
        events: instances,
      }
    } catch (err: any) {
      return { success: false, error: `日程查询失败: ${err.message || err}` }
    }
  },
  onDemand: true,
  permission: 'safe',
}

const calendarEventCreateTool: PluginToolDefinition = {
  id: 'calendar_event_create',
  name: 'calendar_event_create',
  title: '创建日程',
  summary: '创建新的日历日程事件。新建日程时使用，支持重复规则与提醒。',
  description: `创建一个新的日历日程事件。
- 必填：title、start_time
- 可选：end_time（默认为开始时间+1小时）、all_day、description、color、recurrence_rule、reminders

recurrence_rule 格式：{"freq":"daily|weekly|monthly|yearly","interval":数字,"count":可选,"until":可选unix秒,"byday":["MO","TU",...],"bymonthday":[15,...],"bymonth":[1,...],"bysetpos":-1}
- byday：SU/MO/TU/WE/TH/FR/SA，工作日可设 ["MO","TU","WE","TH","FR"]
reminders：分钟偏移数组，如 [0,-10,-60] 表示事件开始时、前10分钟、前60分钟各提醒一次。
color：default / blue / green / orange / red / purple。
${TIME_HINT}`,
  parameters: {
    type: 'object',
    properties: {
      title: { type: 'string', description: '日程主题' },
      description: { type: 'string', description: '日程描述' },
      start_time: { type: 'string', description: '开始时间，接受 Unix 秒或日期字符串（如 "2026-07-24 15:00"）' },
      end_time: { type: 'string', description: '结束时间，接受 Unix 秒或日期字符串（默认为开始时间+1小时）' },
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
          freq: { type: 'string', enum: ['daily', 'weekly', 'monthly', 'yearly'] },
          interval: { type: 'number', minimum: 1 },
          count: { type: 'number', minimum: 1 },
          until: { type: 'number' },
          byday: { type: 'array', items: { type: 'string', enum: ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'] }, description: '每周几，如 ["MO","TU","WE","TH","FR"] 表示工作日' },
          bymonthday: { type: 'array', items: { type: 'number', minimum: 1, maximum: 31 }, description: '月中的日期，如 [15] 表示每月15日' },
          bymonth: { type: 'array', items: { type: 'number', minimum: 1, maximum: 12 }, description: '月份，如 [1] 表示一月' },
          bysetpos: { type: 'number', description: '在周期内的位置，如 -1 表示最后一个' },
        },
      },
      reminders: {
        type: 'array',
        items: { type: 'number' },
        description: '提醒分钟偏移数组（负数表示提前，0表示开始时）',
      },
    },
    required: ['title', 'start_time'],
  },
  handler: async (args: any, context: any) => {
    try {
      const employeeId = context?.employeeId ?? null
      if (!args.title) return { success: false, error: '需要 title' }
      const startAt = resolveTime(args.start_time)
      if (!startAt) return { success: false, error: '需要 start_time' }
      const endAt = resolveTime(args.end_time)
      const input: CreateEventInput = {
        title: String(args.title),
        description: args.description ? String(args.description) : undefined,
        start_at: startAt,
        end_at: endAt,
        all_day: args.all_day === true,
        color: args.color as EventColor | undefined,
        recurrence_rule: parseRecurrenceRule(args.recurrence_rule),
        reminders: Array.isArray(args.reminders) ? args.reminders.map(Number) : undefined,
        employee_id: employeeId,
        source: 'agent',
      }
      const event = getCalendarService().createEvent(input)
      return {
        success: true,
        output: `已创建日程：${formatEvent(event)}`,
        event,
      }
    } catch (err: any) {
      return { success: false, error: `日程创建失败: ${err.message || err}` }
    }
  },
  onDemand: true,
  permission: 'safe',
}

const calendarEventUpdateTool: PluginToolDefinition = {
  id: 'calendar_event_update',
  name: 'calendar_event_update',
  title: '修改日程',
  summary: '修改已存在的日程。更新日程信息时使用，仅传需修改字段。',
  description: `修改已存在的日历日程。需要 id，其它字段可选（仅传需要修改的字段）。

recurrence_rule、reminders、color 格式同 calendar_event_create。
${TIME_HINT}`,
  parameters: {
    type: 'object',
    properties: {
      id: { type: 'string', description: '日程ID（必填）' },
      title: { type: 'string', description: '日程主题' },
      description: { type: 'string', description: '日程描述' },
      start_time: { type: 'string', description: '开始时间，接受 Unix 秒或日期字符串' },
      end_time: { type: 'string', description: '结束时间，接受 Unix 秒或日期字符串' },
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
          freq: { type: 'string', enum: ['daily', 'weekly', 'monthly', 'yearly'] },
          interval: { type: 'number', minimum: 1 },
          count: { type: 'number', minimum: 1 },
          until: { type: 'number' },
          byday: { type: 'array', items: { type: 'string', enum: ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'] }, description: '每周几，如 ["MO","TU","WE","TH","FR"] 表示工作日' },
          bymonthday: { type: 'array', items: { type: 'number', minimum: 1, maximum: 31 }, description: '月中的日期，如 [15] 表示每月15日' },
          bymonth: { type: 'array', items: { type: 'number', minimum: 1, maximum: 12 }, description: '月份，如 [1] 表示一月' },
          bysetpos: { type: 'number', description: '在周期内的位置，如 -1 表示最后一个' },
        },
      },
      reminders: {
        type: 'array',
        items: { type: 'number' },
        description: '提醒分钟偏移数组（负数表示提前，0表示开始时）',
      },
    },
    required: ['id'],
  },
  handler: async (args: any) => {
    try {
      if (!args.id) return { success: false, error: '需要 id' }
      const startAt = resolveTime(args.start_time)
      const endAt = resolveTime(args.end_time)
      const input: UpdateEventInput = {
        id: String(args.id),
        title: args.title !== undefined ? String(args.title) : undefined,
        description: args.description !== undefined ? String(args.description) : undefined,
        start_at: startAt,
        end_at: endAt,
        all_day: args.all_day !== undefined ? args.all_day === true : undefined,
        color: args.color as EventColor | undefined,
        recurrence_rule: args.recurrence_rule !== undefined ? parseRecurrenceRule(args.recurrence_rule) : undefined,
        reminders: Array.isArray(args.reminders) ? args.reminders.map(Number) : undefined,
      }
      const event = getCalendarService().updateEvent(input)
      if (!event) return { success: false, error: '日程不存在' }
      return {
        success: true,
        output: `已更新日程：${formatEvent(event)}`,
        event,
      }
    } catch (err: any) {
      return { success: false, error: `日程修改失败: ${err.message || err}` }
    }
  },
  onDemand: true,
  permission: 'safe',
}

const calendarEventDeleteTool: PluginToolDefinition = {
  id: 'calendar_event_delete',
  name: 'calendar_event_delete',
  title: '删除日程',
  summary: '删除日历日程。删除日程时使用。',
  description: '删除已存在的日历日程。需要 id。',
  parameters: {
    type: 'object',
    properties: {
      id: { type: 'string', description: '日程ID（必填）' },
    },
    required: ['id'],
  },
  handler: async (args: any) => {
    try {
      if (!args.id) return { success: false, error: '需要 id' }
      const ok = getCalendarService().deleteEvent(String(args.id))
      if (!ok) return { success: false, error: '日程不存在或已删除' }
      return { success: true, output: `已删除日程 id=${args.id}` }
    } catch (err: any) {
      return { success: false, error: `日程删除失败: ${err.message || err}` }
    }
  },
  onDemand: true,
  permission: 'safe',
}

// ==================== 待办工具 ====================

const calendarTodoListTool: PluginToolDefinition = {
  id: 'calendar_todo_list',
  name: 'calendar_todo_list',
  title: '列出待办',
  summary: '列出/筛选 TODO 待办任务。查看待办列表时使用，支持按状态/优先级筛选。',
  description: `列出用户的 TODO 待办任务，支持筛选。
- 可选筛选：filter_status / filter_priority / overdue_only / due_today / limit
- 不传任何筛选条件时返回全部 TODO

priority：none / low / medium / high
status：pending / in_progress / completed`,
  parameters: {
    type: 'object',
    properties: {
      filter_status: {
        type: 'string',
        enum: ['pending', 'in_progress', 'completed'],
        description: '按状态筛选',
      },
      filter_priority: {
        type: 'string',
        enum: ['none', 'low', 'medium', 'high'],
        description: '按优先级筛选',
      },
      overdue_only: { type: 'boolean', description: '仅返回已逾期' },
      due_today: { type: 'boolean', description: '仅返回今日到期' },
      limit: { type: 'number', description: '返回条数上限' },
    },
  },
  handler: async (args: any) => {
    try {
      const todos = getCalendarService().listTodos({
        status: args.filter_status as TodoStatus | undefined,
        priority: args.filter_priority as TodoPriority | undefined,
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
    } catch (err: any) {
      return { success: false, error: `TODO 查询失败: ${err.message || err}` }
    }
  },
  onDemand: true,
  permission: 'safe',
}

const calendarTodoCreateTool: PluginToolDefinition = {
  id: 'calendar_todo_create',
  name: 'calendar_todo_create',
  title: '创建待办',
  summary: '创建新的 TODO 待办任务。新建待办时使用，支持优先级、重复与提醒。',
  description: `创建一个新的 TODO 待办任务。
- 必填：title
- 可选：due_time、priority、status、description、recurrence_rule、reminders

priority：none / low / medium / high
status：pending / in_progress / completed
recurrence_rule、reminders 格式同 calendar_event_create。
${TIME_HINT}`,
  parameters: {
    type: 'object',
    properties: {
      title: { type: 'string', description: 'TODO 标题' },
      description: { type: 'string', description: '详细描述' },
      due_time: { type: 'string', description: '截止时间，接受 Unix 秒或日期字符串（如 "2026-07-24 18:00"）' },
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
      recurrence_rule: {
        type: 'object',
        description: '重复规则',
        properties: {
          freq: { type: 'string', enum: ['daily', 'weekly', 'monthly', 'yearly'] },
          interval: { type: 'number', minimum: 1 },
          count: { type: 'number', minimum: 1 },
          until: { type: 'number' },
          byday: { type: 'array', items: { type: 'string', enum: ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'] }, description: '每周几，如 ["MO","TU","WE","TH","FR"] 表示工作日' },
          bymonthday: { type: 'array', items: { type: 'number', minimum: 1, maximum: 31 }, description: '月中的日期，如 [15] 表示每月15日' },
          bymonth: { type: 'array', items: { type: 'number', minimum: 1, maximum: 12 }, description: '月份，如 [1] 表示一月' },
          bysetpos: { type: 'number', description: '在周期内的位置，如 -1 表示最后一个' },
        },
      },
      reminders: {
        type: 'array',
        items: { type: 'number' },
        description: '提醒分钟偏移数组（负数表示提前）',
      },
    },
    required: ['title'],
  },
  handler: async (args: any, context: any) => {
    try {
      const employeeId = context?.employeeId ?? null
      if (!args.title) return { success: false, error: '需要 title' }
      const dueAt = resolveTime(args.due_time)
      const input: CreateTodoInput = {
        title: String(args.title),
        description: args.description ? String(args.description) : undefined,
        due_at: dueAt !== undefined ? dueAt : null,
        priority: args.priority as TodoPriority | undefined,
        status: args.status as TodoStatus | undefined,
        recurrence_rule: parseRecurrenceRule(args.recurrence_rule),
        reminders: Array.isArray(args.reminders) ? args.reminders.map(Number) : undefined,
        employee_id: employeeId,
        source: 'agent',
      }
      const todo = getCalendarService().createTodo(input)
      return {
        success: true,
        output: `已创建 TODO：${formatTodo(todo)}`,
        todo,
      }
    } catch (err: any) {
      return { success: false, error: `TODO 创建失败: ${err.message || err}` }
    }
  },
  onDemand: true,
  permission: 'safe',
}

const calendarTodoUpdateTool: PluginToolDefinition = {
  id: 'calendar_todo_update',
  name: 'calendar_todo_update',
  title: '修改待办',
  summary: '修改已存在的 TODO。更新待办信息时使用，仅传需修改字段。',
  description: `修改已存在的 TODO。需要 id，其它字段可选（仅传需要修改的字段）。

recurrence_rule、reminders、priority、status 格式同 calendar_todo_create。
${TIME_HINT}`,
  parameters: {
    type: 'object',
    properties: {
      id: { type: 'string', description: 'TODO ID（必填）' },
      title: { type: 'string', description: 'TODO 标题' },
      description: { type: 'string', description: '详细描述' },
      due_time: { type: 'string', description: '截止时间，接受 Unix 秒或日期字符串' },
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
      recurrence_rule: {
        type: 'object',
        description: '重复规则',
        properties: {
          freq: { type: 'string', enum: ['daily', 'weekly', 'monthly', 'yearly'] },
          interval: { type: 'number', minimum: 1 },
          count: { type: 'number', minimum: 1 },
          until: { type: 'number' },
          byday: { type: 'array', items: { type: 'string', enum: ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'] }, description: '每周几，如 ["MO","TU","WE","TH","FR"] 表示工作日' },
          bymonthday: { type: 'array', items: { type: 'number', minimum: 1, maximum: 31 }, description: '月中的日期，如 [15] 表示每月15日' },
          bymonth: { type: 'array', items: { type: 'number', minimum: 1, maximum: 12 }, description: '月份，如 [1] 表示一月' },
          bysetpos: { type: 'number', description: '在周期内的位置，如 -1 表示最后一个' },
        },
      },
      reminders: {
        type: 'array',
        items: { type: 'number' },
        description: '提醒分钟偏移数组（负数表示提前）',
      },
    },
    required: ['id'],
  },
  handler: async (args: any) => {
    try {
      if (!args.id) return { success: false, error: '需要 id' }
      const dueAt = resolveTime(args.due_time)
      const input: UpdateTodoInput = {
        id: String(args.id),
        title: args.title !== undefined ? String(args.title) : undefined,
        description: args.description !== undefined ? String(args.description) : undefined,
        due_at: dueAt,
        priority: args.priority as TodoPriority | undefined,
        status: args.status as TodoStatus | undefined,
        recurrence_rule: args.recurrence_rule !== undefined ? parseRecurrenceRule(args.recurrence_rule) : undefined,
        reminders: Array.isArray(args.reminders) ? args.reminders.map(Number) : undefined,
      }
      const todo = getCalendarService().updateTodo(input)
      if (!todo) return { success: false, error: 'TODO 不存在' }
      return {
        success: true,
        output: `已更新 TODO：${formatTodo(todo)}`,
        todo,
      }
    } catch (err: any) {
      return { success: false, error: `TODO 修改失败: ${err.message || err}` }
    }
  },
  onDemand: true,
  permission: 'safe',
}

const calendarTodoDeleteTool: PluginToolDefinition = {
  id: 'calendar_todo_delete',
  name: 'calendar_todo_delete',
  title: '删除待办',
  summary: '删除 TODO。删除待办时使用。',
  description: '删除已存在的 TODO。需要 id。',
  parameters: {
    type: 'object',
    properties: {
      id: { type: 'string', description: 'TODO ID（必填）' },
    },
    required: ['id'],
  },
  handler: async (args: any) => {
    try {
      if (!args.id) return { success: false, error: '需要 id' }
      const ok = getCalendarService().deleteTodo(String(args.id))
      if (!ok) return { success: false, error: 'TODO 不存在或已删除' }
      return { success: true, output: `已删除 TODO id=${args.id}` }
    } catch (err: any) {
      return { success: false, error: `TODO 删除失败: ${err.message || err}` }
    }
  },
  onDemand: true,
  permission: 'safe',
}

const calendarTodoCompleteTool: PluginToolDefinition = {
  id: 'calendar_todo_complete',
  name: 'calendar_todo_complete',
  title: '完成/取消完成待办',
  summary: '标记/取消标记 TODO 完成。切换待办完成状态时使用。',
  description: '标记 TODO 为已完成或取消完成。需要 id、completed（bool，true=标记完成，false=取消完成）。',
  parameters: {
    type: 'object',
    properties: {
      id: { type: 'string', description: 'TODO ID（必填）' },
      completed: { type: 'boolean', description: 'true=标记完成，false=取消完成' },
    },
    required: ['id', 'completed'],
  },
  handler: async (args: any) => {
    try {
      if (!args.id) return { success: false, error: '需要 id' }
      const todo = getCalendarService().completeTodo(String(args.id), args.completed === true)
      if (!todo) return { success: false, error: 'TODO 不存在' }
      return {
        success: true,
        output: `已${args.completed === true ? '完成' : '取消完成'} TODO：${formatTodo(todo)}`,
        todo,
      }
    } catch (err: any) {
      return { success: false, error: `TODO 完成操作失败: ${err.message || err}` }
    }
  },
  onDemand: true,
  permission: 'safe',
}

const calendarTodoStatsTool: PluginToolDefinition = {
  id: 'calendar_todo_stats',
  name: 'calendar_todo_stats',
  title: '待办统计',
  summary: '返回 TODO 总览统计（总数/待办/已完成/逾期等）。查看待办整体情况时使用。',
  description: '返回 TODO 总览统计（总数 / 待办 / 进行中 / 已完成 / 已逾期 / 今日到期 / 本周到期 / 完成率）。',
  parameters: {
    type: 'object',
    properties: {},
  },
  handler: async () => {
    try {
      const stats: CalendarTodoStats = getCalendarService().getTodoStats()
      return {
        success: true,
        output: `TODO 总览：共 ${stats.total} 条 | 待办 ${stats.pending} | 进行中 ${stats.in_progress} | 已完成 ${stats.completed} | 已逾期 ${stats.overdue} | 今日到期 ${stats.due_today} | 本周到期 ${stats.due_this_week} | 完成率 ${stats.completion_rate}%`,
        stats,
      }
    } catch (err: any) {
      return { success: false, error: `TODO 统计失败: ${err.message || err}` }
    }
  },
  onDemand: true,
  permission: 'safe',
}

export function createCalendarTools(): PluginToolDefinition[] {
  return [
    calendarEventListTool,
    calendarEventCreateTool,
    calendarEventUpdateTool,
    calendarEventDeleteTool,
    calendarTodoListTool,
    calendarTodoCreateTool,
    calendarTodoUpdateTool,
    calendarTodoDeleteTool,
    calendarTodoCompleteTool,
    calendarTodoStatsTool,
  ]
}
