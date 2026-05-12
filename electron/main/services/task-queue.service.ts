import { BrowserWindow } from 'electron'
import { IPC_CHANNELS } from '../../shared/ipc-channels'
import DatabaseService from './database.service'

export interface BackgroundTask {
  id: string
  type: string
  title: string
  status: 'pending' | 'running' | 'paused' | 'completed' | 'failed' | 'cancelled'
  progress: number
  progressText: string
  error?: string
  metadata?: Record<string, any>
  createdAt: number
  pausedAt?: number
  resumedAt?: number
  speed?: number
  eta?: number
  stage?: string
  detail?: string
}

class TaskQueueService {
  private tasks: Map<string, BackgroundTask> = new Map()
  private pauseControllers: Map<string, { paused: boolean; abortController?: AbortController }> = new Map()
  private db: DatabaseService
  private static instance: TaskQueueService

  private constructor() {
    this.db = DatabaseService.getInstance()
    this.loadTasksFromDB()
  }

  static getInstance(): TaskQueueService {
    if (!TaskQueueService.instance) {
      TaskQueueService.instance = new TaskQueueService()
    }
    return TaskQueueService.instance
  }

  private loadTasksFromDB() {
    try {
      const rows = this.db.getDb().prepare(
        'SELECT * FROM background_tasks ORDER BY created_at DESC'
      ).all() as any[]

      for (const row of rows) {
        let metadata = {}
        try {
          metadata = JSON.parse(row.metadata_json || '{}')
        } catch {}

        const task: BackgroundTask = {
          id: row.id,
          type: row.type,
          title: row.title,
          status: row.status,
          progress: row.progress,
          progressText: row.progress_text || '',
          error: row.error || undefined,
          metadata,
          createdAt: row.created_at,
          pausedAt: row.paused_at || undefined,
          resumedAt: row.resumed_at || undefined,
          speed: row.speed || undefined,
          eta: row.eta || undefined,
          stage: row.stage || undefined,
          detail: row.detail || undefined,
        }
        this.tasks.set(task.id, task)
      }

      if (rows.length > 0) {
        console.log(`[TaskQueue] Loaded ${rows.length} task(s) from database`)
      }
    } catch (err) {
      console.error('[TaskQueue] Failed to load tasks from database:', err)
    }
  }

