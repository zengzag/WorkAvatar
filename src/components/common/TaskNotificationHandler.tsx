import { useEffect, useCallback, useRef } from 'react'
import { App, theme } from 'antd'
import { useTranslation } from 'react-i18next'
import {
  CheckCircleOutlined,
  CloseCircleOutlined,
  ExclamationCircleOutlined,
} from '@ant-design/icons'
import { useNavigate } from 'react-router-dom'
import { useAppearanceStore } from '../../stores/appearance.store'

interface TaskCompletionNotification {
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

const TaskNotificationHandler: React.FC = () => {
  const { notification } = App.useApp()
  const { t } = useTranslation()
  const { token } = theme.useToken()
  const navigate = useNavigate()
  const taskNotifications = useAppearanceStore((s) => s.taskNotifications)
  const pendingClickRef = useRef<{ executionId: string; taskId: string; employeeId: string } | null>(null)

  const handleNotificationClick = useCallback((data: { executionId: string; taskId: string; employeeId: string }) => {
    pendingClickRef.current = data
    navigate('/task-center')
  }, [navigate])

  useEffect(() => {
    const unsubCompletion = window.electronAPI.employeeTask.onTaskCompletion(
      (notif: TaskCompletionNotification) => {
        if (!taskNotifications) return

        const isSuccess = notif.status === 'completed'
        const duration = notif.durationMs
          ? ` ${(notif.durationMs / 1000).toFixed(1)}s`
          : ''

        const icon = isSuccess
          ? <CheckCircleOutlined style={{ color: token.colorSuccess }} />
          : notif.status === 'timeout'
            ? <ExclamationCircleOutlined style={{ color: token.colorWarning }} />
            : <CloseCircleOutlined style={{ color: token.colorError }} />

        const title = isSuccess
          ? t('taskNotification.completedTitle', { employee: notif.employeeName, task: notif.taskName })
          : t('taskNotification.failedTitle', { employee: notif.employeeName, task: notif.taskName })

        let description = ''
        if (isSuccess) {
          description = notif.resultPreview
            ? notif.resultPreview.slice(0, 120) + (notif.resultPreview.length > 120 ? '...' : '') + duration
            : t('taskNotification.completedMessage') + duration
        } else {
          description = notif.errorMessage
            ? notif.errorMessage.slice(0, 150)
            : t('taskNotification.failedMessage', { status: notif.status })
        }

        notification.open({
          key: notif.executionId,
          message: title,
          description,
          icon,
          duration: isSuccess ? 6 : 0,
          placement: 'bottomRight',
          onClick: () => {
            navigate('/task-center')
          },
          style: { cursor: 'pointer', maxWidth: 420 },
        })
      }
    )

    const unsubClick = window.electronAPI.employeeTask.onNotificationClick(handleNotificationClick)

    return () => {
      unsubCompletion()
      unsubClick()
    }
  }, [notification, t, navigate, handleNotificationClick, taskNotifications])

  return null
}

export default TaskNotificationHandler
