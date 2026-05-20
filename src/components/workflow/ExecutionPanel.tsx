import { useMemo } from 'react'
import { Table, Tag, Typography, theme, Empty } from 'antd'
import type { ColumnsType } from 'antd/es/table'
import { CheckCircleOutlined, CloseCircleOutlined, LoadingOutlined, ClockCircleOutlined, ForwardOutlined, MinusCircleOutlined } from '@ant-design/icons'
import { useTranslation } from 'react-i18next'
import { useWorkflowStore, type WorkflowNodeStatus, type NodeExecutionRecord } from '../../stores/workflow.store'

const { Text, Paragraph } = Typography

const STATUS_CONFIG: Record<WorkflowNodeStatus, { color: string; icon: React.ReactNode }> = {
  pending: { color: 'default', icon: <ClockCircleOutlined /> },
  running: { color: 'processing', icon: <LoadingOutlined /> },
  completed: { color: 'success', icon: <CheckCircleOutlined /> },
  failed: { color: 'error', icon: <CloseCircleOutlined /> },
  skipped: { color: 'warning', icon: <MinusCircleOutlined /> },
}

const ExecutionPanel: React.FC = () => {
  const { token } = theme.useToken()
  const { t } = useTranslation()
  const execution = useWorkflowStore((s) => s.execution)
  const nodes = useWorkflowStore((s) => s.nodes)
  const debug = useWorkflowStore((s) => s.debug)

  const dataSource = useMemo(() => {
    if (!execution) return []
    return Object.values(execution.nodeExecutions).map((exec) => {
      const node = nodes.find((n) => n.id === exec.nodeId)
      return {
        ...exec,
        label: (node?.data as any)?.label || exec.nodeId,
        nodeType: node?.type || 'unknown',
      }
    })
  }, [execution, nodes])

  const columns: ColumnsType<NodeExecutionRecord & { label: string; nodeType: string }> = useMemo(
    () => [
      {
        title: t('workflow.nodeLabel'),
        dataIndex: 'label',
        key: 'label',
        width: 120,
        render: (text: string, record) => (
          <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
            {debug.enabled && debug.currentNodeId === record.nodeId && (
              <ForwardOutlined style={{ color: '#1677ff', fontSize: 12 }} />
            )}
            <Text strong style={{ fontSize: 12 }}>{text}</Text>
          </div>
        ),
      },
      {
        title: t('workflow.statusLabel'),
        dataIndex: 'status',
        key: 'status',
        width: 90,
        render: (status: WorkflowNodeStatus) => {
          const config = STATUS_CONFIG[status]
          return <Tag color={config.color} icon={config.icon} style={{ fontSize: 11 }}>{t(`workflow.status_${status}`)}</Tag>
        },
      },
      {
        title: t('workflow.inputLabel'),
        dataIndex: 'input',
        key: 'input',
        width: 200,
        render: (text: string) => (
          <Paragraph
            ellipsis={{ rows: 2, expandable: true, symbol: t('common.expand') }}
            style={{ margin: 0, fontSize: 11, color: token.colorTextSecondary }}
          >
            {text || '-'}
          </Paragraph>
        ),
      },
      {
        title: t('workflow.outputLabel'),
        dataIndex: 'output',
        key: 'output',
        width: 200,
        render: (text: string) => (
          <Paragraph
            ellipsis={{ rows: 2, expandable: true, symbol: t('common.expand') }}
            style={{ margin: 0, fontSize: 11, color: token.colorTextSecondary }}
          >
            {text || '-'}
          </Paragraph>
        ),
      },
      {
        title: t('workflow.errorLabel'),
        dataIndex: 'error',
        key: 'error',
        width: 150,
        render: (text: string | null) =>
          text ? (
            <Text type="danger" style={{ fontSize: 11 }}>{text}</Text>
          ) : (
            <Text type="secondary" style={{ fontSize: 11 }}>-</Text>
          ),
      },
    ],
    [t, token.colorTextSecondary, debug]
  )

  if (!execution) {
    return (
      <div style={{ padding: 16, textAlign: 'center' }}>
        <Empty description={t('workflow.noExecution')} image={Empty.PRESENTED_IMAGE_SIMPLE} />
      </div>
    )
  }

  return (
    <Table
      dataSource={dataSource}
      columns={columns}
      rowKey="nodeId"
      size="small"
      pagination={false}
      scroll={{ y: 200 }}
      rowClassName={(record) =>
        debug.enabled && debug.currentNodeId === record.nodeId
          ? 'debug-highlight-row'
          : ''
      }
    />
  )
}

export default ExecutionPanel
