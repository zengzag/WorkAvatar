/**
 * 自动化 agent 工具（由宿主 automation.tool.ts 迁移而来，8 个独立工具）。
 * 差异点：
 * - 工具类型改用 PluginToolDefinition（无 source 字段）
 * - 服务走插件单例 getAutomationService(ctx)
 * - 员工/供应商列表工具已迁回宿主内置（list_employees / list_providers），不再由本插件提供
 */
import type { PluginContext, PluginToolDefinition } from '../../../plugin-sdk/src'
import { getAutomationService } from './automation-service'
import type { AutomationRecurrenceRule } from './automation-service'

const TIME_HINT = '时间参数接受 Unix 秒（number）或日期字符串（如 "2026-07-24 15:00"、"明天下午3点" 不支持自然语言，仅支持绝对日期时间格式），由服务端解析。'

function parseRecurrenceRule(rule: any): AutomationRecurrenceRule | null {
  if (!rule || typeof rule !== 'object') return null
  const freq = rule.freq
  const validFreqs = ['daily', 'weekdays', 'weekly', 'monthly', 'yearly']
  if (!validFreqs.includes(freq)) return null
  const interval = Math.max(1, Math.floor(Number(rule.interval) || 1))
  const result: AutomationRecurrenceRule = { freq, interval } as AutomationRecurrenceRule
  if (typeof rule.count === 'number') result.count = Math.max(1, Math.floor(rule.count))
  if (typeof rule.until === 'number') result.until = Math.floor(rule.until)
  return result
}

function parseNaturalTime(input: any): number | null {
  if (input == null) return null
  if (typeof input === 'number' && !isNaN(input)) return Math.floor(input)
  const raw = String(input).trim()
  if (!raw) return null
  if (/^\d{10}$/.test(raw)) return parseInt(raw, 10)
  if (/^\d{13}$/.test(raw)) return Math.floor(parseInt(raw, 10) / 1000)
  const dateOnly = raw.match(/^(\d{4})[\/\-.](\d{1,2})[\/\-.](\d{1,2})$/)
  if (dateOnly) {
    const d = new Date(parseInt(dateOnly[1]), parseInt(dateOnly[2]) - 1, parseInt(dateOnly[3]))
    return isNaN(d.getTime()) ? null : Math.floor(d.getTime() / 1000)
  }
  const dt = raw.match(/^(\d{4})[\/\-.](\d{1,2})[\/\-.](\d{1,2})[ T](\d{1,2}):(\d{1,2})(?::(\d{1,2}))?$/)
  if (dt) {
    const d = new Date(
      parseInt(dt[1]), parseInt(dt[2]) - 1, parseInt(dt[3]),
      parseInt(dt[4]), parseInt(dt[5]), dt[6] ? parseInt(dt[6]) : 0
    )
    return isNaN(d.getTime()) ? null : Math.floor(d.getTime() / 1000)
  }
  const iso = new Date(raw)
  return isNaN(iso.getTime()) ? null : Math.floor(iso.getTime() / 1000)
}

function resolveTime(val: any): number | undefined {
  if (val === undefined || val === null) return undefined
  const parsed = parseNaturalTime(val)
  return parsed !== null ? parsed : undefined
}

function formatTask(t: any): string {
  const next = t.next_run_at ? new Date(t.next_run_at * 1000).toLocaleString('zh-CN') : '无'
  const last = t.last_run_at ? new Date(t.last_run_at * 1000).toLocaleString('zh-CN') : '无'
  const freq = t.recurrence_rule ? ` 重复:${t.recurrence_rule.freq}×${t.recurrence_rule.interval}` : ' 不重复'
  return `• ${t.title} | 员工:${t.employee_id} | 下次:${next} | 上次:${last} | 状态:${t.last_status}${freq} | 启用:${t.is_enabled ? '是' : '否'} [id=${t.id}]`
}

function formatRun(r: any): string {
  const started = new Date(r.started_at * 1000).toLocaleString('zh-CN')
  const finished = r.finished_at ? new Date(r.finished_at * 1000).toLocaleString('zh-CN') : '未结束'
  const dur = r.duration_ms != null ? `${(r.duration_ms / 1000).toFixed(1)}s` : '-'
  return `• [${r.status}] ${started}~${finished} (${dur}) | 触发:${r.triggered_by} | 员工:${r.employee_id}${r.error_message ? ` | 错误:${r.error_message}` : ''} [id=${r.id}]`
}

