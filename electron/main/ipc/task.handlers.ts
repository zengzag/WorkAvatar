import { ipcMain } from 'electron'
import TaskQueueService from '../services/task-queue.service'

export function registerTaskHandlers() {
  const taskService = TaskQueueService.getInstance()

  ipcMain.handle('tasks:get-all', () => {
    return taskService.getAllTasks()
  })

  ipcMain.handle('tasks:clear-completed', () => {
    taskService.clearCompleted()
    return true
  })

  ipcMain.handle('tasks:cancel', (_, taskId: string) => {
    taskService.updateTask(taskId, { status: 'cancelled' })
    return true
  })
}