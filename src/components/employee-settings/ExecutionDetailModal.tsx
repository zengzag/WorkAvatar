import { useState, useEffect, useRef, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { Modal, Typography, Tag, theme, Space, Button } from 'antd'
import {
  CheckCircleOutlined,
  CloseCircleOutlined,
  ExclamationCircleOutlined,
  LoadingOutlined,
  StopOutlined,
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
  liveExecutionId?: string | null
  onClose: () => void
  onAbort?: (executionId: string) => void
}

const ExecutionDetailModal: React.FC<ExecutionDetailModalProps> = ({ open, execution, liveExecutionId, onClose, onAbort }) => {
  const { t } = useTranslation()
  const { token } = theme.useToken()
  const [collapsedSegments, setCollapsedSegments] = useState<Record<string, boolean>>({})
  const [liveSegments, setLiveSegments] = useState<MessageSegment[]>([])
  const [liveStatus, setLiveStatus] = useState<string | null>(null)
  const [liveError, setLiveError] = useState<string | null>(null)
  const [isStreaming, setIsStreaming] = useState(false)
  const bodyRef = useRef<HTMLDivElement>(null)

  const isLive = !!liveExecutionId && execution?.status === 'running'

  useEffect(() => {
    if (!open) {
      setLiveSegments([])
      setLiveStatus(null)
      setLiveError(null)
      setIsStreaming(false)
      setCollapsedSegments({})
    }
  }, [open])

  useEffect(() => {
    if (isLive && liveExecutionId) {
      setIsStreaming(true)
      setLiveStatus('running')
      if (execution?.segments_json) {
        try {
          setLiveSegments(JSON.parse(execution.segments_json))
        } catch {
          setLiveSegments([])
        }
      } else {
        setLiveSegments([])
      }
    }
  }, [isLive, liveExecutionId, execution?.segments_json])

  const handleSegmentsUpdate = useCallback((data: { executionId: string; segments: any[]; isStreaming: boolean }) => {
    if (data.executionId === liveExecutionId) {
      setLiveSegments(data.segments)
      setIsStreaming(data.isStreaming)
    }
  }, [liveExecutionId])

  const handleStatusUpdate = useCallback((data: { executionId: string; status: string; errorMessage: string | null }) => {
    if (data.executionId === liveExecutionId) {
      setLiveStatus(data.status)
      setLiveError(data.errorMessage)
      if (data.status !== 'running') {
        setIsStreaming(false)
      }
    }
  }, [liveExecutionId])

  useEffect(() => {
    if (!open || !liveExecutionId) return

    const unsubSegments = window.electronAPI.employeeTask.onSegmentsUpdate(handleSegmentsUpdate)
    const unsubStatus = window.electronAPI.employeeTask.onExecutionStatusUpdate(handleStatusUpdate)

    return () => {
      unsubSegments()
      unsubStatus()
    }
  }, [open, liveExecutionId, handleSegmentsUpdate, handleStatusUpdate])

  useEffect(() => {
    if (isLive && isStreaming && bodyRef.current) {
      const el = bodyRef.current
      const isNearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 150
      if (isNearBottom) {
        el.scrollTop = el.scrollHeight
      }
    }
  }, [liveSegments, isLive, isStreaming])

  if (!execution) return null

  let segments: MessageSegment[] = []
  if (isLive) {
    segments = liveSegments
  } else if (execution.segments_json) {
    try {
      segments = JSON.parse(execution.segments_json)
    } catch {}
  }

  const hasSegments = segments.length > 0

  const currentStatus = isLive ? (liveStatus || execution.status) : execution.status
  const currentError = isLive ? liveError : execution.error_message

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
      kb_list: 'Knowledge Base List',
      kb_overview: 'Knowledge Base Overview',
      kb_search: 'Smart KB Search',
      kb_get_toc: 'View Document TOC',
      kb_get_paragraphs: 'View Paragraphs',
      kb_get_content: 'Get Document Content',
    }
    return map[name] || name
  }

  const statusIcon = () => {
    switch (currentStatus) {
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

  const showAbortButton = isLive && isStreaming && onAbort

  return (
    <Modal
      open={open}
      title={
        <Space>
          {statusIcon()}
          <span>{t('empTask.executionDetail')}</span>
          <Tag color={statusColor[currentStatus] || 'default'}>{statusLabel[currentStatus] || currentStatus}</Tag>
        </Space>
      }
      onCancel={onClose}
      footer={showAbortButton ? (
        <Button
          danger
          icon={<StopOutlined />}
          onClick={() => onAbort(execution.id)}
        >
          {t('empTask.abort')}
        </Button>
      ) : null}
      width={800}
      styles={{ body: { maxHeight: '70vh', overflow: 'auto' } }}
    >
      <div ref={bodyRef} style={{ maxHeight: '70vh', overflow: 'auto' }}>
        <div style={{ marginBottom: 12, display: 'flex', gap: 16, flexWrap: 'wrap' }}>
          <Text type="secondary">{t('empTask.startedAt')}: {dayjs(execution.started_at * 1000).format('YYYY-MM-DD HH:mm:ss')}</Text>
          {!isLive && execution.duration_ms != null && <Text type="secondary">{t('empTask.duration')}: {(execution.duration_ms / 1000).toFixed(1)}s</Text>}
          {isLive && isStreaming && <Text type="secondary" style={{ color: token.colorPrimary }}>{t('empTask.executing')}</Text>}
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
            {currentError && (
              <div style={{
                padding: '10px 16px',
                borderRadius: 12,
                background: token.colorErrorBg,
                border: `1px solid ${token.colorErrorBorder}`,
                marginBottom: 12,
              }}>
                <Text type="danger" style={{ fontSize: 13, whiteSpace: 'pre-wrap' }}>{currentError}</Text>
              </div>
            )}
            {execution.result_text && !isLive && (
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
            {!execution.result_text && !currentError && currentStatus === 'running' && (
              <div style={{ textAlign: 'center', padding: 24 }}>
                <LoadingOutlined style={{ fontSize: 24, color: token.colorPrimary }} />
                <div style={{ marginTop: 8 }}><Text type="secondary">{t('empTask.executing')}</Text></div>
              </div>
            )}
          </div>
        )}
      </div>
    </Modal>
  )
}

export default ExecutionDetailModal
