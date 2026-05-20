import { memo } from 'react'
import { Handle, Position } from '@xyflow/react'
import type { NodeProps } from '@xyflow/react'
import { MergeCellsOutlined } from '@ant-design/icons'
import { theme } from 'antd'
import { useTranslation } from 'react-i18next'
import { useWorkflowStore, type MergeNodeData, type WorkflowNodeStatus } from '../../../stores/workflow.store'

const STATUS_COLORS: Record<WorkflowNodeStatus, string> = {
  pending: '#d9d9d9',
  running: '#1677ff',
  completed: '#52c41a',
  failed: '#ff4d4f',
  skipped: '#faad14',
}

function MergeNode({ id, selected, data }: NodeProps) {
  const { token } = theme.useToken()
  const { t } = useTranslation()
  const execution = useWorkflowStore((s) => s.execution)
  const debug = useWorkflowStore((s) => s.debug)
  const nodeExec = execution?.nodeExecutions[id]
  const status = nodeExec?.status || 'pending'
  const isDebugHighlight = debug.enabled && debug.currentNodeId === id

  const nodeData = data as unknown as MergeNodeData
  const upstreamCount = nodeData.selectedUpstreamIds?.length || 0

  return (
    <div
      style={{
        position: 'relative',
        background: token.colorBgContainer,
        border: `1px solid ${selected ? '#13c2c2' : isDebugHighlight ? '#1677ff' : token.colorBorder}`,
        borderRadius: 8,
        padding: '8px 12px',
        minWidth: 160,
        maxWidth: 220,
        boxShadow: selected
          ? '0 0 8px rgba(19, 194, 194, 0.3)'
          : isDebugHighlight
            ? '0 0 12px rgba(22, 119, 255, 0.5)'
            : 'none',
      }}
    >
      <Handle
        type="target"
        position={Position.Left}
        id="input"
        style={{ background: '#13c2c2', width: 12, height: 12, top: '50%', left: -6, transform: 'translateY(-50%)' }}
      />
      <Handle
        type="source"
        position={Position.Right}
        id="output"
        style={{ background: '#13c2c2', width: 12, height: 12, top: '50%', right: -6, transform: 'translateY(-50%)' }}
      />
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <MergeCellsOutlined style={{ color: '#13c2c2', fontSize: 18 }} />
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
        {upstreamCount > 0 ? t('workflow.mergeUpstreamCount', { count: upstreamCount }) : t('workflow.noMergeUpstream')}
      </div>
    </div>
  )
}

export default memo(MergeNode)
