import DatabaseService from './database.service'
import EmployeeAgentService from './employee-agent.service'
import TaskNotificationService, { type TaskCompletionNotification } from './task-notification.service'
import { BrowserWindow } from 'electron'
import { IPC_CHANNELS } from '../../shared/ipc-channels'
import { generateId } from './common-utils'
import type { DBEmployee } from '../../shared/db-types'

interface EmployeeTask {
  id: string
  employee_id: string
  name: string
  description: string
  prompt: string
  is_enabled: boolean
  run_mode: 'recurring' | 'once'
  timeout_ms: number
  llm_provider_id: string | null
  llm_model: string | null
  enable_thinking: boolean
  extra_config_json: string
  created_at: number
  updated_at: number
}

interface EmployeeSchedule {
  id: string
  employee_id: string
  name: string
  cron_expr: string
  is_enabled: boolean
  run_mode: 'recurring' | 'once'
  notify_on_complete: boolean
  task_ids_json: string
  last_run_at: number | null
  next_run_at: number | null
  created_at: number
  updated_at: number
}

interface TaskExecution {
  id: string
  employee_id: string
  task_id: string
  schedule_id: string | null
  trigger_type: 'manual' | 'scheduled'
  status: 'running' | 'completed' | 'failed' | 'timeout'
  result_text: string | null
  error_message: string | null
  segments_json: string | null
  started_at: number
  completed_at: number | null
  duration_ms: number | null
}

interface MessageSegment {
  type: 'thinking' | 'answer' | 'tool_call'
  id: string
  timestamp?: number
  content?: string
  isStreaming?: boolean
  collapsed?: boolean
  toolName?: string
  toolArgs?: any
  toolResult?: any
  isToolComplete?: boolean
}

class EmployeeTaskService {
  private db: DatabaseService
  private static instance: EmployeeTaskService
  private activeExecutions: Map<string, AbortController> = new Map()

  private constructor() {
    this.db = DatabaseService.getInstance()
  }

  private sendSegmentsToRenderer(executionId: string, segments: MessageSegment[], isStreaming: boolean = true): void {
    const window = BrowserWindow.getAllWindows()[0]
    if (window && !window.isDestroyed()) {
      window.webContents.send(IPC_CHANNELS.TASK_EXECUTION_SEGMENTS_UPDATE, {
        executionId,
        segments,
        isStreaming,
      })
    }
  }

  private sendStatusToRenderer(executionId: string, status: string, errorMessage?: string): void {
    const window = BrowserWindow.getAllWindows()[0]
    if (window && !window.isDestroyed()) {
      window.webContents.send(IPC_CHANNELS.TASK_EXECUTION_STATUS_UPDATE, {
        executionId,
        status,
        errorMessage: errorMessage || null,
      })
    }
  }

  static getInstance(): EmployeeTaskService {
    if (!EmployeeTaskService.instance) {
      EmployeeTaskService.instance = new EmployeeTaskService()
    }
    return EmployeeTaskService.instance
  }

  getTasks(employeeId: string): EmployeeTask[] {
    return this.db.getDb().prepare(
      'SELECT * FROM employee_tasks WHERE employee_id = ? ORDER BY created_at DESC'
    ).all(employeeId) as EmployeeTask[]
  }

  getTask(taskId: string): EmployeeTask | null {
    return this.db.getDb().prepare(
      'SELECT * FROM employee_tasks WHERE id = ?'
    ).get(taskId) as EmployeeTask | null
  }

  createTask(employeeId: string, name: string, description: string, prompt: string, timeoutMs: number = 300000, llmProviderId?: string, llmModel?: string, enableThinking: boolean = false, runMode: 'recurring' | 'once' = 'recurring'): EmployeeTask {
    const id = generateId()
    const now = Math.floor(Date.now() / 1000)
    this.db.getDb().prepare(
      `INSERT INTO employee_tasks (id, employee_id, name, description, prompt, is_enabled, run_mode, timeout_ms, llm_provider_id, llm_model, enable_thinking, extra_config_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, '{}', ?, ?)`
    ).run(id, employeeId, name, description, prompt, runMode, timeoutMs, llmProviderId || null, llmModel || null, enableThinking ? 1 : 0, now, now)
    return this.getTask(id)!
  }

