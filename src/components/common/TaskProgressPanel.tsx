import { useState, useEffect } from 'react'
import { Button, Space, Typography, Progress, Tag, Popover, Empty, Badge, theme, Tooltip } from 'antd'
import {
  ClockCircleOutlined,
  CheckCircleOutlined,
  CloseCircleOutlined,
  LoadingOutlined,
  PauseCircleOutlined,
  CaretRightOutlined,
  PauseOutlined,
  StopOutlined,
  FieldTimeOutlined,
  ThunderboltOutlined,
  FileSearchOutlined,
  ApartmentOutlined,
} from '@ant-design/icons'
import { useTranslation } from 'react-i18next'

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

const stageLabelMap: Record<string, { icon: React.ReactNode; labelKey: string }> = {
  reading: { icon: <FileSearchOutlined />, labelKey: 'taskProgress.stageReading' },
  parsing: { icon: <FileSearchOutlined />, labelKey: 'taskProgress.stageParsing' },
  chunking: { icon: <FileSearchOutlined />, labelKey: 'taskProgress.stageChunking' },
  saving: { icon: <FileSearchOutlined />, labelKey: 'taskProgress.stageSaving' },
  toc_restore: { icon: <ApartmentOutlined />, labelKey: 'taskProgress.stageTocRestore' },
  paragraph_summary: { icon: <ThunderboltOutlined />, labelKey: 'taskProgress.stageParagraphSummary' },
  paragraph_identify: { icon: <ThunderboltOutlined />, labelKey: 'taskProgress.stageParagraphIdentify' },
  doc_summary: { icon: <ApartmentOutlined />, labelKey: 'taskProgress.stageDocSummary' },
  global_summary: { icon: <ApartmentOutlined />, labelKey: 'taskProgress.stageGlobalSummary' },
  processing_docs: { icon: <ThunderboltOutlined />, labelKey: 'taskProgress.stageProcessingDocs' },
  complete: { icon: <CheckCircleOutlined />, labelKey: 'taskProgress.stageComplete' },
}

