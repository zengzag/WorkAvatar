import React, { useState, useEffect, useCallback, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import {
  Card, Button, Empty, Spin, Space, Tag, Input, Select, App, Typography, theme,
} from 'antd'
import {
  ThunderboltOutlined, ReloadOutlined, PushpinFilled, BookOutlined,
} from '@ant-design/icons'
import KnowledgeCardDetail from './KnowledgeCardDetail'
import type { KnowledgeCard, SearchTraceStep } from './KnowledgeCardDetail'
import { formatRelativeTimeShort } from '../../utils/format'

const { Text, Paragraph } = Typography

interface KMSKnowledgeCardsViewProps {
  onOpenFile?: (filePath: string) => void
}

const KMSKnowledgeCardsView: React.FC<KMSKnowledgeCardsViewProps> = ({ onOpenFile }) => {
  const { t, i18n } = useTranslation()
  const { token } = theme.useToken()
  const { message } = App.useApp()

  const [cards, setCards] = useState<KnowledgeCard[]>([])
  const [loading, setLoading] = useState(false)
  const [filterStatus, setFilterStatus] = useState<'active' | 'stale' | 'archived' | undefined>(undefined)
  const [generatingKeyword, setGeneratingKeyword] = useState('')
  const [generating, setGenerating] = useState(false)
  const [refreshingStale, setRefreshingStale] = useState(false)

  const [detailCard, setDetailCard] = useState<KnowledgeCard | null>(null)
  const [detailOpen, setDetailOpen] = useState(false)
  const [detailProcessing, setDetailProcessing] = useState(false)
  const [detailProgressSteps, setDetailProgressSteps] = useState<SearchTraceStep[]>([])

  const progressUnsubscribeRef = useRef<(() => void) | null>(null)

  const loadCards = useCallback(async () => {
    setLoading(true)
    try {
      const result = await window.electronAPI.kms.getKnowledgeCards({
        status: filterStatus,
        limit: 100,
      })
      if (result) {
        setCards(result.cards || [])
      }
    } catch (err: any) {
      message.error(err?.message || 'Failed to load cards')
    } finally {
      setLoading(false)
    }
  }, [filterStatus, message])

  useEffect(() => {
    loadCards()
  }, [loadCards])

  // 清理进度订阅
  useEffect(() => {
    return () => {
      progressUnsubscribeRef.current?.()
    }
  }, [])

  const subscribeProgress = useCallback(() => {
    progressUnsubscribeRef.current?.()
    setDetailProgressSteps([])
    progressUnsubscribeRef.current = window.electronAPI.kms.onKnowledgeCardProgress((step: SearchTraceStep) => {
      setDetailProgressSteps(prev => [...prev, step])
    })
  }, [])

  const unsubscribeProgress = useCallback(() => {
    progressUnsubscribeRef.current?.()
    progressUnsubscribeRef.current = null
  }, [])

  const handleGenerate = useCallback(async (keyword: string) => {
    const kw = keyword.trim()
    if (!kw) return

    // 先建空卡片占位，打开详情抽屉展示进度
    const placeholderCard: KnowledgeCard = {
      id: '__generating__',
      keyword: kw,
      displayKeyword: kw,
      summary: '',
      keyPoints: [],
      citations: [],
      relatedFileIds: [],
      status: 'generating',
      pinned: false,
      searchCount: 0,
      createdAt: Math.floor(Date.now() / 1000),
      updatedAt: Math.floor(Date.now() / 1000),
      lastRefreshedAt: 0,
    }

    setDetailCard(placeholderCard)
    setDetailOpen(true)
    setDetailProcessing(true)
    setGenerating(true)
    subscribeProgress()

    try {
      const result = await window.electronAPI.kms.generateKnowledgeCard(kw)
      if (result?.success) {
        message.success(t('kms.knowledgeCards.generateSuccess'))
        setGeneratingKeyword('')
        // 用最终卡片替换占位卡片
        if (result.card) {
          setDetailCard(result.card as KnowledgeCard)
        }
        setDetailProcessing(false)
        loadCards()
      } else {
        const err = result?.error
        if (err === 'NO_LLM_PROVIDER') {
          message.warning(t('kms.knowledgeCards.noLLMProvider'))
        } else if (err === 'NO_SEARCH_RESULTS') {
          message.warning(t('kms.knowledgeCards.noSearchResults'))
        } else if (err === 'CARD_ALREADY_EXISTS') {
          message.warning(t('kms.knowledgeCards.cardAlreadyExists'))
        } else {
          message.error(t('kms.knowledgeCards.generateFailed', { error: err || '' }))
        }
        setDetailProcessing(false)
        setDetailOpen(false)
      }
    } catch (err: any) {
      message.error(t('kms.knowledgeCards.generateFailed', { error: err?.message || '' }))
      setDetailProcessing(false)
      setDetailOpen(false)
    } finally {
      unsubscribeProgress()
      setGenerating(false)
    }
  }, [t, message, loadCards, subscribeProgress, unsubscribeProgress])

  const handleRefreshStale = useCallback(async () => {
    setRefreshingStale(true)
    try {
      const result = await window.electronAPI.kms.getKnowledgeCards({ status: 'stale', limit: 50 })
      const staleCards = result?.cards || []
      if (staleCards.length === 0) {
        message.info(t('kms.knowledgeCards.noCardsFiltered'))
        return
      }
      for (const card of staleCards) {
        try {
          await window.electronAPI.kms.refreshKnowledgeCard(card.id)
        } catch {}
      }
      message.success(t('kms.knowledgeCards.refreshSuccess'))
      loadCards()
    } catch (err: any) {
      message.error(t('kms.knowledgeCards.refreshFailed', { error: err?.message || '' }))
    } finally {
      setRefreshingStale(false)
    }
  }, [t, message, loadCards])

  const openDetail = useCallback((card: KnowledgeCard) => {
    setDetailCard(card)
    setDetailOpen(true)
    setDetailProcessing(false)
    setDetailProgressSteps([])
  }, [])

  const closeDetail = useCallback(() => {
    // 处理中不允许关闭（或允许取消？暂时允许关闭）
    setDetailOpen(false)
    setDetailCard(null)
    setDetailProcessing(false)
    setDetailProgressSteps([])
    unsubscribeProgress()
  }, [unsubscribeProgress])

  const handleDetailRefresh = useCallback(async () => {
    if (!detailCard || detailCard.id === '__generating__') return

    setDetailProcessing(true)
    setDetailProgressSteps([])
    subscribeProgress()

    try {
      const result = await window.electronAPI.kms.refreshKnowledgeCard(detailCard.id)
      if (result?.success) {
        message.success(t('kms.knowledgeCards.refreshSuccess'))
        loadCards()
        // 用新卡片替换旧卡片，保持抽屉打开
        if (result.card) {
          setDetailCard(result.card as KnowledgeCard)
        }
        setDetailProcessing(false)
      } else {
        message.error(t('kms.knowledgeCards.refreshFailed', { error: result?.error || '' }))
        setDetailProcessing(false)
      }
    } catch (err: any) {
      message.error(t('kms.knowledgeCards.refreshFailed', { error: err?.message || '' }))
      setDetailProcessing(false)
    } finally {
      unsubscribeProgress()
    }
  }, [detailCard, t, message, loadCards, subscribeProgress, unsubscribeProgress])

  const handleDetailDeleted = useCallback(() => {
    loadCards()
  }, [loadCards])

  const renderStatusTag = (status: KnowledgeCard['status']) => {
    if (status === 'stale') {
      return <Tag color="orange" style={{ fontSize: 10, margin: 0, padding: '0 4px', lineHeight: '16px' }}>{t('kms.knowledgeCards.statusStale')}</Tag>
    }
    if (status === 'archived') {
      return <Tag style={{ fontSize: 10, margin: 0, padding: '0 4px', lineHeight: '16px' }}>{t('kms.knowledgeCards.statusArchived')}</Tag>
    }
    return null
  }

  const statusOptions = [
    { label: t('kms.knowledgeCards.filterAll'), value: '' },
    { label: t('kms.knowledgeCards.filterActive'), value: 'active' },
    { label: t('kms.knowledgeCards.filterStale'), value: 'stale' },
    { label: t('kms.knowledgeCards.filterArchived'), value: 'archived' },
  ]

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      {/* 顶部标题 */}
      <div style={{ flexShrink: 0, marginBottom: 8 }}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 4 }}>
          <Text strong style={{ fontSize: 16 }}>{t('kms.knowledgeCards.title')}</Text>
          <Text type="secondary" style={{ fontSize: 12 }}>{t('kms.knowledgeCards.subtitle')}</Text>
        </div>
      </div>

      {/* 操作栏 */}
      <div style={{ display: 'flex', gap: 8, marginBottom: 12, flexWrap: 'wrap', flexShrink: 0, alignItems: 'center' }}>
        <Input.Search
          placeholder={t('kms.knowledgeCards.generatePlaceholder')}
          value={generatingKeyword}
          onChange={e => setGeneratingKeyword(e.target.value)}
          onSearch={handleGenerate}
          enterButton={t('kms.knowledgeCards.generateNew')}
          loading={generating}
          style={{ width: 280 }}
        />
        <Button
          icon={<ThunderboltOutlined />}
          onClick={handleRefreshStale}
          loading={refreshingStale}
        >
          {t('kms.knowledgeCards.refreshAll')}
        </Button>
        <Select
          value={filterStatus || ''}
          onChange={v => setFilterStatus((v || undefined) as 'active' | 'stale' | 'archived' | undefined)}
          options={statusOptions}
          style={{ width: 130 }}
          popupMatchSelectWidth={false}
        />
        <div style={{ flex: 1 }} />
        <Button
          icon={<ReloadOutlined />}
          onClick={loadCards}
          loading={loading}
        >
          {t('common.refresh')}
        </Button>
      </div>

      {/* 卡片网格 */}
      <div style={{ flex: 1, minHeight: 0, overflow: 'auto' }}>
        {loading ? (
          <div style={{ textAlign: 'center', padding: 48 }}>
            <Spin />
          </div>
        ) : cards.length === 0 ? (
          <Empty
            image={Empty.PRESENTED_IMAGE_SIMPLE}
            description={filterStatus ? t('kms.knowledgeCards.noCardsFiltered') : t('kms.knowledgeCards.noCards')}
            style={{ marginTop: 80 }}
          />
        ) : (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: 12 }}>
            {cards.map(card => (
              <Card
                key={card.id}
                size="small"
                hoverable
                onClick={() => openDetail(card)}
                style={{ cursor: 'pointer', borderColor: card.pinned ? token.colorPrimary : undefined }}
              >
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 6 }}>
                  <Space size={4} style={{ minWidth: 0 }}>
                    <BookOutlined style={{ color: token.colorPrimary, fontSize: 14, flexShrink: 0 }} />
                    <Text strong style={{ fontSize: 13, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {card.displayKeyword}
                    </Text>
                  </Space>
                  {card.pinned && (
                    <PushpinFilled style={{ color: token.colorPrimary, fontSize: 12, flexShrink: 0 }} />
                  )}
                </div>
                <Paragraph
                  style={{ fontSize: 12, marginBottom: 8, color: token.colorTextSecondary, lineHeight: 1.5 }}
                  ellipsis={{ rows: 3 }}
                >
                  {card.summary || '-'}
                </Paragraph>
                <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
                  {renderStatusTag(card.status)}
                  <Tag style={{ fontSize: 10, margin: 0, padding: '0 4px', lineHeight: '16px' }}>
                    {t('kms.knowledgeCards.searchCount', { count: card.searchCount })}
                  </Tag>
                  {card.lastRefreshedAt > 0 && (
                    <Text type="secondary" style={{ fontSize: 11, marginLeft: 'auto' }}>
                      {t('kms.knowledgeCards.refreshedAgo', { time: formatRelativeTimeShort(card.lastRefreshedAt, i18n.language) })}
                    </Text>
                  )}
                </div>
              </Card>
            ))}
          </div>
        )}
      </div>

      {/* 卡片详情抽屉（含生成进度） */}
      <KnowledgeCardDetail
        card={detailCard}
        open={detailOpen}
        onClose={closeDetail}
        onRefresh={handleDetailRefresh}
        onDeleted={handleDetailDeleted}
        onOpenFile={onOpenFile}
        progressSteps={detailProgressSteps}
        processing={detailProcessing}
      />
    </div>
  )
}

export default KMSKnowledgeCardsView
