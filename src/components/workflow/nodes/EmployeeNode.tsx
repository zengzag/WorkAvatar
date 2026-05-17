import { memo } from 'react'
import { Handle, Position } from '@xyflow/react'
import type { NodeProps } from '@xyflow/react'
import { UserOutlined } from '@ant-design/icons'
import { theme } from 'antd'
import { useWorkflowStore, type EmployeeNodeData, type WorkflowNodeStatus } from '../../../stores/workflow.store'

const STATUS_COLORS: Record<WorkflowNodeStatus, string> = {
  pending: '#d9d9d9',
  running: '#1677ff',
  completed: '#52c41a',
  failed: '#ff4d4f',
}

function EmployeeNode({ id, selected, data }: NodeProps) {
  const { token } = theme.useToken()
  const execution = useWorkflowStore((s) => s.execution)
  const nodeExec = execution?.nodeExecutions[id]
  const status = nodeExec?.status || 'pending'

  const nodeData = data as unknown as EmployeeNodeData

  return (
    <div
      style={{
        background: token.colorBgContainer,
        border: `2px solid ${selected ? '#722ed1' : token.colorBorderSecondary}`,
        borderRadius: 8,
        padding: '8px 12px',
        minWidth: 180,
        maxWidth: 240,
        boxShadow: selected ? '0 0 8px rgba(114, 46, 209, 0.3)' : token.boxShadowSecondary,
      }}
    >
      <Handle type="target" position={Position.Left} style={{ background: '#722ed1', width: 8, height: 8 }} />
      <Handle type="source" position={Position.Right} style={{ background: '#722ed1', width: 8, height: 8 }} />
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <UserOutlined style={{ color: '#722ed1', fontSize: 18 }} />
        <span style={{ fontWeight: 600, fontSize: 13, color: token.colorText }}>{nodeData.employee_name || nodeData.label}</span>
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
      {nodeData.description && (
        <div style={{ fontSize: 11, color: token.colorTextQuaternary, marginTop: 4, lineHeight: 1.4 }}>
          {nodeData.description.length > 50 ? nodeData.description.substring(0, 50) + '...' : nodeData.description}
        </div>
      )}
    </div>
  )
}

export default memo(EmployeeNode)
