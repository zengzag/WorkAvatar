import { ipcMain } from 'electron'
import { IPC_CHANNELS } from '../../shared/ipc-channels'
import TaskQueueService from '../services/task-queue.service'
import KnowledgeBaseService from '../services/kb.service'

export function registerTaskHandlers() {
  const taskService = TaskQueueService.getInstance()
  const kbService = KnowledgeBaseService.getInstance()

  ipcMain.handle(IPC_CHANNELS.TASK_GET_ALL, () => {
    return taskService.getAllTasks()
  })

  ipcMain.handle(IPC_CHANNELS.TASK_CLEAR_COMPLETED, () => {
    taskService.clearCompleted()
    return true
  })

  ipcMain.handle(IPC_CHANNELS.TASK_CANCEL, (_, taskId: string) => {
    return taskService.cancelTask(taskId)
  })

  ipcMain.handle(IPC_CHANNELS.TASK_PAUSE, (_, taskId: string) => {
    return taskService.pauseTask(taskId)
  })

  ipcMain.handle(IPC_CHANNELS.TASK_RESUME, (_, taskId: string) => {
    const task = taskService.getTask(taskId)
    if (!task) return false

    const resumed = taskService.resumeTask(taskId)
    if (!resumed) return false

    if (task.type === 'parse' && task.metadata?.docId) {
      kbService.resumeParse(task.metadata.docId)
    } else if (task.type === 'process' && task.metadata?.docId) {
      kbService.processDocument(
        task.metadata.docId,
        task.metadata.providerId,
        task.metadata.modelId,
        task.metadata.enableThinking,
      ).catch(() => {})
    }

    return true
  })

  ipcMain.handle(IPC_CHANNELS.TASK_PAUSE_ALL, (_, type?: string) => {
    if (type) return taskService.pauseAllByType(type)
    let count = 0
    for (const [id, task] of taskService.getAllTasks().map(t => [t.id, t] as const)) {
      if (task.status === 'running' || task.status === 'pending') {
        if (taskService.pauseTask(id)) count++
      }
    }
    return count
  })

  ipcMain.handle(IPC_CHANNELS.TASK_RESUME_ALL, (_, type?: string) => {
    if (type) {
      const count = taskService.resumeAllByType(type)
      const tasks = taskService.getAllTasks()
      for (const task of tasks) {
        if (task.type === type && task.status === 'running') {
          if (task.type === 'parse' && task.metadata?.docId) {
            kbService.resumeParse(task.metadata.docId)
          } else if (task.type === 'process' && task.metadata?.docId) {
            kbService.processDocument(
              task.metadata.docId,
              task.metadata.providerId,
              task.metadata.modelId,
              task.metadata.enableThinking,
            ).catch(() => {})
          }
        }
      }
      return count
    }
    let count = 0
    for (const [id, task] of taskService.getAllTasks().map(t => [t.id, t] as const)) {
      if (task.status === 'paused') {
        if (taskService.resumeTask(id)) count++
      }
    }
    return count
  })

  ipcMain.handle(IPC_CHANNELS.TASK_CANCEL_ALL, (_, type?: string) => {
    if (type) return taskService.cancelAllByType(type)
    let count = 0
    for (const [id, task] of taskService.getAllTasks().map(t => [t.id, t] as const)) {
      if (task.status === 'running' || task.status === 'pending' || task.status === 'paused') {
        if (taskService.cancelTask(id)) count++
      }
    }
    return count
  })
}
