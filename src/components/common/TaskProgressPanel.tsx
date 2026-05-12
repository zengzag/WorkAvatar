import { useState, useEffect } from 'react'
import { Button, Space, Typography, Progress, Tag, Popover, Empty, theme } from 'antd'
import {
  ClockCircleOutlined,
  SyncOutlined,
  CheckCircleOutlined,
  CloseCircleOutlined,
  LoadingOutlined,
  PauseCircleOutlined,
  CaretRightOutlined,
  PauseOutlined,
  StopOutlined,
  FieldTimeOutlined,
  EyeOutlined,
  BookOutlined,
} from '@ant-design/icons'
import { useTranslation } from 'react-i18next'
import { useNavigate } from 'react-router-dom'
import { useTaskDetailStore } from '../../stores/task-detail.store'

const { Text } = Typography

export interface BackgroundTask {
  id: string
  type: string
  title: string
  status: 'pending' | 'running' | 'paused' | 'completed' | 'failed' | 'cancelled'
  progress: number
  progressText: string
  error?: string
  createdAt: number
  stage?: string
  detail?: string
  speed?: number
  eta?: number
  metadata?: Record<string, any>
}

const TaskProgressPanel: React.FC = () => {
  const [tasks, setTasks] = useState<BackgroundTask[]>([])
  const { token } = theme.useToken()
  const { t } = useTranslation()
  const navigate = useNavigate()
  const openDetail = useTaskDetailStore((s) => s.openDetail)

  useEffect(() => {
    const load = async () => {
      try {
        const result = await window.electronAPI.tasks.getAll()
        setTasks(result)
      } catch {}
    }
    load()

    const cleanup = window.electronAPI.tasks.onTasksUpdated((updatedTasks) => {
      setTasks(updatedTasks)
    })

    return () => cleanup()
  }, [])

  const activeCount = tasks.filter(t => t.status === 'running').length
  const pendingCount = tasks.filter(t => t.status === 'pending').length
  const pausedCount = tasks.filter(t => t.status === 'paused').length
  const failedCount = tasks.filter(t => t.status === 'failed').length
  const hasActive = activeCount + pendingCount + pausedCount > 0

  if (tasks.length === 0) return null

  const getStatusIcon = (status: string) => {
    switch (status) {
      case 'pending': return <ClockCircleOutlined style={{ color: token.colorWarning }} />
      case 'running': return <LoadingOutlined style={{ color: token.colorPrimary }} />
      case 'paused': return <PauseCircleOutlined style={{ color: token.colorWarning }} />
      case 'completed': return <CheckCircleOutlined style={{ color: token.colorSuccess }} />
      case 'failed': return <CloseCircleOutlined style={{ color: token.colorError }} />
      case 'cancelled': return <CloseCircleOutlined style={{ color: token.colorTextQuaternary }} />
      default: return null
    }
  }

  const getStatusText = (status: string) => {
    switch (status) {
      case 'pending': return t('taskProgress.pending')
      case 'running': return t('taskProgress.running')
      case 'paused': return t('parseProgress.paused')
      case 'completed': return t('taskProgress.completed')
      case 'failed': return t('taskProgress.failed')
      case 'cancelled': return t('taskProgress.cancelled')
      default: return status
    }
  }

  const formatEta = (eta?: number) => {
    if (!eta || eta <= 0) return ''
    if (eta < 60) return t('parseProgress.seconds', { count: Math.round(eta) })
    if (eta < 3600) return t('parseProgress.minutes', { count: Math.round(eta / 60) })
    return t('parseProgress.hours', { count: Math.round(eta / 3600) })
  }

  const handleClearCompleted = () => {
    window.electronAPI.tasks.clearCompleted()
  }

  const handlePause = (taskId: string) => {
    window.electronAPI.tasks.pause(taskId)
  }

  const handleResume = (taskId: string) => {
    window.electronAPI.tasks.resume(taskId)
  }

  const handleCancel = (taskId: string) => {
    window.electronAPI.tasks.cancel(taskId)
  }

  const handleViewDetail = (task: BackgroundTask) => {
    if (task.metadata?.docId) {
      openDetail(task.metadata.docId, task.title)
    }
  }

  const handleNavigateToKB = (task: BackgroundTask) => {
    if (task.metadata?.kbId) {
      navigate('/knowledge-base')
    }
  }

  const canViewDetail = (task: BackgroundTask) => {
    return (task.type === 'parse' && task.metadata?.docId) &&
      (task.status === 'running' || task.status === 'paused' || task.status === 'completed' || task.status === 'failed')
  }

  const canNavigateToKB = (task: BackgroundTask) => {
    return (task.type === 'process' && task.metadata?.kbId) &&
      (task.status === 'running' || task.status === 'paused' || task.status === 'completed' || task.status === 'failed')
  }

  const taskListContent = tasks.length > 0 ? (
    <div style={{ maxWidth: 420, maxHeight: 450, overflow: 'auto' }}>
      <div style={{ marginBottom: 8, display: 'flex', justifyContent: 'flex-end' }}>
        <Button type="link" size="small" onClick={handleClearCompleted}>{t('taskProgress.clearCompleted')}</Button>
      </div>
      {tasks.map(task => (
        <div key={task.id} style={{ padding: '8px 0', borderBottom: `1px solid ${token.colorBorderSecondary}` }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
            <Space size={4} style={{ flex: 1, minWidth: 0, overflow: 'hidden' }}>
              {getStatusIcon(task.status)}
              <Text style={{ fontSize: 13 }} ellipsis>{task.title}</Text>
            </Space>
            <Space size={4} style={{ flexShrink: 0 }}>
              {canViewDetail(task) && (
                <Button type="text" size="small" icon={<EyeOutlined />} onClick={() => handleViewDetail(task)} title={t('parseProgress.detail')} />
              )}
              {canNavigateToKB(task) && (
                <Button type="text" size="small" icon={<BookOutlined />} onClick={() => handleNavigateToKB(task)} title={t('taskProgress.goToKB')} />
              )}
              {(task.status === 'running' || task.status === 'pending') && (
                <Button type="text" size="small" icon={<PauseOutlined />} onClick={() => handlePause(task.id)} title={t('parseProgress.pause')} />
              )}
              {(task.status === 'running' || task.status === 'pending' || task.status === 'paused') && (
                <Button type="text" size="small" danger icon={<StopOutlined />} onClick={() => handleCancel(task.id)} title={t('parseProgress.cancel')} />
              )}
              {task.status === 'paused' && (
                <Button type="text" size="small" icon={<CaretRightOutlined />} onClick={() => handleResume(task.id)} title={t('parseProgress.resume')} style={{ color: token.colorSuccess }} />
              )}
              <Tag style={{ fontSize: 11 }} color={task.status === 'failed' ? 'red' : task.status === 'paused' ? 'gold' : task.status === 'completed' ? 'green' : 'default'}>
                {getStatusText(task.status)}
              </Tag>
            </Space>
          </div>
          <Text type="secondary" style={{ fontSize: 11 }}>{task.progressText}</Text>
          {task.progress > 0 && task.progress < 100 && (
            <Progress
              percent={task.progress}
              size="small"
              showInfo
              status={task.status === 'paused' ? 'normal' : 'active'}
              strokeColor={task.status === 'paused' ? token.colorWarning : undefined}
            />
          )}
          {task.eta && task.eta > 0 && task.status === 'running' && (
            <Text type="secondary" style={{ fontSize: 11, marginLeft: 4 }}>
              {t('parseProgress.eta')}: {formatEta(task.eta)}
            </Text>
          )}
          {task.error && (
            <Text type="danger" style={{ fontSize: 11, display: 'block', marginTop: 2 }}>{t('taskProgress.errorLabel')} {task.error}</Text>
          )}
        </div>
      ))}
    </div>
  ) : (
    <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t('taskProgress.noTasks')} style={{ margin: '8px 0' }} />
  )

  const triggerContent = hasActive ? (
    <Space size={4} wrap>
      <FieldTimeOutlined style={{ color: token.colorPrimary }} />
      {activeCount > 0 && <Tag color="blue" icon={<SyncOutlined spin />} style={{ fontSize: 10, lineHeight: '16px', padding: '0 4px', marginRight: 0 }}>{activeCount}</Tag>}
      {pausedCount > 0 && <Tag color="gold" icon={<PauseCircleOutlined />} style={{ fontSize: 10, lineHeight: '16px', padding: '0 4px', marginRight: 0 }}>{pausedCount}</Tag>}
      {failedCount > 0 && <Tag color="red" style={{ fontSize: 10, lineHeight: '16px', padding: '0 4px', marginRight: 0 }}>{failedCount}</Tag>}
    </Space>
  ) : (
    <Space size={4}>
      <FieldTimeOutlined style={{ color: token.colorTextQuaternary }} />
    </Space>
  )

  return (
    <Popover
      content={taskListContent}
      title={<Text strong style={{ fontSize: 13 }}>{t('taskProgress.panelTitle')}</Text>}
      trigger="click"
      placement="topRight"
    >
      <div style={{
        padding: '6px 10px',
        display: 'flex',
        alignItems: 'center',
        gap: 6,
        cursor: 'pointer',
        borderRadius: 6,
        transition: 'background 0.2s',
      }}>
        {triggerContent}
      </div>
    </Popover>
  )
}

export default TaskProgressPanel
