import { memo } from 'react'
import { Handle, Position } from '@xyflow/react'
import type { NodeProps } from '@xyflow/react'
import { ForkOutlined } from '@ant-design/icons'
import { theme } from 'antd'
import { useTranslation } from 'react-i18next'
import { useWorkflowStore, type BranchNodeData, type WorkflowNodeStatus } from '../../../stores/workflow.store'

const STATUS_COLORS: Record<WorkflowNodeStatus, string> = {
  pending: '#d9d9d9',
  running: '#1677ff',
  completed: '#52c41a',
  failed: '#ff4d4f',
  skipped: '#faad14',
}

function BranchNode({ id, selected, data }: NodeProps) {
  const { token } = theme.useToken()
  const { t } = useTranslation()
  const execution = useWorkflowStore((s) => s.execution)
  const debug = useWorkflowStore((s) => s.debug)
  const nodeExec = execution?.nodeExecutions[id]
  const status = nodeExec?.status || 'pending'
  const isDebugHighlight = debug.enabled && debug.currentNodeId === id

  const nodeData = data as unknown as BranchNodeData
  const ruleCount = nodeData.rules?.length || 0

  return (
    <div
      style={{
        position: 'relative',
        width: 100,
        height: 100,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      <div
        style={{
          width: 80,
          height: 80,
          background: token.colorBgContainer,
          border: `2px solid ${selected ? '#fa8c16' : isDebugHighlight ? '#1677ff' : token.colorBorder}`,
          transform: 'rotate(45deg)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          boxShadow: selected
            ? '0 0 8px rgba(250, 140, 22, 0.3)'
            : isDebugHighlight
              ? '0 0 12px rgba(22, 119, 255, 0.5)'
              : 'none',
        }}
      >
        <div style={{ transform: 'rotate(-45deg)', textAlign: 'center' }}>
          <ForkOutlined style={{ color: '#fa8c16', fontSize: 16 }} />
          <div style={{ fontWeight: 600, fontSize: 11, color: token.colorText, marginTop: 2, maxWidth: 60, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {nodeData.label}
          </div>
          <div style={{ fontSize: 10, color: token.colorTextQuaternary }}>
            {ruleCount > 0 ? t('workflow.branchRuleCount', { count: ruleCount }) : t('workflow.noBranchRules')}
          </div>
        </div>
      </div>

      <Handle
        type="target"
        position={Position.Left}
        id="input"
        style={{ background: '#fa8c16', width: 10, height: 10, left: -5, top: '50%', transform: 'translateY(-50%)' }}
      />
      <Handle
        type="source"
        position={Position.Right}
        id="yes"
        style={{ background: '#52c41a', width: 10, height: 10, right: -5, top: '30%', transform: 'translateY(-50%)' }}
      />
      <Handle
        type="source"
        position={Position.Right}
        id="no"
        style={{ background: '#ff4d4f', width: 10, height: 10, right: -5, top: '70%', transform: 'translateY(-50%)' }}
      />

      <div style={{ position: 'absolute', right: -22, top: '22%', fontSize: 10, color: '#52c41a', fontWeight: 600 }}>
        {t('workflow.branchYes')}
      </div>
      <div style={{ position: 'absolute', right: -18, top: '62%', fontSize: 10, color: '#ff4d4f', fontWeight: 600 }}>
        {t('workflow.branchNo')}
      </div>

      <span
        style={{
          position: 'absolute',
          top: 2,
          right: 2,
          width: 8,
          height: 8,
          borderRadius: '50%',
          background: STATUS_COLORS[status],
          flexShrink: 0,
        }}
      />
    </div>
  )
}

export default memo(BranchNode)
