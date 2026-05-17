import { BrowserWindow, Notification as ElectronNotification } from 'electron'

export interface TaskCompletionNotification {
  executionId: string
  taskId: string
  taskName: string
  employeeId: string
  employeeName: string
  scheduleId: string | null
  scheduleName: string | null
  status: 'completed' | 'failed' | 'timeout'
  triggerType: 'manual' | 'scheduled'
  durationMs: number | null
  resultPreview: string | null
  errorMessage: string | null
  completedAt: number
}

class TaskNotificationService {
  private static instance: TaskNotificationService

  private constructor() {}

  static getInstance(): TaskNotificationService {
    if (!TaskNotificationService.instance) {
      TaskNotificationService.instance = new TaskNotificationService()
    }
    return TaskNotificationService.instance
  }

  notifyTaskCompletion(notification: TaskCompletionNotification): void {
    this.sendToRenderer(notification)
    this.sendOSNotification(notification)
  }

  private sendToRenderer(notification: TaskCompletionNotification): void {
    const window = BrowserWindow.getAllWindows()[0]
    if (window && !window.isDestroyed()) {
      window.webContents.send('task-notification:completion', notification)
    }
  }

  private sendOSNotification(notification: TaskCompletionNotification): void {
    const window = BrowserWindow.getAllWindows()[0]
    if (window && !window.isDestroyed() && !window.isMinimized() && window.isFocused()) {
      return
    }

    if (!ElectronNotification.isSupported()) return

    const statusEmoji = notification.status === 'completed' ? '✅' : '❌'
    const title = `${statusEmoji} ${notification.employeeName} - ${notification.taskName}`

    let body = ''
    if (notification.status === 'completed') {
      const duration = notification.durationMs
        ? ` (${(notification.durationMs / 1000).toFixed(1)}s)`
        : ''
      body = notification.resultPreview
        ? `${notification.resultPreview.slice(0, 100)}${notification.resultPreview.length > 100 ? '...' : ''}${duration}`
        : `Task completed${duration}`
    } else {
      body = notification.errorMessage
        ? notification.errorMessage.slice(0, 150)
        : `Task ${notification.status}`
    }

    const osNotification = new ElectronNotification({
      title,
      body,
      silent: false,
    })

    osNotification.on('click', () => {
      if (window) {
        if (window.isMinimized()) window.restore()
        window.show()
        window.focus()
        window.webContents.send('task-notification:click', {
          executionId: notification.executionId,
          taskId: notification.taskId,
          employeeId: notification.employeeId,
        })
      }
    })

    osNotification.show()
  }
}

export default TaskNotificationService
