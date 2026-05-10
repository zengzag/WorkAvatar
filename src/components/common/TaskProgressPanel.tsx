import { useState, useEffect } from 'react'
import { Button, Space, Typography, Progress, Tag, Popover, theme } from 'antd'
import {
  ClockCircleOutlined,
  SyncOutlined,
  CheckCircleOutlined,
  CloseCircleOutlined,
  LoadingOutlined,
} from '@ant-design/icons'

const { Text } = Typography

export interface BackgroundTask {
  id: string
  type: string
  title: string
  status: 'pending' | 'running' | 'completed' | 'failed' | 'cancelled'
  progress: number
  progressText: string
  error?: string
  createdAt: number
}

const TaskProgressPanel: React.FC = () => {
  const [tasks, setTasks] = useState<BackgroundTask[]>([])
  const { token } = theme.useToken()

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

  const hasTasks = tasks.length > 0

  if (!hasTasks) return null

  const activeCount = tasks.filter(t => t.status === 'running').length
  const pendingCount = tasks.filter(t => t.status === 'pending').length
  const failedCount = tasks.filter(t => t.status === 'failed').length

  const getStatusIcon = (status: string) => {
    switch (status) {
      case 'pending': return <ClockCircleOutlined style={{ color: token.colorWarning }} />
      case 'running': return <LoadingOutlined style={{ color: token.colorPrimary }} />
      case 'completed': return <CheckCircleOutlined style={{ color: token.colorSuccess }} />
      case 'failed': return <CloseCircleOutlined style={{ color: token.colorError }} />
      case 'cancelled': return <CloseCircleOutlined style={{ color: token.colorTextQuaternary }} />
      default: return null
    }
  }

  const getStatusText = (status: string) => {
    switch (status) {
      case 'pending': return '等待中'
      case 'running': return '运行中'
      case 'completed': return '已完成'
      case 'failed': return '失败'
      case 'cancelled': return '已取消'
      default: return status
    }
  }

  const handleClearCompleted = () => {
    window.electronAPI.tasks.clearCompleted()
  }

  const summaryContent = (
    <Space size={8}>
      {activeCount > 0 && <Tag color="blue" icon={<SyncOutlined spin />}>{activeCount} 运行中</Tag>}
      {pendingCount > 0 && <Tag color="orange">{pendingCount} 等待中</Tag>}
      {failedCount > 0 && <Tag color="red">{failedCount} 失败</Tag>}
      <Button type="link" size="small" onClick={handleClearCompleted}>清除已完成</Button>
    </Space>
  )

  const taskListContent = (
    <div style={{ maxWidth: 360, maxHeight: 400, overflow: 'auto' }}>
      {tasks.map(task => (
        <div key={task.id} style={{ padding: '8px 0', borderBottom: `1px solid ${token.colorBorderSecondary}` }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
            <Space size={4}>
              {getStatusIcon(task.status)}
              <Text style={{ fontSize: 13 }}>{task.title}</Text>
            </Space>
            <Tag style={{ fontSize: 11 }} color={task.status === 'failed' ? 'red' : task.status === 'completed' ? 'green' : 'default'}>
              {getStatusText(task.status)}
            </Tag>
          </div>
          <Text type="secondary" style={{ fontSize: 11 }}>{task.progressText}</Text>
          {task.progress > 0 && task.progress < 100 && (
            <Progress percent={task.progress} size="small" showInfo={false} />
          )}
          {task.error && (
            <Text type="danger" style={{ fontSize: 11, display: 'block', marginTop: 2 }}>错误: {task.error}</Text>
          )}
        </div>
      ))}
    </div>
  )

  return (
    <Popover
      content={taskListContent}
      title={null}
      trigger="click"
      placement="bottomRight"
    >
      <div style={{
        padding: '4px 10px',
        display: 'flex',
        alignItems: 'center',
        gap: 6,
      }}>
        {summaryContent}
      </div>
    </Popover>
  )
}

export default TaskProgressPanel