  updateTask(taskId: string, data: { name?: string; description?: string; prompt?: string; is_enabled?: boolean; run_mode?: 'recurring' | 'once'; timeout_ms?: number; llm_provider_id?: string | null; llm_model?: string | null; enable_thinking?: boolean }): EmployeeTask | null {
    const task = this.getTask(taskId)
    if (!task) return null
    const updates: string[] = []
    const values: any[] = []
    if (data.name !== undefined) { updates.push('name = ?'); values.push(data.name) }
    if (data.description !== undefined) { updates.push('description = ?'); values.push(data.description) }
    if (data.prompt !== undefined) { updates.push('prompt = ?'); values.push(data.prompt) }
    if (data.is_enabled !== undefined) { updates.push('is_enabled = ?'); values.push(data.is_enabled ? 1 : 0) }
    if (data.run_mode !== undefined) { updates.push('run_mode = ?'); values.push(data.run_mode) }
    if (data.timeout_ms !== undefined) { updates.push('timeout_ms = ?'); values.push(data.timeout_ms) }
    if (data.llm_provider_id !== undefined) { updates.push('llm_provider_id = ?'); values.push(data.llm_provider_id || null) }
    if (data.llm_model !== undefined) { updates.push('llm_model = ?'); values.push(data.llm_model || null) }
    if (data.enable_thinking !== undefined) { updates.push('enable_thinking = ?'); values.push(data.enable_thinking ? 1 : 0) }
    if (updates.length === 0) return task
    updates.push('updated_at = ?')
    values.push(Math.floor(Date.now() / 1000))
    values.push(taskId)
    this.db.getDb().prepare(`UPDATE employee_tasks SET ${updates.join(', ')} WHERE id = ?`).run(...values)
    return this.getTask(taskId)
  }

  deleteTask(taskId: string): boolean {
    const result = this.db.getDb().prepare('DELETE FROM employee_tasks WHERE id = ?').run(taskId)
    return result.changes > 0
  }

  getSchedules(employeeId: string): EmployeeSchedule[] {
    return this.db.getDb().prepare(
      'SELECT * FROM employee_schedules WHERE employee_id = ? ORDER BY created_at DESC'
    ).all(employeeId) as EmployeeSchedule[]
  }

  getSchedule(scheduleId: string): EmployeeSchedule | null {
    return this.db.getDb().prepare(
      'SELECT * FROM employee_schedules WHERE id = ?'
    ).get(scheduleId) as EmployeeSchedule | null
  }

  getAllEnabledSchedules(): EmployeeSchedule[] {
    return this.db.getDb().prepare(
      "SELECT * FROM employee_schedules WHERE is_enabled = 1"
    ).all() as EmployeeSchedule[]
  }

  createSchedule(employeeId: string, name: string, cronExpr: string, taskIds: string[], runMode: 'recurring' | 'once' = 'recurring', notifyOnComplete: boolean = true): EmployeeSchedule {
    const id = generateId()
    const now = Math.floor(Date.now() / 1000)
    this.db.getDb().prepare(
      `INSERT INTO employee_schedules (id, employee_id, name, cron_expr, is_enabled, run_mode, notify_on_complete, task_ids_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?, ?)`
    ).run(id, employeeId, name, cronExpr, runMode, notifyOnComplete ? 1 : 0, JSON.stringify(taskIds), now, now)
    return this.getSchedule(id)!
  }

