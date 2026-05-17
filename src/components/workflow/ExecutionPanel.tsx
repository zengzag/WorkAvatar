import { useEffect, useRef } from 'react'
import { Tag, Collapse, Typography, Empty, theme } from 'antd'
import {
  ClockCircleOutlined,
  CheckCircleOutlined,
  CloseCircleOutlined,
  LoadingOutlined,
} from '@ant-design/icons'
import { useTranslation } from 'react-i18next'
import { useWorkflowStore, type WorkflowNodeStatus } from '../../stores/workflow.store'

const { Text } = Typography

const STATUS_CONFIG: Record<WorkflowNodeStatus, { color: string; icon: React.ReactNode; i18nKey: string }> = {
  pending: { color: 'default', icon: <ClockCircleOutlined />, i18nKey: 'workflow.statusPending' },
  running: { color: 'processing', icon: <LoadingOutlined spin />, i18nKey: 'workflow.statusRunning' },
  completed: { color: 'success', icon: <CheckCircleOutlined />, i18nKey: 'workflow.statusCompleted' },
  failed: { color: 'error', icon: <CloseCircleOutlined />, i18nKey: 'workflow.statusFailed' },
}

function formatTimestamp(ts?: string): string {
  if (!ts) return '-'
  try {
    return new Date(ts).toLocaleString()
  } catch {
    return ts
  }
}

const ExecutionPanel: React.FC = () => {
  const { token } = theme.useToken()
  const { t } = useTranslation()
  const execution = useWorkflowStore((s) => s.execution)
  const updateNodeExecution = useWorkflowStore((s) => s.updateNodeExecution)
  const nodes = useWorkflowStore((s) => s.nodes)
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null)

  useEffect(() => {
    const cleanupProgress = (window as any).electronAPI?.workflow?.onExecutionProgress?.((data: any) => {
      updateNodeExecution(data.nodeId, {
        status: data.status,
        input: data.input,
        output: data.output,
        error: data.error,
        startedAt: data.startedAt,
        completedAt: data.completedAt,
      })
    })

    const cleanupNodeUpdate = (window as any).electronAPI?.workflow?.onNodeExecutionUpdate?.((data: any) => {
      updateNodeExecution(data.nodeId, {
        status: data.status,
        input: data.input,
        output: data.output,
        error: data.error,
        startedAt: data.startedAt,
        completedAt: data.completedAt,
      })
    })

    return () => {
      cleanupProgress?.()
      cleanupNodeUpdate?.()
    }
  }, [updateNodeExecution])

  useEffect(() => {
    if (execution?.status === 'running') {
      intervalRef.current = setInterval(() => {}, 2000)
    } else {
      if (intervalRef.current) {
        clearInterval(intervalRef.current)
        intervalRef.current = null
      }
    }
    return () => {
      if (intervalRef.current) {
        clearInterval(intervalRef.current)
      }
    }
  }, [execution?.status])

  if (!execution) {
    return (
      <div style={{ padding: 24, textAlign: 'center' }}>
        <Empty description={t('workflow.noExecution')} />
      </div>
    )
  }

  const overallStatusConfig = STATUS_CONFIG[execution.status]

  const nodeExecutionEntries = Object.values(execution.nodeExecutions)

  const collapseItems = nodeExecutionEntries.map((nodeExec) => {
    const node = nodes.find((n) => n.id === nodeExec.nodeId)
    const nodeLabel = node ? (node.data as any).label || nodeExec.nodeId : nodeExec.nodeId
    const statusConfig = STATUS_CONFIG[nodeExec.status]

    return {
      key: nodeExec.nodeId,
      label: (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <Tag color={statusConfig.color} icon={statusConfig.icon}>
            {t(statusConfig.i18nKey)}
          </Tag>
          <Text style={{ fontSize: 13 }}>{nodeLabel}</Text>
        </div>
      ),
      children: (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {nodeExec.startedAt && (
            <div>
              <Text type="secondary" style={{ fontSize: 12 }}>
                {t('workflow.startedAt')}:
              </Text>{' '}
              <Text style={{ fontSize: 12 }}>{formatTimestamp(nodeExec.startedAt)}</Text>
            </div>
          )}
          {nodeExec.completedAt && (
            <div>
              <Text type="secondary" style={{ fontSize: 12 }}>
                {t('workflow.completedAt')}:
              </Text>{' '}
              <Text style={{ fontSize: 12 }}>{formatTimestamp(nodeExec.completedAt)}</Text>
            </div>
          )}
          {nodeExec.input && (
            <div>
              <Text type="secondary" style={{ fontSize: 12, display: 'block', marginBottom: 2 }}>
                {t('workflow.nodeInput')}:
              </Text>
              <div
                style={{
                  background: token.colorBgLayout,
                  padding: '6px 8px',
                  borderRadius: 4,
                  fontSize: 12,
                  whiteSpace: 'pre-wrap',
                  wordBreak: 'break-word',
                  maxHeight: 120,
                  overflow: 'auto',
                }}
              >
                {nodeExec.input}
              </div>
            </div>
          )}
          {nodeExec.output && (
            <div>
              <Text type="secondary" style={{ fontSize: 12, display: 'block', marginBottom: 2 }}>
                {t('workflow.nodeOutput')}:
              </Text>
              <div
                style={{
                  background: token.colorBgLayout,
                  padding: '6px 8px',
                  borderRadius: 4,
                  fontSize: 12,
                  whiteSpace: 'pre-wrap',
                  wordBreak: 'break-word',
                  maxHeight: 120,
                  overflow: 'auto',
                }}
              >
                {nodeExec.output}
              </div>
            </div>
          )}
          {nodeExec.error && (
            <div>
              <Text type="secondary" style={{ fontSize: 12, display: 'block', marginBottom: 2 }}>
                {t('workflow.nodeError')}:
              </Text>
              <div
                style={{
                  background: '#fff2f0',
                  padding: '6px 8px',
                  borderRadius: 4,
                  fontSize: 12,
                  color: '#ff4d4f',
                  whiteSpace: 'pre-wrap',
                  wordBreak: 'break-word',
                }}
              >
                {nodeExec.error}
              </div>
            </div>
          )}
        </div>
      ),
    }
  })

  return (
    <div style={{ padding: 16 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 16 }}>
        <Tag color={overallStatusConfig.color} icon={overallStatusConfig.icon} style={{ fontSize: 13, padding: '2px 8px' }}>
          {t(overallStatusConfig.i18nKey)}
        </Tag>
        {execution.startedAt && (
          <Text type="secondary" style={{ fontSize: 12 }}>
            {formatTimestamp(execution.startedAt)}
          </Text>
        )}
      </div>

      {nodeExecutionEntries.length > 0 ? (
        <Collapse size="small" items={collapseItems} />
      ) : (
        <Empty description={t('workflow.noExecution')} image={Empty.PRESENTED_IMAGE_SIMPLE} />
      )}
    </div>
  )
}

export default ExecutionPanel
