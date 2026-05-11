import { ipcMain } from 'electron'
import { IPC_CHANNELS } from '../../shared/ipc-channels'
import TaskQueueService from '../services/task-queue.service'

export function registerTaskHandlers() {
  const taskService = TaskQueueService.getInstance()

  ipcMain.handle(IPC_CHANNELS.TASK_GET_ALL, () => {
    return taskService.getAllTasks()
  })

  ipcMain.handle(IPC_CHANNELS.TASK_CLEAR_COMPLETED, () => {
    taskService.clearCompleted()
    return true
  })

  ipcMain.handle(IPC_CHANNELS.TASK_CANCEL, (_, taskId: string) => {
    taskService.updateTask(taskId, { status: 'cancelled' })
    return true
  })
}
