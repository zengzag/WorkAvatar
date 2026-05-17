import { memo } from 'react'
import { Handle, Position } from '@xyflow/react'
import type { NodeProps } from '@xyflow/react'
import { CheckCircleOutlined } from '@ant-design/icons'
import { theme } from 'antd'
import { useWorkflowStore, type OutputNodeData, type WorkflowNodeStatus } from '../../../stores/workflow.store'

const STATUS_COLORS: Record<WorkflowNodeStatus, string> = {
  pending: '#d9d9d9',
  running: '#1677ff',
  completed: '#52c41a',
  failed: '#ff4d4f',
}

function OutputNode({ id, selected, data }: NodeProps) {
  const { token } = theme.useToken()
  const execution = useWorkflowStore((s) => s.execution)
  const nodeExec = execution?.nodeExecutions[id]
  const status = nodeExec?.status || 'pending'

  const nodeData = data as unknown as OutputNodeData

  return (
    <div
      style={{
        background: token.colorBgContainer,
        border: `1px solid ${selected ? '#1677ff' : token.colorBorder}`,
        borderRadius: 8,
        padding: '8px 12px',
        minWidth: 160,
        maxWidth: 220,
        boxShadow: selected ? '0 0 8px rgba(22, 119, 255, 0.3)' : 'none',
      }}
    >
      <Handle type="target" position={Position.Left} style={{ background: '#1677ff', width: 12, height: 12 }} />
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <CheckCircleOutlined style={{ color: '#1677ff', fontSize: 18 }} />
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
    </div>
  )
}

export default memo(OutputNode)
