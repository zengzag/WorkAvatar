import type { ToolDefinition } from './types'
import AutomationService from '../../automation/automation.service'
import DatabaseService from '../../database.service'
import { parseNaturalTime } from './utils'
import type { AutomationRecurrenceRule } from '../../../../shared/ipc-channels'

/**
 * 自动化任务工具（拆分为独立工具，每个职责单一、参数明确）：
 *
 * 元信息（LLM 创建任务前需要获取的上下文）：
 *   - automation_list_employees  列出可用的数字员工
 *   - automation_list_providers  列出可用的 LLM 供应商及其模型
 *
 * 任务管理：
 *   - automation_task_list     列出/筛选自动化任务
 *   - automation_task_create   创建自动化任务
 *   - automation_task_update   修改自动化任务
 *   - automation_task_delete   删除自动化任务
 *   - automation_task_toggle   启用/暂停任务
 *   - automation_task_run_now  立即执行一次
 *   - automation_task_preview  预览未来执行时间
 *
 * 执行历史：
 *   - automation_run_list      列出执行历史
 *
 * 设计要点：
 * - 创建/修改/删除/执行后由 AutomationService.broadcastDataChanged 通知前端刷新
 * - 时间参数接受 Unix 秒或日期字符串，由 parseNaturalTime 服务端解析
 * - 创建任务前 LLM 应先调用 automation_list_employees / automation_list_providers 获取可用 ID
 */

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

// ==================== 元信息工具 ====================

const automationListEmployeesTool: ToolDefinition = {
  id: 'automation_list_employees',
  name: 'automation_list_employees',
  title: '列出数字员工',
  summary: '列出所有可用的数字员工（id、名称、描述）。创建自动化任务前调用此工具获取 employee_id。',
  description: `列出所有可用的数字员工，返回 id、name、description。
- 创建自动化任务时需要指定 employee_id（执行该任务的数字员工）
- 调用此工具后，将所需员工的 id 传入 automation_task_create 的 employee_id 参数`,
  parameters: {
    type: 'object',
    properties: {},
  },
  handler: async () => {
    try {
      const db = DatabaseService.getInstance().getDb()
      const rows = db.prepare(
        `SELECT id, name, description FROM employees ORDER BY name`
      ).all() as any[]
      if (rows.length === 0) {
        return { success: true, output: '暂无可用数字员工。', employees: [] }
      }
      const formatted = rows.map((r, i) => `[${i + 1}] ${r.name} (id=${r.id})\n  描述: ${r.description || '无'}`).join('\n')
      return {
        success: true,
        output: `找到 ${rows.length} 个数字员工：\n${formatted}`,
        employees: rows,
      }
    } catch (err: any) {
      return { success: false, error: `列出数字员工失败: ${err.message || err}` }
    }
  },
  source: 'builtin',
  onDemand: true,
  permission: 'safe',
}

const automationListProvidersTool: ToolDefinition = {
  id: 'automation_list_providers',
  name: 'automation_list_providers',
  title: '列出模型供应商',
  summary: '列出所有 LLM 供应商及其可用模型。创建自动化任务前调用此工具获取 provider_id 和 model_id。',
  description: `列出所有 LLM 供应商及其可用模型，返回 id、name、provider_type、默认 model、models 列表。
- 创建自动化任务时需要指定 provider_id（必填）和 model_id（可选，不传则用供应商默认模型）
- models 列表中标记 is_default 的为该供应商的默认模型
- 调用此工具后，将所选供应商的 id 传入 automation_task_create 的 provider_id 参数，模型的 model 字段传入 model_id 参数`,
  parameters: {
    type: 'object',
    properties: {},
  },
  handler: async () => {
    try {
      const db = DatabaseService.getInstance().getDb()
      const rows = db.prepare(
        `SELECT id, name, provider_type, model, models_json FROM llm_providers ORDER BY is_default DESC, created_at DESC`
      ).all() as any[]
      if (rows.length === 0) {
        return { success: true, output: '暂无 LLM 供应商。', providers: [] }
      }
      const providers = rows.map((r) => {
        let models: any[] = []
        try { models = JSON.parse(r.models_json || '[]') } catch { /* ignore */ }
        return {
          id: r.id,
          name: r.name,
          provider_type: r.provider_type,
          default_model: r.model,
          models: models.map((m: any) => ({
            id: m.id,
            model: m.model,
            name: m.name || m.model,
            is_default: !!m.is_default,
            category: m.category || 'chat',
          })),
        }
      })
      const formatted = providers.map((p, i) => {
        const modelLines = p.models.length > 0
          ? p.models.map((m: any) => `    - ${m.name} (model=${m.model}${m.is_default ? ' [默认]' : ''})`).join('\n')
          : '    (无模型列表，使用默认 model: ' + p.default_model + ')'
        return `[${i + 1}] ${p.name} (id=${p.id}, type=${p.provider_type})\n  默认模型: ${p.default_model}\n  可用模型:\n${modelLines}`
      }).join('\n')
      return {
        success: true,
        output: `找到 ${providers.length} 个供应商：\n${formatted}`,
        providers,
      }
    } catch (err: any) {
      return { success: false, error: `列出供应商失败: ${err.message || err}` }
    }
  },
  source: 'builtin',
  onDemand: true,
  permission: 'safe',
}

// ==================== 任务管理工具 ====================

const automationTaskListTool: ToolDefinition = {
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
      const service = AutomationService.getInstance()
      const params: any = {}
      if (args.employee_id) params.employee_id = String(args.employee_id)
      if (args.is_enabled !== undefined) params.is_enabled = args.is_enabled === true
      if (args.tag) params.tag = String(args.tag)
      if (args.search) params.search = String(args.search)
      const tasks = service.listTasks(params)
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
  source: 'builtin',
  onDemand: true,
  permission: 'safe',
}

