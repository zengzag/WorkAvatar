import { memo } from 'react'
import { Handle, Position } from '@xyflow/react'
import type { NodeProps } from '@xyflow/react'
import { PlayCircleOutlined } from '@ant-design/icons'
import { theme } from 'antd'
import { useTranslation } from 'react-i18next'
import { useWorkflowStore, type InputNodeData, type WorkflowNodeStatus } from '../../../stores/workflow.store'

const STATUS_COLORS: Record<WorkflowNodeStatus, string> = {
  pending: '#d9d9d9',
  running: '#1677ff',
  completed: '#52c41a',
  failed: '#ff4d4f',
}

function InputNode({ id, selected, data }: NodeProps) {
  const { token } = theme.useToken()
  const { t } = useTranslation()
  const execution = useWorkflowStore((s) => s.execution)
  const nodeExec = execution?.nodeExecutions[id]
  const status = nodeExec?.status || 'pending'

  const nodeData = data as unknown as InputNodeData
  const promptPreview = nodeData.prompt
    ? nodeData.prompt.length > 40
      ? nodeData.prompt.substring(0, 40) + '...'
      : nodeData.prompt
    : t('workflow.noPrompt')

  return (
    <div
      style={{
        background: token.colorBgContainer,
        border: `1px solid ${selected ? '#52c41a' : token.colorBorder}`,
        borderRadius: 8,
        padding: '8px 12px',
        minWidth: 180,
        maxWidth: 240,
        boxShadow: selected ? '0 0 8px rgba(82, 196, 26, 0.3)' : 'none',
      }}
    >
      <Handle type="source" position={Position.Right} style={{ background: '#52c41a', width: 12, height: 12 }} />
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <PlayCircleOutlined style={{ color: '#52c41a', fontSize: 18 }} />
        <span style={{ fontWeight: 600, fontSize: 13, color: token.colorText }}>{nodeData.label}</span>
        <span
          style={{
            width: 8,
            height: 8,
            borderRadius: '50%',
            background: STATUS_COLORS[status],
            marginLeft: 'auto',
            flexShrink: 0,
          }}
        />
      </div>
      <div style={{ fontSize: 11, color: token.colorTextQuaternary, marginTop: 4, lineHeight: 1.4 }}>
        {promptPreview}
      </div>
    </div>
  )
}

export default memo(InputNode)
