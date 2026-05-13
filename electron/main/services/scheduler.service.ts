import EmployeeTaskService from './employee-task.service'
import DatabaseService from './database.service'

interface ParsedCron {
  minute: number[] | '*'
  hour: number[] | '*'
  dayOfMonth: number[] | '*'
  month: number[] | '*'
  dayOfWeek: number[] | '*'
}

function parseCronField(field: string, min: number, max: number): number[] | '*' {
  if (field === '*') return '*'
  const result: number[] = []
  const parts = field.split(',')
  for (const part of parts) {
    if (part.includes('/')) {
      const [range, stepStr] = part.split('/')
      const step = parseInt(stepStr, 10)
      let start = min
      let end = max
      if (range !== '*') {
        if (range.includes('-')) {
          const [s, e] = range.split('-')
          start = parseInt(s, 10)
          end = parseInt(e, 10)
        } else {
          start = parseInt(range, 10)
        }
      }
      for (let i = start; i <= end; i += step) {
        result.push(i)
      }
    } else if (part.includes('-')) {
      const [start, end] = part.split('-')
      for (let i = parseInt(start, 10); i <= parseInt(end, 10); i++) {
        result.push(i)
      }
    } else {
      result.push(parseInt(part, 10))
    }
  }
  return [...new Set(result)].sort((a, b) => a - b)
}

function parseCronExpression(expr: string): ParsedCron | null {
  const parts = expr.trim().split(/\s+/)
  if (parts.length !== 5) return null
  return {
    minute: parseCronField(parts[0], 0, 59),
    hour: parseCronField(parts[1], 0, 23),
    dayOfMonth: parseCronField(parts[2], 1, 31),
    month: parseCronField(parts[3], 1, 12),
    dayOfWeek: parseCronField(parts[4], 0, 6),
  }
}

function matchesField(field: number[] | '*', value: number): boolean {
  if (field === '*') return true
  return field.includes(value)
}

function matchesCron(parsed: ParsedCron, date: Date): boolean {
  return (
    matchesField(parsed.minute, date.getMinutes()) &&
    matchesField(parsed.hour, date.getHours()) &&
    matchesField(parsed.dayOfMonth, date.getDate()) &&
    matchesField(parsed.month, date.getMonth() + 1) &&
    matchesField(parsed.dayOfWeek, date.getDay())
  )
}

function getNextRunTime(cronExpr: string, from?: Date): Date | null {
  const parsed = parseCronExpression(cronExpr)
  if (!parsed) return null
  const start = from || new Date()
  const candidate = new Date(start.getTime())
  candidate.setSeconds(0, 0)
  candidate.setMinutes(candidate.getMinutes() + 1)

  for (let i = 0; i < 366 * 24 * 60; i++) {
    if (matchesCron(parsed, candidate)) {
      return candidate
    }
    candidate.setMinutes(candidate.getMinutes() + 1)
  }
  return null
}

class SchedulerService {
  private db: DatabaseService
  private taskService: EmployeeTaskService
  private timer: NodeJS.Timeout | null = null
  private static instance: SchedulerService
  private lastCheckedMinute: number = -1

  private constructor() {
    this.db = DatabaseService.getInstance()
    this.taskService = EmployeeTaskService.getInstance()
  }

  static getInstance(): SchedulerService {
    if (!SchedulerService.instance) {
      SchedulerService.instance = new SchedulerService()
    }
    return SchedulerService.instance
  }

  start(): void {
    if (this.timer) return
    console.log('[Scheduler] Starting scheduler service...')
    this.timer = setInterval(() => this.tick(), 1000)
    this.updateNextRunTimes()
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
      console.log('[Scheduler] Stopped scheduler service')
    }
  }

  private tick(): void {
    const now = new Date()
    const currentMinute = now.getHours() * 60 + now.getMinutes()
    if (now.getSeconds() !== 0) return
    if (currentMinute === this.lastCheckedMinute) return
    this.lastCheckedMinute = currentMinute

    this.checkSchedules(now)
  }

  private async checkSchedules(now: Date): Promise<void> {
    const schedules = this.taskService.getAllEnabledSchedules()
    for (const schedule of schedules) {
      try {
        const employee = this.db.getDb().prepare('SELECT status FROM employees WHERE id = ?').get(schedule.employee_id) as any
        if (!employee || employee.status !== 'active') continue

        const parsed = parseCronExpression(schedule.cron_expr)
        if (!parsed) continue

        if (matchesCron(parsed, now)) {
          await this.executeSchedule(schedule)
        }
      } catch (error) {
        console.error(`[Scheduler] Error checking schedule ${schedule.id}:`, error)
      }
    }
  }

  private async executeSchedule(schedule: { id: string; employee_id: string; task_ids_json: string; run_mode?: 'recurring' | 'once' }): Promise<void> {
    let taskIds: string[] = []
    try {
      taskIds = JSON.parse(schedule.task_ids_json)
    } catch {
      console.error(`[Scheduler] Invalid task_ids_json for schedule ${schedule.id}`)
      return
    }

    for (const taskId of taskIds) {
      try {
        await this.taskService.executeTask(taskId, 'scheduled', schedule.id)
      } catch (error: any) {
        console.error(`[Scheduler] Error executing task ${taskId} for schedule ${schedule.id}:`, error.message)
      }
    }

    // 如果是单次执行，执行完后禁用该定时任务
    if (schedule.run_mode === 'once') {
      try {
        this.taskService.updateSchedule(schedule.id, { is_enabled: false })
        this.updateNextRunTimes()
      } catch (error: any) {
        console.error(`[Scheduler] Error disabling one-time schedule ${schedule.id}:`, error.message)
      }
    }
  }

  updateNextRunTimes(): void {
    const schedules = this.taskService.getAllEnabledSchedules()
    const stmt = this.db.getDb().prepare('UPDATE employee_schedules SET next_run_at = ? WHERE id = ?')
    for (const schedule of schedules) {
      const next = getNextRunTime(schedule.cron_expr)
      if (next) {
        stmt.run(Math.floor(next.getTime() / 1000), schedule.id)
      }
    }
  }

  getNextRunTime(cronExpr: string): Date | null {
    return getNextRunTime(cronExpr)
  }

  validateCronExpression(expr: string): { valid: boolean; error?: string; nextRun?: string } {
    const parsed = parseCronExpression(expr)
    if (!parsed) return { valid: false, error: 'Invalid cron expression format. Expected 5 fields: minute hour dayOfMonth month dayOfWeek' }
    const next = getNextRunTime(expr)
    return {
      valid: true,
      nextRun: next ? next.toISOString() : undefined,
    }
  }
}

export default SchedulerService
