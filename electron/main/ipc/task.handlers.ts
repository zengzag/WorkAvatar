import { IPC_CHANNELS } from '../../shared/ipc-channels'
import TaskQueueService from '../services/task-queue.service'
import { safeHandle } from './_shared'

export function registerTaskHandlers() {
  const taskService = TaskQueueService.getInstance()

  safeHandle(IPC_CHANNELS.TASK_GET_ALL, () => {
    return taskService.getAllTasks()
  })

  safeHandle(IPC_CHANNELS.TASK_CLEAR_COMPLETED, () => {
    taskService.clearCompleted()
    return true
  })

  safeHandle(IPC_CHANNELS.TASK_CANCEL, (taskId: string) => {
    return taskService.cancelTask(taskId)
  })

  safeHandle(IPC_CHANNELS.TASK_PAUSE, (taskId: string) => {
    return taskService.pauseTask(taskId)
  })

  safeHandle(IPC_CHANNELS.TASK_RESUME, (taskId: string) => {
    return taskService.resumeTask(taskId)
  })
}