export function createAutomationTools(ctx: PluginContext): PluginToolDefinition[] {
  const service = () => getAutomationService(ctx)

  return [
    // ==================== 任务管理工具 ====================

    {
      id: 'automation_task_list',
      name: 'automation_task_list',
      title: '列出自动化任务',
      summary: '列出/筛选自动化任务。查看现有任务时使用，支持按员工/启用状态/标签/关键词筛选。',
      description: `列出自动化任务，支持筛选。
- 可选筛选：employee_id / is_enabled / tag / search
- 不传任何筛选条件时返回全部任务

返回每个任务的 id、标题、提示词、员工 ID、供应商 ID、模型、首次运行时间、重复规则、启用状态、上次执行状态等。`,
      parameters: {
        type: 'object',
        properties: {
          employee_id: { type: 'string', description: '按数字员工 ID 筛选' },
          is_enabled: { type: 'boolean', description: '按启用状态筛选' },
          tag: { type: 'string', description: '按标签筛选' },
          search: { type: 'string', description: '按标题/描述/提示词关键词搜索' },
        },
      },
      handler: async (args: any) => {
        try {
          const params: any = {}
          if (args.employee_id) params.employee_id = String(args.employee_id)
          if (args.is_enabled !== undefined) params.is_enabled = args.is_enabled === true
          if (args.tag) params.tag = String(args.tag)
          if (args.search) params.search = String(args.search)
          const tasks = service().listTasks(params)
          if (tasks.length === 0) {
            return { success: true, output: '未找到匹配的自动化任务。', tasks: [] }
          }
          return {
            success: true,
            output: `找到 ${tasks.length} 个任务：\n${tasks.map(formatTask).join('\n')}`,
            tasks,
          }
        } catch (err: any) {
          return { success: false, error: `列出任务失败: ${err.message || err}` }
        }
      },
      onDemand: true,
      permission: 'safe',
    },

    {
      id: 'automation_task_create',
      name: 'automation_task_create',
      title: '创建自动化任务',
      summary: '创建新的自动化任务。创建前请先调用 list_employees 和 list_providers 获取 ID。',
      description: `创建一个新的自动化任务。任务将按配置的时间自动触发，由指定数字员工以指定提示词发起对话执行。
- 必填：title、prompt、employee_id、provider_id、start_at
- 可选：model_id（不传则用供应商默认模型）、description、recurrence_rule、is_enabled、notify_on_complete、retry_count、tags、high_permission

recurrence_rule 格式：{"freq":"daily|weekdays|weekly|monthly|yearly","interval":数字,"count":可选,"until":可选unix秒}
- 不传 recurrence_rule 表示不重复（仅执行一次）
- 不重复任务执行后自动暂停（is_enabled=0），保留记录供重新启用

创建前请先调用 list_employees 获取 employee_id，调用 list_providers 获取 provider_id 和 model_id。
${TIME_HINT}`,
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string', description: '任务标题' },
          description: { type: 'string', description: '任务描述（可选）' },
          prompt: { type: 'string', description: '任务提示词，将作为用户消息发起对话由 AI 执行' },
          employee_id: { type: 'string', description: '执行该任务的数字员工 ID（来自 list_employees）' },
          provider_id: { type: 'string', description: 'LLM 供应商 ID（来自 list_providers）' },
          model_id: { type: 'string', description: '模型 ID（来自 list_providers 的 models 列表，不传则用供应商默认模型）' },
          start_at: { type: 'string', description: '首次运行时间，接受 Unix 秒或日期字符串（如 "2026-07-24 15:00"）' },
          recurrence_rule: {
            type: 'object',
            description: '重复规则（不传表示不重复）',
            properties: {
              freq: { type: 'string', enum: ['daily', 'weekdays', 'weekly', 'monthly', 'yearly'] },
              interval: { type: 'number', minimum: 1 },
              count: { type: 'number', minimum: 1 },
              until: { type: 'number' },
            },
          },
          is_enabled: { type: 'boolean', description: '是否启用（默认 true）' },
          notify_on_complete: { type: 'boolean', description: '完成时是否通知（默认 true）' },
          retry_count: { type: 'number', description: '失败重试次数（0-3，默认 0）', minimum: 0, maximum: 3 },
          tags: { type: 'array', items: { type: 'string' }, description: '标签列表' },
          high_permission: { type: 'boolean', description: '是否允许高权限（操作工作区外文件，默认 false）' },
        },
        required: ['title', 'prompt', 'employee_id', 'provider_id', 'start_at'],
      },
      handler: async (args: any) => {
        try {
          if (!args.title?.trim()) return { success: false, error: '需要 title' }
          if (!args.prompt?.trim()) return { success: false, error: '需要 prompt' }
          if (!args.employee_id) return { success: false, error: '需要 employee_id（请先调用 list_employees 获取）' }
          if (!args.provider_id) return { success: false, error: '需要 provider_id（请先调用 list_providers 获取）' }
          const startAt = resolveTime(args.start_at)
          if (!startAt) return { success: false, error: '需要 start_at（接受 Unix 秒或日期字符串）' }

          const task = service().createTask({
            title: String(args.title),
            description: args.description ? String(args.description) : undefined,
            prompt: String(args.prompt),
            employee_id: String(args.employee_id),
            provider_id: String(args.provider_id),
            model_id: args.model_id ? String(args.model_id) : null,
            start_at: startAt,
            recurrence_rule: parseRecurrenceRule(args.recurrence_rule),
            is_enabled: args.is_enabled !== false,
            notify_on_complete: args.notify_on_complete !== false,
            retry_count: args.retry_count != null ? Math.max(0, Math.min(3, Math.floor(Number(args.retry_count)))) : 0,
            tags: Array.isArray(args.tags) ? args.tags.map(String) : [],
            high_permission: args.high_permission === true,
          })
          service().broadcastDataChanged('task')
          return {
            success: true,
            output: `已创建自动化任务：${formatTask(task)}`,
            task,
          }
        } catch (err: any) {
          return { success: false, error: `创建任务失败: ${err.message || err}` }
        }
      },
      onDemand: true,
      permission: 'safe',
    },

    {
      id: 'automation_task_update',
      name: 'automation_task_update',
      title: '修改自动化任务',
      summary: '修改已存在的自动化任务。仅传需修改字段。',
      description: `修改已存在的自动化任务。需要 id，其它字段可选（仅传需要修改的字段）。
recurrence_rule、tags 格式同 automation_task_create。
${TIME_HINT}`,
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string', description: '任务 ID（必填）' },
          title: { type: 'string', description: '任务标题' },
          description: { type: 'string', description: '任务描述' },
          prompt: { type: 'string', description: '任务提示词' },
          employee_id: { type: 'string', description: '执行该任务的数字员工 ID' },
          provider_id: { type: 'string', description: 'LLM 供应商 ID' },
          model_id: { type: 'string', description: '模型 ID' },
          start_at: { type: 'string', description: '首次运行时间，接受 Unix 秒或日期字符串' },
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
          is_enabled: { type: 'boolean', description: '是否启用' },
          notify_on_complete: { type: 'boolean', description: '完成时是否通知' },
          retry_count: { type: 'number', description: '失败重试次数（0-3）', minimum: 0, maximum: 3 },
          tags: { type: 'array', items: { type: 'string' }, description: '标签列表' },
          high_permission: { type: 'boolean', description: '是否允许高权限' },
        },
        required: ['id'],
      },
      handler: async (args: any) => {
        try {
          if (!args.id) return { success: false, error: '需要 id' }
          const input: any = { id: String(args.id) }
          if (args.title !== undefined) input.title = String(args.title)
          if (args.description !== undefined) input.description = String(args.description)
          if (args.prompt !== undefined) input.prompt = String(args.prompt)
          if (args.employee_id !== undefined) input.employee_id = String(args.employee_id)
          if (args.provider_id !== undefined) input.provider_id = String(args.provider_id)
          if (args.model_id !== undefined) input.model_id = args.model_id ? String(args.model_id) : null
          if (args.start_at !== undefined) {
            const t = resolveTime(args.start_at)
            if (t !== undefined) input.start_at = t
          }
          if (args.recurrence_rule !== undefined) input.recurrence_rule = parseRecurrenceRule(args.recurrence_rule)
          if (args.is_enabled !== undefined) input.is_enabled = args.is_enabled === true
          if (args.notify_on_complete !== undefined) input.notify_on_complete = args.notify_on_complete === true
          if (args.retry_count !== undefined) input.retry_count = Math.max(0, Math.min(3, Math.floor(Number(args.retry_count))))
          if (args.tags !== undefined) input.tags = Array.isArray(args.tags) ? args.tags.map(String) : []
          if (args.high_permission !== undefined) input.high_permission = args.high_permission === true

          const task = service().updateTask(input)
          if (!task) return { success: false, error: '任务不存在' }
          service().broadcastDataChanged('task')
          return {
            success: true,
            output: `已更新任务：${formatTask(task)}`,
            task,
          }
        } catch (err: any) {
          return { success: false, error: `修改任务失败: ${err.message || err}` }
        }
      },
      onDemand: true,
      permission: 'safe',
    },

    {
      id: 'automation_task_delete',
      name: 'automation_task_delete',
      title: '删除自动化任务',
      summary: '删除自动化任务。关联的执行历史和对话也会被一并删除。',
      description: '删除已存在的自动化任务。需要 id。关联的执行历史（automation_runs）和对话（conversations）也会被一并删除。',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string', description: '任务 ID（必填）' },
        },
        required: ['id'],
      },
      handler: async (args: any) => {
        try {
          if (!args.id) return { success: false, error: '需要 id' }
          const ok = await service().deleteTask(String(args.id))
          if (!ok) return { success: false, error: '任务不存在或已删除' }
          service().broadcastDataChanged('task')
          service().broadcastDataChanged('run')
          return { success: true, output: `已删除任务 id=${args.id}` }
        } catch (err: any) {
          return { success: false, error: `删除任务失败: ${err.message || err}` }
        }
      },
      onDemand: true,
      permission: 'safe',
    },

    {
      id: 'automation_task_toggle',
      name: 'automation_task_toggle',
      title: '启用/暂停任务',
      summary: '启用或暂停自动化任务。',
      description: '启用或暂停自动化任务。需要 id 和 enabled（bool，true=启用，false=暂停）。暂停后不再自动触发，重新启用会基于 start_at 与规则重算下次运行时间。',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string', description: '任务 ID（必填）' },
          enabled: { type: 'boolean', description: 'true=启用，false=暂停' },
        },
        required: ['id', 'enabled'],
      },
      handler: async (args: any) => {
        try {
          if (!args.id) return { success: false, error: '需要 id' }
          const task = service().toggleTask(String(args.id), args.enabled === true)
          if (!task) return { success: false, error: '任务不存在' }
          service().broadcastDataChanged('task')
          return {
            success: true,
            output: `已${args.enabled === true ? '启用' : '暂停'}任务：${formatTask(task)}`,
            task,
          }
        } catch (err: any) {
          return { success: false, error: `操作失败: ${err.message || err}` }
        }
      },
      onDemand: true,
      permission: 'safe',
    },

    {
      id: 'automation_task_run_now',
      name: 'automation_task_run_now',
      title: '立即执行任务',
      summary: '立即触发一次自动化任务执行（不影响后续调度）。',
      description: '立即触发一次自动化任务执行。需要 id。执行会创建新对话并调用对应数字员工执行提示词。执行完成后可通过 automation_run_list 查看结果。注意：手动触发不会跳过正在运行的任务（如果上次自动触发仍在执行则会被跳过）。',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string', description: '任务 ID（必填）' },
        },
        required: ['id'],
      },
      handler: async (args: any) => {
        try {
          if (!args.id) return { success: false, error: '需要 id' }
          const run = await service().runTask(String(args.id), 'manual')
          service().broadcastDataChanged('task')
          service().broadcastDataChanged('run')
          if (!run) {
            return { success: true, output: `任务 ${args.id} 被跳过（可能正在执行中）` }
          }
          return {
            success: true,
            output: `任务已触发执行：${formatRun(run)}`,
            run,
          }
        } catch (err: any) {
          return { success: false, error: `执行失败: ${err.message || err}` }
        }
      },
      onDemand: true,
      permission: 'safe',
    },

    {
      id: 'automation_task_preview',
      name: 'automation_task_preview',
      title: '预览未来执行时间',
      summary: '预览自动化任务未来 N 次执行时间。',
      description: '预览自动化任务未来 N 次执行时间。需要 id，可选 count（1-10，默认 5）。返回 unix 秒时间戳列表。',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string', description: '任务 ID（必填）' },
          count: { type: 'number', description: '预览次数（1-10，默认 5）', minimum: 1, maximum: 10 },
        },
        required: ['id'],
      },
      handler: async (args: any) => {
        try {
          if (!args.id) return { success: false, error: '需要 id' }
          const task = service().getTask(String(args.id))
          if (!task) return { success: false, error: '任务不存在' }
          const count = Math.max(1, Math.min(10, Math.floor(Number(args.count ?? 5)) || 5))
          const runs = service().previewNextRuns(task, count)
          if (runs.length === 0) {
            return { success: true, output: '无未来执行计划（任务可能已禁用或不重复且首次时间已过）', runs: [] }
          }
          const formatted = runs.map((ts, i) => `[${i + 1}] ${new Date(ts * 1000).toLocaleString('zh-CN')} (unix=${ts})`).join('\n')
          return {
            success: true,
            output: `未来 ${runs.length} 次执行时间：\n${formatted}`,
            runs,
          }
        } catch (err: any) {
          return { success: false, error: `预览失败: ${err.message || err}` }
        }
      },
      onDemand: true,
      permission: 'safe',
    },

    // ==================== 执行历史工具 ====================

    {
      id: 'automation_run_list',
      name: 'automation_run_list',
      title: '列出执行历史',
      summary: '列出/筛选自动化任务执行历史。',
      description: `列出自动化任务执行历史，支持筛选。
- 可选筛选：task_id / employee_id / status / triggered_by / from / to / limit
- status: running / success / failed
- triggered_by: scheduler / manual
- 默认按开始时间倒序，limit 默认 50`,
      parameters: {
        type: 'object',
        properties: {
          task_id: { type: 'string', description: '按任务 ID 筛选' },
          employee_id: { type: 'string', description: '按数字员工 ID 筛选' },
          status: {
            type: 'string',
            enum: ['running', 'success', 'failed'],
            description: '按执行状态筛选',
          },
          triggered_by: {
            type: 'string',
            enum: ['scheduler', 'manual'],
            description: '按触发方式筛选',
          },
          from: { type: 'string', description: '起始时间，接受 Unix 秒或日期字符串' },
          to: { type: 'string', description: '结束时间，接受 Unix 秒或日期字符串' },
          limit: { type: 'number', description: '返回条数上限（默认 50）', minimum: 1, maximum: 200 },
        },
      },
      handler: async (args: any) => {
        try {
          const params: any = {}
          if (args.task_id) params.task_id = String(args.task_id)
          if (args.employee_id) params.employee_id = String(args.employee_id)
          if (args.status) params.status = String(args.status)
          if (args.triggered_by) params.triggered_by = String(args.triggered_by)
          if (args.from !== undefined) {
            const t = resolveTime(args.from)
            if (t !== undefined) params.from = t
          }
          if (args.to !== undefined) {
            const t = resolveTime(args.to)
            if (t !== undefined) params.to = t
          }
          if (args.limit != null) params.limit = Math.max(1, Math.min(200, Math.floor(Number(args.limit))))
          const runs = service().listRuns(params)
          if (runs.length === 0) {
            return { success: true, output: '未找到匹配的执行历史。', runs: [] }
          }
          return {
            success: true,
            output: `找到 ${runs.length} 条执行历史：\n${runs.map(formatRun).join('\n')}`,
            runs,
          }
        } catch (err: any) {
          return { success: false, error: `列出执行历史失败: ${err.message || err}` }
        }
      },
      onDemand: true,
      permission: 'safe',
    },
  ]
}