  updateSchedule(scheduleId: string, data: { name?: string; cron_expr?: string; is_enabled?: boolean; task_ids_json?: string; run_mode?: 'recurring' | 'once'; notify_on_complete?: boolean }): EmployeeSchedule | null {
    const schedule = this.getSchedule(scheduleId)
    if (!schedule) return null
    const updates: string[] = []
    const values: any[] = []
    if (data.name !== undefined) { updates.push('name = ?'); values.push(data.name) }
    if (data.cron_expr !== undefined) { updates.push('cron_expr = ?'); values.push(data.cron_expr) }
    if (data.is_enabled !== undefined) { updates.push('is_enabled = ?'); values.push(data.is_enabled ? 1 : 0) }
    if (data.run_mode !== undefined) { updates.push('run_mode = ?'); values.push(data.run_mode) }
    if (data.notify_on_complete !== undefined) { updates.push('notify_on_complete = ?'); values.push(data.notify_on_complete ? 1 : 0) }
    if (data.task_ids_json !== undefined) { updates.push('task_ids_json = ?'); values.push(data.task_ids_json) }
    if (updates.length === 0) return schedule
    updates.push('updated_at = ?')
    values.push(Math.floor(Date.now() / 1000))
    values.push(scheduleId)
    this.db.getDb().prepare(`UPDATE employee_schedules SET ${updates.join(', ')} WHERE id = ?`).run(...values)
    return this.getSchedule(scheduleId)
  }

  deleteSchedule(scheduleId: string): boolean {
    const result = this.db.getDb().prepare('DELETE FROM employee_schedules WHERE id = ?').run(scheduleId)
    return result.changes > 0
  }

  getExecutions(employeeId: string, limit: number = 50, offset: number = 0): TaskExecution[] {
    return this.db.getDb().prepare(
      'SELECT * FROM employee_task_executions WHERE employee_id = ? ORDER BY started_at DESC LIMIT ? OFFSET ?'
    ).all(employeeId, limit, offset) as TaskExecution[]
  }

  getExecution(executionId: string): TaskExecution | null {
    return this.db.getDb().prepare(
      'SELECT * FROM employee_task_executions WHERE id = ?'
    ).get(executionId) as TaskExecution | null
  }

  getExecutionsForTask(taskId: string, limit: number = 20): TaskExecution[] {
    return this.db.getDb().prepare(
      'SELECT * FROM employee_task_executions WHERE task_id = ? ORDER BY started_at DESC LIMIT ?'
    ).all(taskId, limit) as TaskExecution[]
  }

  getAllRecentExecutions(limit: number = 100): TaskExecution[] {
    return this.db.getDb().prepare(
      'SELECT * FROM employee_task_executions ORDER BY started_at DESC LIMIT ?'
    ).all(limit) as TaskExecution[]
  }

  getFailedExecutions(limit: number = 50): TaskExecution[] {
    return this.db.getDb().prepare(
      "SELECT * FROM employee_task_executions WHERE status IN ('failed', 'timeout') ORDER BY started_at DESC LIMIT ?"
    ).all(limit) as TaskExecution[]
  }

  deleteExecution(executionId: string): boolean {
    const result = this.db.getDb().prepare('DELETE FROM employee_task_executions WHERE id = ?').run(executionId)
    return result.changes > 0
  }

  startTaskExecution(taskId: string, triggerType: 'manual' | 'scheduled' = 'manual', scheduleId?: string, scheduleName?: string, notifyOnComplete?: boolean): string {
    const task = this.getTask(taskId)
    if (!task) throw new Error(`Task ${taskId} not found`)
    if (!task.is_enabled) throw new Error(`Task ${taskId} is disabled`)

    const employee = this.db.getDb().prepare('SELECT * FROM employees WHERE id = ?').get(task.employee_id) as DBEmployee | undefined
    if (!employee) throw new Error(`Employee ${task.employee_id} not found`)
    if (employee.status !== 'active') throw new Error(`Employee ${task.employee_id} is not active (status: ${employee.status})`)

    const providerId = task.llm_provider_id || employee.llm_provider_id
    if (!providerId) throw new Error('No LLM provider configured')

    const executionId = generateId()
    const now = Math.floor(Date.now() / 1000)
    this.db.getDb().prepare(
      `INSERT INTO employee_task_executions (id, employee_id, task_id, schedule_id, trigger_type, status, started_at)
       VALUES (?, ?, ?, ?, ?, 'running', ?)`
    ).run(executionId, task.employee_id, taskId, scheduleId || null, triggerType, now)

    this.executeTaskAsync(executionId, taskId, task, employee, providerId, task.llm_model, triggerType, scheduleId, scheduleName, notifyOnComplete)

    return executionId
  }

