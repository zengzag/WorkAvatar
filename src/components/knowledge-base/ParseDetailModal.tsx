import { useState, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { Modal, Progress, Typography, Descriptions, Tag, theme } from 'antd'
import {
  CheckCircleOutlined, SyncOutlined, ClockCircleOutlined,
  CloseCircleOutlined, PauseCircleOutlined,
} from '@ant-design/icons'

const { Text } = Typography

interface ParseDetailModalProps {
  open: boolean
  docId: string | null
  docName: string
  onClose: () => void
}



const ParseDetailModal: React.FC<ParseDetailModalProps> = ({
  open, docId, docName, onClose,
}) => {
  const { t } = useTranslation()
  const { token } = theme.useToken()
  const [detail, setDetail] = useState<any>(null)

  useEffect(() => {
    if (!open || !docId) return

    const loadDetail = async () => {
      try {
        const result = await window.electronAPI.kb.getParseDetail(docId)
        setDetail(result)
      } catch {}
    }

    loadDetail()
    const interval = setInterval(loadDetail, 1000)
    return () => clearInterval(interval)
  }, [open, docId])

  const formatEta = (seconds: number) => {
    if (!seconds || seconds <= 0) return '--'
    if (seconds < 60) return t('parseProgress.seconds', { count: Math.round(seconds) })
    if (seconds < 3600) return t('parseProgress.minutes', { count: Math.round(seconds / 60) })
    return t('parseProgress.hours', { count: Math.round(seconds / 3600) })
  }

  const formatSpeed = (speed: number) => {
    if (!speed || speed <= 0) return '--'
    return `${speed.toFixed(1)}%/s`
  }

  const statusConfig: Record<string, { color: string; textKey: string; icon: React.ReactNode }> = {
    pending: { color: 'orange', textKey: 'parseProgress.pending', icon: <ClockCircleOutlined /> },
    parsing: { color: 'blue', textKey: 'parseProgress.parsingStatus', icon: <SyncOutlined spin /> },
    paused: { color: 'gold', textKey: 'parseProgress.paused', icon: <PauseCircleOutlined /> },
    completed: { color: 'green', textKey: 'parseProgress.completed', icon: <CheckCircleOutlined /> },
    failed: { color: 'red', textKey: 'parseProgress.failed', icon: <CloseCircleOutlined /> },
  }

  const currentStage = detail?.parse_stage || ''
  const statusInfo = statusConfig[detail?.parse_status || 'pending'] || statusConfig.pending

  const parseSteps = [
    { key: 'reading', label: t('parseProgress.reading') },
    { key: 'parsing', label: t('parseProgress.parsing') },
    { key: 'chunking', label: t('parseProgress.chunking') },
    { key: 'saving', label: t('parseProgress.saving') },
  ]

  const knowledgeSteps = [
    { key: 'paragraph_identify', label: t('parseProgress.knowledgeParagraphIdentify') },
    { key: 'paragraph_summary', label: t('parseProgress.knowledgeParagraphSummary') },
    { key: 'doc_summary', label: t('parseProgress.knowledgeDocSummary') },
  ]

  const knowledgeProcessStageKeys = new Set([
    'paragraph_identify', 'paragraph_summary', 'doc_summary',
    'knowledge_process', 'complete', 'global_summary',
  ])

  const isKnowledgeProcess = currentStage ? knowledgeProcessStageKeys.has(currentStage) : false
  const steps = isKnowledgeProcess ? knowledgeSteps : parseSteps

  // 智能匹配当前步骤索引
  let currentStepIndex = steps.findIndex(s => s.key === currentStage)
  if (currentStepIndex === -1) {
    // 如果没有精确匹配，尝试模糊匹配
    for (let i = 0; i < steps.length; i++) {
      if (currentStage.includes(steps[i].key) || steps[i].key.includes(currentStage)) {
        currentStepIndex = i
        break
      }
    }
    // 如果还没找到，根据进度来估算
    if (currentStepIndex === -1 && detail?.parse_progress !== undefined) {
      currentStepIndex = Math.min(Math.floor(detail.parse_progress / 25), steps.length - 1)
    }
  }

  return (
    <Modal
      title={t('parseProgress.detailTitle', { name: docName })}
      open={open}
      onCancel={onClose}
      footer={null}
      width={560}
    >
      {detail && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <Tag color={statusInfo.color} icon={statusInfo.icon}>
              {t(statusInfo.textKey)}
            </Tag>
            {detail.parse_detail && (
              <Text type="secondary">{detail.parse_detail}</Text>
            )}
          </div>

          <Progress
            percent={Math.round(detail.parse_progress || 0)}
            status={detail.parse_status === 'failed' ? 'exception' : detail.parse_status === 'paused' ? 'normal' : 'active'}
            strokeColor={detail.parse_status === 'paused' ? token.colorWarning : undefined}
          />

          {detail.parse_status !== 'completed' && detail.parse_status !== 'failed' && (
            <div style={{ display: 'flex', gap: 8 }}>
              {steps.map((step, index) => (
                <div
                  key={step.key}
                  style={{
                    flex: 1,
                    padding: '8px 12px',
                    borderRadius: 6,
                    background: index < currentStepIndex
                      ? token.colorSuccessBg
                      : index === currentStepIndex
                        ? token.colorPrimaryBg
                        : token.colorBgLayout,
                    border: index === currentStepIndex
                      ? `1px solid ${token.colorPrimary}`
                      : '1px solid transparent',
                    textAlign: 'center',
                  }}
                >
                  <div style={{ fontSize: 12, color: index < currentStepIndex ? token.colorSuccess : index === currentStepIndex ? token.colorPrimary : token.colorTextQuaternary }}>
                    {index < currentStepIndex ? '✓' : `${index + 1}`}
                  </div>
                  <div style={{ fontSize: 11, color: index <= currentStepIndex ? token.colorText : token.colorTextQuaternary }}>
                    {step.label}
                  </div>
                </div>
              ))}
            </div>
          )}

          <Descriptions size="small" column={2} bordered>
            {(detail.total_pages > 0 || detail.processed_pages > 0) && (
              <Descriptions.Item label={t('parseProgress.pages')}>
                {detail.processed_pages}/{detail.total_pages}
              </Descriptions.Item>
            )}
            {(detail.total_chunks > 0 || detail.processed_chunks > 0) && (
              <Descriptions.Item label={t('parseProgress.chunks')}>
                {detail.processed_chunks}/{detail.total_chunks}
              </Descriptions.Item>
            )}
            <Descriptions.Item label={t('parseProgress.speed')}>
              {formatSpeed(detail.parse_speed)}
            </Descriptions.Item>
            <Descriptions.Item label={t('parseProgress.eta')}>
              {formatEta(detail.parse_eta)}
            </Descriptions.Item>
          </Descriptions>

          {detail.parse_error && (
            <div style={{
              padding: '8px 12px',
              background: token.colorErrorBg,
              borderRadius: 6,
              border: `1px solid ${token.colorErrorBorder}`,
            }}>
              <Text type="danger" style={{ fontSize: 12 }}>{t('parseProgress.errorLabel')} {detail.parse_error}</Text>
            </div>
          )}
        </div>
      )}
    </Modal>
  )
}

export default ParseDetailModal
