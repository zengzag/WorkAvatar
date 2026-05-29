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
    } else if (task.type === 'process') {
      const controller = taskService.getPauseController(taskId)
      const isHandlerActive = !!controller?.abortController && !controller.abortController.signal.aborted
      if (!isHandlerActive) {
        if (task.metadata?.docId) {
          kbService.processDocument(
            task.metadata.docId,
            task.metadata.providerId,
            task.metadata.modelId,
            task.metadata.enableThinking,
          ).catch(() => {})
        } else if (task.metadata?.kbId && task.id?.startsWith('build-global-')) {
          kbService.buildGlobalKnowledge(
            task.metadata.kbId,
            task.metadata.providerId,
            task.metadata.modelId,
            task.metadata.enableThinking,
          ).catch(() => {})
        }
      }
    }

    return true
  })
}
