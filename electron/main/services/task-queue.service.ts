import { BrowserWindow } from 'electron'

export interface BackgroundTask {
  id: string
  type: string
  title: string
  status: 'pending' | 'running' | 'completed' | 'failed' | 'cancelled'
  progress: number
  progressText: string
  error?: string
  metadata?: Record<string, any>
  createdAt: number
}

class TaskQueueService {
  private tasks: Map<string, BackgroundTask> = new Map()
  private static instance: TaskQueueService

  private constructor() {}

  static getInstance(): TaskQueueService {
    if (!TaskQueueService.instance) {
      TaskQueueService.instance = new TaskQueueService()
    }
    return TaskQueueService.instance
  }

  private notifyTasksUpdated() {
    const tasks = this.getAllTasks()
    const window = BrowserWindow.getAllWindows()[0]
    if (window && !window.isDestroyed()) {
      window.webContents.send('tasks:updated', tasks)
    }
  }

  addTask(task: BackgroundTask): string {
    this.tasks.set(task.id, { ...task, createdAt: task.createdAt || Date.now() })
    this.notifyTasksUpdated()
    return task.id
  }

  updateTask(taskId: string, updates: Partial<BackgroundTask>) {
    const task = this.tasks.get(taskId)
    if (task) {
      this.tasks.set(taskId, { ...task, ...updates })
      this.notifyTasksUpdated()
    }
  }

  removeTask(taskId: string) {
    this.tasks.delete(taskId)
    this.notifyTasksUpdated()
  }

  getAllTasks(): BackgroundTask[] {
    return Array.from(this.tasks.values()).sort((a, b) => b.createdAt - a.createdAt)
  }

  clearCompleted() {
    for (const [id, task] of this.tasks) {
      if (task.status === 'completed' || task.status === 'failed' || task.status === 'cancelled') {
        this.tasks.delete(id)
      }
    }
    this.notifyTasksUpdated()
  }
}

export default TaskQueueService