const automationTaskCreateTool: ToolDefinition = {
  id: 'automation_task_create',
  name: 'automation_task_create',
  title: '创建自动化任务',
  summary: '创建新的自动化任务。创建前请先调用 automation_list_employees 和 automation_list_providers 获取 ID。',
  description: `创建一个新的自动化任务。任务将按配置的时间自动触发，由指定数字员工以指定提示词发起对话执行。
- 必填：title、prompt、employee_id、provider_id、start_at
- 可选：model_id（不传则用供应商默认模型）、description、recurrence_rule、is_enabled、notify_on_complete、retry_count、tags、high_permission

recurrence_rule 格式：{"freq":"daily|weekdays|weekly|monthly|yearly","interval":数字,"count":可选,"until":可选unix秒}
- 不传 recurrence_rule 表示不重复（仅执行一次）
- 不重复任务执行后自动暂停（is_enabled=0），保留记录供重新启用

创建前请先调用 automation_list_employees 获取 employee_id，调用 automation_list_providers 获取 provider_id 和 model_id。
${TIME_HINT}`,
  parameters: {
    type: 'object',
    properties: {
      title: { type: 'string', description: '任务标题' },
      description: { type: 'string', description: '任务描述（可选）' },
      prompt: { type: 'string', description: '任务提示词，将作为用户消息发起对话由 AI 执行' },
      employee_id: { type: 'string', description: '执行该任务的数字员工 ID（来自 automation_list_employees）' },
      provider_id: { type: 'string', description: 'LLM 供应商 ID（来自 automation_list_providers）' },
      model_id: { type: 'string', description: '模型 ID（来自 automation_list_providers 的 models 列表，不传则用供应商默认模型）' },
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
      if (!args.employee_id) return { success: false, error: '需要 employee_id（请先调用 automation_list_employees 获取）' }
      if (!args.provider_id) return { success: false, error: '需要 provider_id（请先调用 automation_list_providers 获取）' }
      const startAt = resolveTime(args.start_at)
      if (!startAt) return { success: false, error: '需要 start_at（接受 Unix 秒或日期字符串）' }

      const service = AutomationService.getInstance()
      const task = service.createTask({
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
      service.broadcastDataChanged('task')
      return {
        success: true,
        output: `已创建自动化任务：${formatTask(task)}`,
        task,
      }
    } catch (err: any) {
      return { success: false, error: `创建任务失败: ${err.message || err}` }
    }
  },
  source: 'builtin',
  onDemand: true,
  permission: 'safe',
}

const automationTaskUpdateTool: ToolDefinition = {
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
      const service = AutomationService.getInstance()
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

      const task = service.updateTask(input)
      if (!task) return { success: false, error: '任务不存在' }
      service.broadcastDataChanged('task')
      return {
        success: true,
        output: `已更新任务：${formatTask(task)}`,
        task,
      }
    } catch (err: any) {
      return { success: false, error: `修改任务失败: ${err.message || err}` }
    }
  },
  source: 'builtin',
  onDemand: true,
  permission: 'safe',
}

const automationTaskDeleteTool: ToolDefinition = {
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
      const service = AutomationService.getInstance()
      const ok = service.deleteTask(String(args.id))
      if (!ok) return { success: false, error: '任务不存在或已删除' }
      service.broadcastDataChanged('task')
      service.broadcastDataChanged('run')
      return { success: true, output: `已删除任务 id=${args.id}` }
    } catch (err: any) {
      return { success: false, error: `删除任务失败: ${err.message || err}` }
    }
  },
  source: 'builtin',
  onDemand: true,
  permission: 'safe',
}

const automationTaskToggleTool: ToolDefinition = {
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
      const service = AutomationService.getInstance()
      const task = service.toggleTask(String(args.id), args.enabled === true)
      if (!task) return { success: false, error: '任务不存在' }
      service.broadcastDataChanged('task')
      return {
        success: true,
        output: `已${args.enabled === true ? '启用' : '暂停'}任务：${formatTask(task)}`,
        task,
      }
    } catch (err: any) {
      return { success: false, error: `操作失败: ${err.message || err}` }
    }
  },
  source: 'builtin',
  onDemand: true,
  permission: 'safe',
}

const automationTaskRunNowTool: ToolDefinition = {
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
      const service = AutomationService.getInstance()
      const run = await service.runTask(String(args.id), 'manual')
      service.broadcastDataChanged('task')
      service.broadcastDataChanged('run')
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
  source: 'builtin',
  onDemand: true,
  permission: 'safe',
}

const automationTaskPreviewTool: ToolDefinition = {
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
      const service = AutomationService.getInstance()
      const task = service.getTask(String(args.id))
      if (!task) return { success: false, error: '任务不存在' }
      const count = Math.max(1, Math.min(10, Math.floor(Number(args.count ?? 5)) || 5))
      const runs = service.previewNextRuns(task, count)
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
  source: 'builtin',
  onDemand: true,
  permission: 'safe',
}

// ==================== 执行历史工具 ====================

const automationRunListTool: ToolDefinition = {
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
      const service = AutomationService.getInstance()
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
      const runs = service.listRuns(params)
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
  source: 'builtin',
  onDemand: true,
  permission: 'safe',
}

export const automationTools: ToolDefinition[] = [
  automationListEmployeesTool,
  automationListProvidersTool,
  automationTaskListTool,
  automationTaskCreateTool,
  automationTaskUpdateTool,
  automationTaskDeleteTool,
  automationTaskToggleTool,
  automationTaskRunNowTool,
  automationTaskPreviewTool,
  automationRunListTool,
]