const TaskProgressPanel: React.FC = () => {
  const [tasks, setTasks] = useState<BackgroundTask[]>([])
  const { token } = theme.useToken()
  const { t } = useTranslation()

  useEffect(() => {
    const load = async () => {
      try {
        const result = await window.electronAPI.tasks.getAll()
        setTasks(result)
      } catch {}
    }
    load()

    const cleanup = window.electronAPI.tasks.onTasksUpdated((updatedTasks: BackgroundTask[]) => {
      setTasks(updatedTasks)
    })

    return () => cleanup()
  }, [])

  const activeCount = tasks.filter(t => t.status === 'running').length
  const pendingCount = tasks.filter(t => t.status === 'pending').length
  const pausedCount = tasks.filter(t => t.status === 'paused').length
  const failedCount = tasks.filter(t => t.status === 'failed').length
  const totalActiveCount = activeCount + pendingCount

  const getStatusIcon = (status: string) => {
    switch (status) {
      case 'pending': return <ClockCircleOutlined style={{ color: token.colorWarning }} />
      case 'running': return <LoadingOutlined style={{ color: token.colorPrimary }} spin />
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

  const formatSpeed = (speed?: number) => {
    if (!speed || speed <= 0) return ''
    return t('taskProgress.speed', { value: speed.toFixed(1) })
  }

  const formatDuration = (createdAt: number, status: string) => {
    const now = status === 'running' || status === 'pending' || status === 'paused' ? Date.now() : createdAt
    const diff = Math.round((now - createdAt) / 1000)
    if (diff < 60) return t('parseProgress.seconds', { count: diff })
    if (diff < 3600) return t('parseProgress.minutes', { count: Math.round(diff / 60) })
    return t('parseProgress.hours', { count: Math.round(diff / 3600) })
  }

  const getTypeIcon = (type: string) => {
    switch (type) {
      case 'parse': return <FileSearchOutlined style={{ color: token.colorPrimary, fontSize: 12 }} />
      case 'process': return <ThunderboltOutlined style={{ color: '#722ed1', fontSize: 12 }} />
      default: return null
    }
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

  const taskListContent = tasks.length > 0 ? (
    <div style={{ maxWidth: 460, maxHeight: 500, overflow: 'auto' }}>
      <div style={{ marginBottom: 8, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <Space size={8}>
          {activeCount > 0 && <Tag color="blue">{t('taskProgress.runningCount', { count: activeCount })}</Tag>}
          {pausedCount > 0 && <Tag color="gold">{t('taskProgress.pausedCount', { count: pausedCount })}</Tag>}
          {failedCount > 0 && <Tag color="red">{t('taskProgress.failedCount', { count: failedCount })}</Tag>}
        </Space>
        <Button type="link" size="small" onClick={handleClearCompleted}>{t('taskProgress.clearCompleted')}</Button>
      </div>
      {tasks.map(task => {
        const stageInfo = task.stage ? stageLabelMap[task.stage] : null
        return (
          <div key={task.id} style={{
            padding: '8px 4px',
            borderBottom: `1px solid ${token.colorBorderSecondary}`,
            backgroundColor: task.status === 'running' ? `${token.colorPrimaryBg}40` : undefined,
            borderRadius: 4,
            marginBottom: 2,
          }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 2 }}>
              <Space size={4} style={{ flex: 1, minWidth: 0, overflow: 'hidden' }}>
                {getStatusIcon(task.status)}
                {getTypeIcon(task.type)}
                <Text style={{ fontSize: 13, fontWeight: task.status === 'running' ? 500 : 400 }} ellipsis>{task.title}</Text>
              </Space>
              <Space size={4} style={{ flexShrink: 0 }}>
                {(task.status === 'running' || task.status === 'pending') && (
                  <Tooltip title={t('parseProgress.pause')}>
                    <Button type="text" size="small" icon={<PauseOutlined />} onClick={() => handlePause(task.id)} />
                  </Tooltip>
                )}
                {task.status === 'paused' && (
                  <Tooltip title={t('parseProgress.resume')}>
                    <Button type="text" size="small" icon={<CaretRightOutlined />} onClick={() => handleResume(task.id)} style={{ color: token.colorSuccess }} />
                  </Tooltip>
                )}
                {(task.status === 'running' || task.status === 'pending' || task.status === 'paused') && (
                  <Tooltip title={t('parseProgress.cancel')}>
                    <Button type="text" size="small" danger icon={<StopOutlined />} onClick={() => handleCancel(task.id)} />
                  </Tooltip>
                )}
                <Tag style={{ fontSize: 11 }} color={
                  task.status === 'failed' ? 'red' :
                  task.status === 'paused' ? 'gold' :
                  task.status === 'completed' ? 'green' :
                  task.status === 'cancelled' ? 'default' :
                  task.status === 'running' ? 'blue' : 'default'
                }>
                  {getStatusText(task.status)}
                </Tag>
              </Space>
            </div>

            {task.progressText && (
              <div style={{ marginBottom: 2 }}>
                <Text type="secondary" style={{ fontSize: 11 }}>{task.progressText}</Text>
              </div>
            )}

            {stageInfo && (task.status === 'running' || task.status === 'paused') && (
              <div style={{ marginBottom: 2 }}>
                <Space size={4}>
                  {stageInfo.icon}
                  <Text type="secondary" style={{ fontSize: 11 }}>{t(stageInfo.labelKey)}</Text>
                  {task.detail && <Text type="secondary" style={{ fontSize: 11 }}>- {task.detail}</Text>}
                </Space>
              </div>
            )}

            {task.progress > 0 && task.progress < 100 && (
              <Progress
                percent={task.progress}
                size="small"
                showInfo
                status={task.status === 'paused' ? 'normal' : task.status === 'failed' ? 'exception' : 'active'}
                strokeColor={task.status === 'paused' ? token.colorWarning : undefined}
              />
            )}

            <div style={{ display: 'flex', gap: 8, marginTop: 2 }}>
              {task.speed && task.speed > 0 && task.status === 'running' && (
                <Text type="secondary" style={{ fontSize: 10 }}>{formatSpeed(task.speed)}</Text>
              )}
              {task.eta && task.eta > 0 && task.status === 'running' && (
                <Text type="secondary" style={{ fontSize: 10 }}>{t('parseProgress.eta')}: {formatEta(task.eta)}</Text>
              )}
              {task.createdAt && (task.status === 'running' || task.status === 'paused') && (
                <Text type="secondary" style={{ fontSize: 10 }}>{t('taskProgress.elapsed')}: {formatDuration(task.createdAt, task.status)}</Text>
              )}
            </div>

            {task.error && (
              <Text type="danger" style={{ fontSize: 11, display: 'block', marginTop: 2 }}>{t('taskProgress.errorLabel')} {task.error}</Text>
            )}
          </div>
        )
      })}
    </div>
  ) : (
    <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t('taskProgress.noTasks')} style={{ margin: '8px 0' }} />
  )

  const badgeCount = totalActiveCount > 0 ? totalActiveCount : (failedCount > 0 ? failedCount : 0)
  const badgeColor = totalActiveCount === 0 && failedCount > 0 ? '#ff4d4f' : undefined

  return (
    <Popover
      content={taskListContent}
      title={<Text strong style={{ fontSize: 13 }}>{t('taskProgress.panelTitle')}</Text>}
      trigger="click"
      placement="bottomLeft"
    >
      <Badge count={badgeCount} color={badgeColor} size="small" offset={[-4, 4]}>
        <Button icon={<FieldTimeOutlined />} size="middle">
          {t('taskProgress.panelTitle')}
        </Button>
      </Badge>
    </Popover>
  )
}

export default TaskProgressPanel
