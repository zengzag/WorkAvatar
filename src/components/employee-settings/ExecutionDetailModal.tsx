import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Modal, Typography, Tag, theme, Space } from 'antd'
import {
  CheckCircleOutlined,
  CloseCircleOutlined,
  ExclamationCircleOutlined,
  LoadingOutlined,
} from '@ant-design/icons'
import dayjs from 'dayjs'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import type { MessageSegment } from '../workbench/types'
import ThinkingSegment from '../workbench/ThinkingSegment'
import ToolCallSegment from '../workbench/ToolCallSegment'

const { Text } = Typography

interface ExecutionItem {
  id: string
  status: 'running' | 'completed' | 'failed' | 'timeout'
  result_text: string | null
  error_message: string | null
  segments_json: string | null
  started_at: number
  completed_at: number | null
  duration_ms: number | null
}

interface ExecutionDetailModalProps {
  open: boolean
  execution: ExecutionItem | null
  onClose: () => void
}

const ExecutionDetailModal: React.FC<ExecutionDetailModalProps> = ({ open, execution, onClose }) => {
  const { t } = useTranslation()
  const { token } = theme.useToken()
  const [collapsedSegments, setCollapsedSegments] = useState<Record<string, boolean>>({})

  if (!execution) return null

  let segments: MessageSegment[] = []
  if (execution.segments_json) {
    try {
      segments = JSON.parse(execution.segments_json)
    } catch {}
  }

  const hasSegments = segments.length > 0

  const getToolDisplayName = (name: string) => {
    const map: Record<string, string> = {
      calculator: 'Calculator',
      date_time: 'Date & Time',
      shell_exec: 'Shell',
      read_file: 'Read File',
      write_file: 'Write File',
      list_directory: 'List Dir',
      web_search: 'Web Search',
      knowledge_search: 'Knowledge Search',
    }
    return map[name] || name
  }

  const statusIcon = () => {
    switch (execution.status) {
      case 'running': return <LoadingOutlined style={{ color: token.colorPrimary }} />
      case 'completed': return <CheckCircleOutlined style={{ color: token.colorSuccess }} />
      case 'failed': return <CloseCircleOutlined style={{ color: token.colorError }} />
      case 'timeout': return <ExclamationCircleOutlined style={{ color: token.colorWarning }} />
    }
  }

  const statusColor: Record<string, string> = { running: 'processing', completed: 'success', failed: 'error', timeout: 'warning' }
  const statusLabel: Record<string, string> = {
    running: t('empTask.statusRunning'),
    completed: t('empTask.statusCompleted'),
    failed: t('empTask.statusFailed'),
    timeout: t('empTask.statusTimeout'),
  }

  return (
    <Modal
      open={open}
      title={
        <Space>
          {statusIcon()}
          <span>{t('empTask.executionDetail')}</span>
          <Tag color={statusColor[execution.status]}>{statusLabel[execution.status]}</Tag>
        </Space>
      }
      onCancel={onClose}
      footer={null}
      width={800}
      styles={{ body: { maxHeight: '70vh', overflow: 'auto' } }}
    >
      <div style={{ marginBottom: 12, display: 'flex', gap: 16, flexWrap: 'wrap' }}>
        <Text type="secondary">{t('empTask.startedAt')}: {dayjs(execution.started_at * 1000).format('YYYY-MM-DD HH:mm:ss')}</Text>
        {execution.duration_ms != null && <Text type="secondary">{t('empTask.duration')}: {(execution.duration_ms / 1000).toFixed(1)}s</Text>}
      </div>

      {hasSegments ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {segments.map((seg) => {
            if (seg.type === 'thinking') {
              const isCollapsed = collapsedSegments[seg.id] ?? (seg.collapsed ?? true)
              return (
                <ThinkingSegment
                  key={seg.id}
                  seg={{ ...seg, collapsed: isCollapsed }}
                  isStreaming={!!seg.isStreaming}
                  onToggle={() => setCollapsedSegments(prev => ({ ...prev, [seg.id]: !isCollapsed }))}
                />
              )
            }
            if (seg.type === 'tool_call') {
              const isCollapsed = collapsedSegments[seg.id] ?? (seg.collapsed ?? true)
              return (
                <ToolCallSegment
                  key={seg.id}
                  seg={{ ...seg, collapsed: isCollapsed }}
                  onToggle={() => setCollapsedSegments(prev => ({ ...prev, [seg.id]: !isCollapsed }))}
                  getToolDisplayName={getToolDisplayName}
                />
              )
            }
            if (seg.type === 'answer') {
              return (
                <div key={seg.id} style={{ marginBottom: 0 }}>
                  <div style={{
                    padding: '10px 16px',
                    borderRadius: 12,
                    background: token.colorBgLayout,
                    lineHeight: 1.7,
                    wordBreak: 'break-word',
                  }}>
                    <div className="markdown-content" style={{ fontSize: 14, color: token.colorText }}>
                      <ReactMarkdown remarkPlugins={[remarkGfm]}>
                        {seg.content || (seg.isStreaming ? '▊' : '')}
                      </ReactMarkdown>
                    </div>
                    {seg.isStreaming && <span className="cursor-blink" style={{ color: token.colorTextQuaternary }}>▊</span>}
                  </div>
                </div>
              )
            }
            return null
          })}
        </div>
      ) : (
        <div>
          {execution.error_message && (
            <div style={{
              padding: '10px 16px',
              borderRadius: 12,
              background: token.colorErrorBg,
              border: `1px solid ${token.colorErrorBorder}`,
              marginBottom: 12,
            }}>
              <Text type="danger" style={{ fontSize: 13, whiteSpace: 'pre-wrap' }}>{execution.error_message}</Text>
            </div>
          )}
          {execution.result_text && (
            <div style={{
              padding: '10px 16px',
              borderRadius: 12,
              background: token.colorBgLayout,
              lineHeight: 1.7,
            }}>
              <div className="markdown-content" style={{ fontSize: 14, color: token.colorText }}>
                <ReactMarkdown remarkPlugins={[remarkGfm]}>
                  {execution.result_text}
                </ReactMarkdown>
              </div>
            </div>
          )}
          {!execution.result_text && !execution.error_message && execution.status === 'running' && (
            <div style={{ textAlign: 'center', padding: 24 }}>
              <LoadingOutlined style={{ fontSize: 24, color: token.colorPrimary }} />
              <div style={{ marginTop: 8 }}><Text type="secondary">{t('empTask.executing')}</Text></div>
            </div>
          )}
        </div>
      )}
    </Modal>
  )
}

export default ExecutionDetailModal