  private saveTaskToDB(task: BackgroundTask) {
    try {
      this.db.getDb().prepare(`
        INSERT OR REPLACE INTO background_tasks
          (id, type, title, status, progress, progress_text, error, metadata_json, created_at, paused_at, resumed_at, speed, eta, stage, detail)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        task.id,
        task.type,
        task.title,
        task.status,
        task.progress,
        task.progressText,
        task.error || null,
        JSON.stringify(task.metadata || {}),
        task.createdAt,
        task.pausedAt || null,
        task.resumedAt || null,
        task.speed || null,
        task.eta || null,
        task.stage || null,
        task.detail || null,
      )
    } catch (err) {
      console.error('[TaskQueue] Failed to save task to database:', err)
    }
  }

  private deleteTaskFromDB(taskId: string) {
    try {
      this.db.getDb().prepare('DELETE FROM background_tasks WHERE id = ?').run(taskId)
    } catch (err) {
      console.error('[TaskQueue] Failed to delete task from database:', err)
    }
  }

  private notifyTasksUpdated() {
    const tasks = this.getAllTasks()
    const window = BrowserWindow.getAllWindows()[0]
    if (window && !window.isDestroyed()) {
      window.webContents.send(IPC_CHANNELS.TASK_UPDATED, tasks)
    }
  }

  addTask(task: BackgroundTask): string {
    const newTask = { ...task, createdAt: task.createdAt || Date.now() }
    this.tasks.set(newTask.id, newTask)
    this.saveTaskToDB(newTask)
    this.notifyTasksUpdated()
    return newTask.id
  }

  updateTask(taskId: string, updates: Partial<BackgroundTask>) {
    const task = this.tasks.get(taskId)
    if (task) {
      const updatedTask = { ...task, ...updates }
      this.tasks.set(taskId, updatedTask)
      this.saveTaskToDB(updatedTask)
      this.notifyTasksUpdated()
    }
  }

  removeTask(taskId: string) {
    this.tasks.delete(taskId)
    this.pauseControllers.delete(taskId)
    this.deleteTaskFromDB(taskId)
    this.notifyTasksUpdated()
  }

  getAllTasks(): BackgroundTask[] {
    return Array.from(this.tasks.values()).sort((a, b) => b.createdAt - a.createdAt)
  }

  getTask(taskId: string): BackgroundTask | undefined {
    return this.tasks.get(taskId)
  }

  pauseTask(taskId: string): boolean {
    const task = this.tasks.get(taskId)
    if (!task || (task.status !== 'running' && task.status !== 'pending')) return false

    const controller = this.pauseControllers.get(taskId)
    if (controller) {
      controller.paused = true
    } else {
      this.pauseControllers.set(taskId, { paused: true })
    }

    const updatedTask: BackgroundTask = {
      ...task,
      status: 'paused',
      pausedAt: Date.now(),
    }
    this.tasks.set(taskId, updatedTask)
    this.saveTaskToDB(updatedTask)
    this.notifyTasksUpdated()
    return true
  }

  resumeTask(taskId: string): boolean {
    const task = this.tasks.get(taskId)
    if (!task || task.status !== 'paused') return false

    const controller = this.pauseControllers.get(taskId)
    if (controller) {
      controller.paused = false
    } else {
      this.pauseControllers.set(taskId, { paused: false })
    }

    const updatedTask: BackgroundTask = {
      ...task,
      status: 'running',
      resumedAt: Date.now(),
    }
    this.tasks.set(taskId, updatedTask)
    this.saveTaskToDB(updatedTask)
    this.notifyTasksUpdated()
    return true
  }

  cancelTask(taskId: string): boolean {
    const task = this.tasks.get(taskId)
    if (!task) return false

    const controller = this.pauseControllers.get(taskId)
    if (controller?.abortController) {
      controller.abortController.abort()
    }

    const updatedTask: BackgroundTask = { ...task, status: 'cancelled' }
    this.tasks.set(taskId, updatedTask)
    this.saveTaskToDB(updatedTask)
    this.pauseControllers.delete(taskId)
    this.notifyTasksUpdated()
    return true
  }

  isTaskPaused(taskId: string): boolean {
    return this.pauseControllers.get(taskId)?.paused === true
  }

  getPauseController(taskId: string): { paused: boolean; abortController?: AbortController } | undefined {
    return this.pauseControllers.get(taskId)
  }

  setAbortController(taskId: string, abortController: AbortController) {
    const controller = this.pauseControllers.get(taskId)
    if (controller) {
      controller.abortController = abortController
    } else {
      this.pauseControllers.set(taskId, { paused: false, abortController })
    }
  }

  pauseAllByType(type: string): number {
    let count = 0
    for (const [id, task] of this.tasks) {
      if (task.type === type && (task.status === 'running' || task.status === 'pending')) {
        this.pauseTask(id)
        count++
      }
    }
    return count
  }

  resumeAllByType(type: string): number {
    let count = 0
    for (const [id, task] of this.tasks) {
      if (task.type === type && task.status === 'paused') {
        this.resumeTask(id)
        count++
      }
    }
    return count
  }

  cancelAllByType(type: string): number {
    let count = 0
    for (const [id, task] of this.tasks) {
      if (task.type === type && (task.status === 'running' || task.status === 'pending' || task.status === 'paused')) {
        this.cancelTask(id)
        count++
      }
    }
    return count
  }

  clearCompleted() {
    for (const [id, task] of this.tasks) {
      if (task.status === 'completed' || task.status === 'failed' || task.status === 'cancelled') {
        this.tasks.delete(id)
        this.pauseControllers.delete(id)
        this.deleteTaskFromDB(id)
      }
    }
    this.notifyTasksUpdated()
  }
}

export default TaskQueueService