  private async executeTaskAsync(
    executionId: string,
    taskId: string,
    task: EmployeeTask,
    employee: DBEmployee,
    providerId: string,
    modelId: string | null,
    triggerType: 'manual' | 'scheduled',
    scheduleId?: string,
    scheduleName?: string,
    notifyOnComplete?: boolean
  ): Promise<void> {
    const startTime = Date.now()
    const abortController = new AbortController()
    this.activeExecutions.set(executionId, abortController)

    const timeout = setTimeout(() => {
      abortController.abort()
    }, task.timeout_ms || 300000)

    let resultText = ''
    let errorMsg = ''
    const segments: MessageSegment[] = []
    let lastSentTime = 0
    const SEGMENT_SEND_INTERVAL = 200

    const throttledSendSegments = (isStreaming: boolean = true) => {
      const now = Date.now()
      if (now - lastSentTime >= SEGMENT_SEND_INTERVAL || !isStreaming) {
        lastSentTime = now
        this.sendSegmentsToRenderer(executionId, segments, isStreaming)
      }
    }

    try {
      const agentService = EmployeeAgentService.getInstance()
      resultText = await new Promise<string>((resolve, reject) => {
        let accumulated = ''
        let currentSegment: MessageSegment | null = null

        agentService.chatStream(
          {
            employee_id: task.employee_id,
            provider_id: providerId,
            model_id: modelId || undefined,
            messages: [{ role: 'user', content: task.prompt }],
            use_skills: true,
            enable_thinking: task.enable_thinking,
          },
          {
            onChunk: (chunk: string) => {
              accumulated += chunk
              if (currentSegment && currentSegment.type === 'answer') {
                currentSegment.content = (currentSegment.content || '') + chunk
              } else {
                if (currentSegment) {
                  currentSegment.isStreaming = false
                }
                currentSegment = {
                  type: 'answer',
                  id: generateId(),
                  content: chunk,
                  isStreaming: true,
                }
                segments.push(currentSegment)
              }
              throttledSendSegments()
            },
            onThought: (thought: string) => {
              if (currentSegment && currentSegment.type === 'thinking') {
                currentSegment.content = (currentSegment.content || '') + thought
              } else {
                if (currentSegment) {
                  currentSegment.isStreaming = false
                }
                currentSegment = {
                  type: 'thinking',
                  id: generateId(),
                  content: thought,
                  isStreaming: true,
                  collapsed: false,
                }
                segments.push(currentSegment)
              }
              throttledSendSegments()
            },
            onToolCall: (toolCall: any) => {
              if (currentSegment) {
                currentSegment.isStreaming = false
              }
              currentSegment = {
                type: 'tool_call',
                id: generateId(),
                toolName: toolCall.name || toolCall.function?.name,
                toolArgs: toolCall.arguments || toolCall.function?.arguments,
                isToolComplete: false,
                isStreaming: true,
              }
              segments.push(currentSegment)
              throttledSendSegments()
            },
            onToolResult: (result: any) => {
              if (currentSegment && currentSegment.type === 'tool_call') {
                currentSegment.toolResult = typeof result === 'string' ? result : JSON.stringify(result)
                currentSegment.isToolComplete = true
                currentSegment.isStreaming = false
              }
              currentSegment = null
              throttledSendSegments()
            },
            onDone: () => {
              if (currentSegment) {
                currentSegment.isStreaming = false
              }
              for (const seg of segments) {
                if (seg.type === 'thinking') {
                  seg.collapsed = true
                }
              }
              this.sendSegmentsToRenderer(executionId, segments, false)
              resolve(accumulated)
            },
            onError: (error: string) => {
              if (currentSegment) {
                currentSegment.isStreaming = false
              }
              this.sendSegmentsToRenderer(executionId, segments, false)
              reject(new Error(error))
            },
          },
          abortController.signal
        )
      })

      const durationMs = Date.now() - startTime
      const completedAt = Math.floor(Date.now() / 1000)
      this.db.getDb().prepare(
        `UPDATE employee_task_executions SET status = 'completed', result_text = ?, segments_json = ?, completed_at = ?, duration_ms = ? WHERE id = ?`
      ).run(resultText, JSON.stringify(segments), completedAt, durationMs, executionId)
      this.sendStatusToRenderer(executionId, 'completed')
    } catch (error: any) {
      const durationMs = Date.now() - startTime
      const completedAt = Math.floor(Date.now() / 1000)
      errorMsg = error.message || String(error)

      const status = abortController.signal.aborted && errorMsg !== 'Employee is not active' ? 'timeout' : 'failed'
      this.db.getDb().prepare(
        `UPDATE employee_task_executions SET status = ?, error_message = ?, segments_json = ?, completed_at = ?, duration_ms = ? WHERE id = ?`
      ).run(status, errorMsg, segments.length > 0 ? JSON.stringify(segments) : null, completedAt, durationMs, executionId)
      this.sendStatusToRenderer(executionId, status, errorMsg)
    } finally {
      clearTimeout(timeout)
      this.activeExecutions.delete(executionId)
    }

    if (scheduleId) {
      const nowUnix = Math.floor(Date.now() / 1000)
      this.db.getDb().prepare(
        'UPDATE employee_schedules SET last_run_at = ? WHERE id = ?'
      ).run(nowUnix, scheduleId)
    }

    if (task.run_mode === 'once') {
      this.updateTask(taskId, { is_enabled: false })
    }

    const shouldNotify = notifyOnComplete !== false
    if (shouldNotify) {
      try {
        const execution = this.getExecution(executionId)!
        const notification: TaskCompletionNotification = {
          executionId: execution.id,
          taskId: task.id,
          taskName: task.name,
          employeeId: task.employee_id,
          employeeName: employee.name || '',
          scheduleId: scheduleId || null,
          scheduleName: scheduleName || null,
          status: (execution.status === 'running' ? 'completed' : execution.status) as 'completed' | 'failed' | 'timeout',
          triggerType,
          durationMs: execution.duration_ms,
          resultPreview: execution.result_text ? execution.result_text.slice(0, 200) : null,
          errorMessage: execution.error_message,
          completedAt: execution.completed_at || Math.floor(Date.now() / 1000),
        }
        TaskNotificationService.getInstance().notifyTaskCompletion(notification)
      } catch (notifyError: any) {
        console.error('[EmployeeTaskService] Failed to send notification:', notifyError.message)
      }
    }
  }

  abortExecution(executionId: string): boolean {
    const controller = this.activeExecutions.get(executionId)
    if (controller) {
      controller.abort()
      return true
    }
    return false
  }

  isExecutionActive(executionId: string): boolean {
    return this.activeExecutions.has(executionId)
  }

  getActiveExecutionIds(): string[] {
    return Array.from(this.activeExecutions.keys())
  }

  updateExecutionSegments(executionId: string, segmentsJson: string): void {
    this.db.getDb().prepare(
      'UPDATE employee_task_executions SET segments_json = ? WHERE id = ?'
    ).run(segmentsJson, executionId)
  }
}

export default EmployeeTaskService
export type { EmployeeTask, EmployeeSchedule, TaskExecution, MessageSegment }
