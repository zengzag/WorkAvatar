import React, { useState, useEffect, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { Drawer, Button, Tag, Space, Typography, Input, App, Spin, theme } from 'antd'
import {
  PushpinOutlined, PushpinFilled, ReloadOutlined, DeleteOutlined,
  EditOutlined, SaveOutlined, CloseOutlined, FileTextOutlined,
  ClockCircleOutlined, EyeOutlined, BookOutlined,
  StopOutlined, CheckCircleOutlined,
} from '@ant-design/icons'
import { formatRelativeTimeShort } from '../../utils/format'

const { Text, Paragraph } = Typography
const { TextArea } = Input

export interface KnowledgeCardKeyPoint {
  point: string
  sourceIndex: number
}

export interface KnowledgeCardCitation {
  fileId: string
  fileName: string
  filePath: string
  paragraphId?: string
  paragraphTitle?: string
  snippet: string
  startLine?: number
  endLine?: number
}

export interface KnowledgeCard {
  id: string
  keyword: string
  displayKeyword: string
  summary: string
  keyPoints: KnowledgeCardKeyPoint[]
  citations: KnowledgeCardCitation[]
  relatedFileIds: string[]
  status: 'active' | 'stale' | 'archived' | 'disabled' | 'generating'
  pinned: boolean
  searchCount: number
  createdAt: number
  updatedAt: number
  lastRefreshedAt: number
}

export interface SearchTraceStep {
  phase: string
  action: string
  detail?: string
  durationMs?: number
  type: 'info' | 'llm' | 'search' | 'read' | 'plan' | 'result'
}

const STEP_ICONS: Record<string, string> = {
  info: '•', llm: '🤖', search: '🔍', read: '📄', plan: '📋', result: '✓',
}

interface KnowledgeCardDetailProps {
  card: KnowledgeCard | null
  open: boolean
  onClose: () => void
  onRefresh?: () => void
  onDeleted?: () => void
  onOpenFile?: (filePath: string) => void
  /** 生成/刷新进度步骤 */
  progressSteps?: SearchTraceStep[]
  /** 是否正在生成/刷新中 */
  processing?: boolean
}

const KnowledgeCardDetail: React.FC<KnowledgeCardDetailProps> = ({
  card, open, onClose, onRefresh, onDeleted, onOpenFile,
  progressSteps, processing,
}) => {
  const { t, i18n } = useTranslation()
  const { token } = theme.useToken()
  const { message, modal } = App.useApp()
  const [editingSummary, setEditingSummary] = useState(false)
  const [summaryDraft, setSummaryDraft] = useState('')
  const [savingSummary, setSavingSummary] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [pinning, setPinning] = useState(false)
  const [localCard, setLocalCard] = useState<KnowledgeCard | null>(card)

  const stepTypeColors = React.useMemo<Record<string, string>>(() => ({
    info: token.colorTextTertiary,
    llm: token.colorInfo,
    search: token.colorPrimary,
    read: token.colorWarning,
    plan: token.colorSuccess,
    result: token.colorError,
  }), [token])

  useEffect(() => {
    setLocalCard(card)
    setEditingSummary(false)
  }, [card])

  const handleStartEdit = useCallback(() => {
    setSummaryDraft(localCard?.summary || '')
    setEditingSummary(true)
  }, [localCard])

  const handleCancelEdit = useCallback(() => {
    setEditingSummary(false)
    setSummaryDraft('')
  }, [])

  const handleSaveSummary = useCallback(async () => {
    if (!localCard) return
    setSavingSummary(true)
    try {
      const result = await window.electronAPI.kms.updateKnowledgeCard({
        id: localCard.id,
        summary: summaryDraft.trim(),
      })
      if (result?.success) {
        setLocalCard({ ...localCard, summary: summaryDraft.trim() })
        setEditingSummary(false)
        message.success(t('kms.knowledgeCards.saveSummary'))
      } else {
        message.error(result?.error || t('kms.knowledgeCards.saveSummary'))
      }
    } catch (err: any) {
      message.error(err?.message || t('kms.knowledgeCards.saveSummary'))
    } finally {
      setSavingSummary(false)
    }
  }, [localCard, summaryDraft, t, message])

  const handleDelete = useCallback(() => {
    if (!localCard) return
    modal.confirm({
      title: t('kms.knowledgeCards.deleteConfirm'),
      okText: t('common.delete'),
      okButtonProps: { danger: true },
      cancelText: t('common.cancel'),
      onOk: async () => {
        setDeleting(true)
        try {
          await window.electronAPI.kms.deleteKnowledgeCard(localCard.id)
          message.success(t('kms.knowledgeCards.deleteSuccess'))
          onDeleted?.()
          onClose()
        } catch (err: any) {
          message.error(err?.message || t('kms.knowledgeCards.deleteSuccess'))
        } finally {
          setDeleting(false)
        }
      },
    })
  }, [localCard, t, message, modal, onDeleted, onClose])

  const [disabling, setDisabling] = useState(false)

  const handleDisable = useCallback(() => {
    if (!localCard) return
    modal.confirm({
      title: t('kms.knowledgeCards.disableConfirm'),
      okText: t('kms.knowledgeCards.disable'),
      okButtonProps: { danger: true },
      cancelText: t('common.cancel'),
      onOk: async () => {
        setDisabling(true)
        try {
          await window.electronAPI.kms.disableKnowledgeCard(localCard.id)
          message.success(t('kms.knowledgeCards.disableSuccess'))
          setLocalCard({ ...localCard, status: 'disabled' })
          onDeleted?.()
        } catch (err: any) {
          message.error(err?.message || 'Failed')
        } finally {
          setDisabling(false)
        }
      },
    })
  }, [localCard, t, message, modal, onDeleted])

  const handleEnable = useCallback(async () => {
    if (!localCard) return
    try {
      await window.electronAPI.kms.enableKnowledgeCard(localCard.id)
      message.success(t('kms.knowledgeCards.enableSuccess'))
      setLocalCard({ ...localCard, status: 'active' })
    } catch (err: any) {
      message.error(err?.message || 'Failed')
    }
  }, [localCard, t, message])

  const handleTogglePin = useCallback(async () => {
    if (!localCard) return
    setPinning(true)
    try {
      const result = await window.electronAPI.kms.pinKnowledgeCard(localCard.id, !localCard.pinned)
      if (result?.success) {
        setLocalCard({ ...localCard, pinned: !localCard.pinned })
      }
    } catch (err: any) {
      message.error(err?.message || 'Failed')
    } finally {
      setPinning(false)
    }
  }, [localCard, message])

  const handleViewOriginal = useCallback((filePath: string) => {
    if (onOpenFile) {
      onOpenFile(filePath)
    } else {
      window.electronAPI.kms.openFile(filePath)
    }
  }, [onOpenFile])

  const renderStatusTag = (status: KnowledgeCard['status']) => {
    if (status === 'generating') return <Tag color="processing">{t('kms.knowledgeCards.generating')}</Tag>
    if (status === 'active') return <Tag color="green">{t('kms.knowledgeCards.statusActive')}</Tag>
    if (status === 'stale') return <Tag color="orange">{t('kms.knowledgeCards.statusStale')}</Tag>
    if (status === 'archived') return <Tag>{t('kms.knowledgeCards.statusArchived')}</Tag>
    if (status === 'disabled') return <Tag color="red">{t('kms.knowledgeCards.statusDisabled')}</Tag>
    return null
  }

  const renderProgressSection = () => {
    if (!processing || !progressSteps || progressSteps.length === 0) return null
    return (
      <div style={{
        marginBottom: 16,
        padding: '8px 12px',
        background: token.colorBgTextHover,
        borderRadius: token.borderRadiusLG,
        border: `1px solid ${token.colorBorderSecondary}`,
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
          <Spin size="small" />
          <Text type="secondary" style={{ fontSize: 12 }}>{t('kms.knowledgeCards.generating')}</Text>
        </div>
        {progressSteps.map((step, i) => (
          <div key={`step-${i}`} style={{
            display: 'flex', alignItems: 'flex-start', gap: 8, padding: '2px 0',
            fontSize: 12, lineHeight: 1.5, color: token.colorTextSecondary,
          }}>
            <span style={{ color: stepTypeColors[step.type] || token.colorTextTertiary, flexShrink: 0 }}>
              {STEP_ICONS[step.type] || '•'}
            </span>
            <div style={{ flex: 1, minWidth: 0 }}>
              <Text style={{ fontSize: 12, fontWeight: 500 }}>{step.action}</Text>
              {step.durationMs !== undefined && (
                <Text type="secondary" style={{ fontSize: 11, marginLeft: 8 }}>{step.durationMs}ms</Text>
              )}
              {step.detail && (
                <Text type="secondary" style={{ fontSize: 11, display: 'block', wordBreak: 'break-all' }}>{step.detail}</Text>
              )}
            </div>
          </div>
        ))}
      </div>
    )
  }

  const renderSummarySection = () => (
    <div style={{ marginBottom: 16 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
        <Text strong>{t('kms.knowledgeCards.summaryLabel')}</Text>
        {!processing && !editingSummary ? (
          <Button size="small" type="link" icon={<EditOutlined />} onClick={handleStartEdit}>
            {t('kms.knowledgeCards.editSummary')}
          </Button>
        ) : editingSummary ? (
          <Space size="small">
            <Button size="small" type="primary" icon={<SaveOutlined />} loading={savingSummary} onClick={handleSaveSummary}>
              {t('kms.knowledgeCards.saveSummary')}
            </Button>
            <Button size="small" icon={<CloseOutlined />} onClick={handleCancelEdit}>
              {t('kms.knowledgeCards.cancelEdit')}
            </Button>
          </Space>
        ) : null}
      </div>
      {editingSummary ? (
        <TextArea
          value={summaryDraft}
          onChange={e => setSummaryDraft(e.target.value)}
          autoSize={{ minRows: 4, maxRows: 10 }}
        />
      ) : (
        <Paragraph style={{ margin: 0, color: token.colorTextSecondary, lineHeight: 1.7 }}>
          {localCard?.summary || '-'}
        </Paragraph>
      )}
    </div>
  )

  const renderKeyPointsSection = () => (
    <div style={{ marginBottom: 16 }}>
      <Text strong style={{ display: 'block', marginBottom: 8 }}>{t('kms.knowledgeCards.keyPointsLabel')}</Text>
      {localCard?.keyPoints.length === 0 ? (
        <Text type="secondary">-</Text>
      ) : (
        localCard?.keyPoints.map((kp, i) => (
          <div key={i} style={{ display: 'flex', gap: 8, marginBottom: 8, alignItems: 'flex-start' }}>
            <Tag color="blue" style={{ flexShrink: 0, lineHeight: '20px' }}>[{kp.sourceIndex + 1}]</Tag>
            <Text style={{ fontSize: 13, lineHeight: 1.6 }}>{kp.point}</Text>
          </div>
        ))
      )}
    </div>
  )

  const renderCitationsSection = () => (
    <div>
      <Text strong style={{ display: 'block', marginBottom: 8 }}>{t('kms.knowledgeCards.citationsLabel')}</Text>
      {localCard?.citations.length === 0 ? (
        <Text type="secondary">{t('kms.knowledgeCards.noCitations')}</Text>
      ) : (
        localCard?.citations.map((cite, i) => (
          <div
            key={i}
            style={{
              marginBottom: 12, paddingBottom: 12,
              borderBottom: i < (localCard.citations.length - 1) ? `1px solid ${token.colorBorderSecondary}` : 'none',
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}>
              <Tag style={{ flexShrink: 0, lineHeight: '20px' }}>[{i + 1}]</Tag>
              <FileTextOutlined style={{ fontSize: 12, color: token.colorTextSecondary, flexShrink: 0 }} />
              <Text strong style={{ fontSize: 13, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {cite.fileName}
              </Text>
              {cite.paragraphTitle && (
                <Text type="secondary" style={{ fontSize: 12 }}>· {cite.paragraphTitle}</Text>
              )}
            </div>
            {cite.startLine !== undefined && cite.endLine !== undefined && (
              <Text type="secondary" style={{ fontSize: 11, display: 'block', marginLeft: 28 }}>
                L{cite.startLine}-L{cite.endLine}
              </Text>
            )}
            <Text style={{ fontSize: 12, display: 'block', marginLeft: 28, marginTop: 4, color: token.colorTextSecondary, lineHeight: 1.6 }}>
              {cite.snippet}
            </Text>
            <Button
              size="small"
              type="link"
              icon={<EyeOutlined />}
              onClick={() => handleViewOriginal(cite.filePath)}
              style={{ padding: 0, marginTop: 4, marginLeft: 28, height: 22 }}
            >
              {t('kms.knowledgeCards.viewOriginal')}
            </Button>
          </div>
        ))
      )}
    </div>
  )

  return (
    <Drawer
      title={
        localCard ? (
          <Space>
            <BookOutlined style={{ color: token.colorPrimary }} />
            <span>{localCard.displayKeyword}</span>
            {renderStatusTag(localCard.status)}
          </Space>
        ) : t('kms.knowledgeCards.title')
      }
      open={open}
      onClose={onClose}
      size={640}
      styles={{ body: { padding: 16, display: 'flex', flexDirection: 'column' } }}
    >
      {!localCard ? (
        <div style={{ textAlign: 'center', padding: 48 }}>
          <Spin />
        </div>
      ) : (
        <>
          <div style={{ flex: 1, overflow: 'auto', minHeight: 0 }}>
            {/* 元信息 */}
            {!processing && (
              <div style={{ display: 'flex', gap: 16, marginBottom: 16, paddingBottom: 12, borderBottom: `1px solid ${token.colorBorderSecondary}` }}>
                <Text type="secondary" style={{ fontSize: 12 }}>
                  {t('kms.knowledgeCards.searchCount', { count: localCard.searchCount })}
                </Text>
                {localCard.lastRefreshedAt > 0 && (
                  <Text type="secondary" style={{ fontSize: 12 }}>
                    <ClockCircleOutlined style={{ marginRight: 4 }} />
                    {t('kms.knowledgeCards.refreshedAgo', { time: formatRelativeTimeShort(localCard.lastRefreshedAt, i18n.language) })}
                  </Text>
                )}
              </div>
            )}

            {/* 生成/刷新进度 */}
            {renderProgressSection()}

            {/* 卡片内容（生成中只显示已有摘要，完成后显示完整内容） */}
            {localCard.summary && renderSummarySection()}
            {localCard.keyPoints.length > 0 && renderKeyPointsSection()}
            {localCard.citations.length > 0 && renderCitationsSection()}
          </div>

          {/* 底部操作栏（处理中不显示） */}
          {!processing && (
            <div style={{
              flexShrink: 0, paddingTop: 12,
              borderTop: `1px solid ${token.colorBorderSecondary}`,
              display: 'flex', justifyContent: 'space-between', alignItems: 'center',
            }}>
              <Button
                icon={localCard.pinned ? <PushpinFilled style={{ color: token.colorPrimary }} /> : <PushpinOutlined />}
                onClick={handleTogglePin}
                loading={pinning}
                disabled={localCard.status === 'disabled'}
              >
                {localCard.pinned ? t('kms.knowledgeCards.unpin') : t('kms.knowledgeCards.pin')}
              </Button>
              <Space>
                {localCard.status === 'disabled' ? (
                  <Button icon={<CheckCircleOutlined />} onClick={handleEnable}>
                    {t('kms.knowledgeCards.enable')}
                  </Button>
                ) : (
                  <Button icon={<StopOutlined />} onClick={handleDisable} loading={disabling}>
                    {t('kms.knowledgeCards.disable')}
                  </Button>
                )}
                <Button icon={<ReloadOutlined />} onClick={() => onRefresh?.()} loading={processing}>
                  {t('common.refresh')}
                </Button>
                <Button danger icon={<DeleteOutlined />} onClick={handleDelete} loading={deleting}>
                  {t('common.delete')}
                </Button>
              </Space>
            </div>
          )}
        </>
      )}
    </Drawer>
  )
}

export default KnowledgeCardDetail
