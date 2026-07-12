import React, { useState, useEffect, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { Tag, Button, Typography, theme } from 'antd'
import { BookOutlined, RightOutlined } from '@ant-design/icons'
import { formatRelativeTimeShort } from '../../utils/format'
import type { KnowledgeCard } from './KnowledgeCardDetail'

const { Text } = Typography

/** 搜索防抖延迟（毫秒） */
const DEBOUNCE_MS = 500
/** 摘要预览最大长度 */
const SUMMARY_PREVIEW_LEN = 100

interface KnowledgeCardBannerProps {
  query: string
  onViewCard?: (card: KnowledgeCard) => void
}

const KnowledgeCardBanner: React.FC<KnowledgeCardBannerProps> = ({ query, onViewCard }) => {
  const { t, i18n } = useTranslation()
  const { token } = theme.useToken()
  const [card, setCard] = useState<KnowledgeCard | null>(null)
  const queryRef = useRef(query)
  const mountedRef = useRef(true)

  useEffect(() => {
    mountedRef.current = true
    return () => { mountedRef.current = false }
  }, [])

  useEffect(() => {
    const trimmed = query.trim()
    queryRef.current = trimmed
    if (!trimmed) {
      setCard(null)
      return
    }
    const timer = setTimeout(async () => {
      try {
        const result = await window.electronAPI.kms.searchKnowledgeCards({ query: trimmed, topK: 1 })
        if (!mountedRef.current) return
        // 防抖过期检查：避免旧查询覆盖新结果
        if (queryRef.current !== trimmed) return
        const cards = Array.isArray(result) ? result : []
        setCard(cards.length > 0 ? cards[0] : null)
      } catch {
        if (mountedRef.current) setCard(null)
      }
    }, DEBOUNCE_MS)
    return () => clearTimeout(timer)
  }, [query])

  if (!card) return null

  const summaryPreview = card.summary.length > SUMMARY_PREVIEW_LEN
    ? card.summary.substring(0, SUMMARY_PREVIEW_LEN) + '...'
    : card.summary

  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        padding: '8px 12px',
        background: token.colorInfoBg,
        borderLeft: `3px solid ${token.colorInfo}`,
        borderRadius: 4,
      }}
    >
      <BookOutlined style={{ color: token.colorInfo, fontSize: 16, flexShrink: 0 }} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 2 }}>
          <Text strong style={{ fontSize: 12 }}>{t('kms.knowledgeCards.bannerTitle')}</Text>
          <Text style={{ fontSize: 12, color: token.colorTextSecondary }}>· {card.displayKeyword}</Text>
          {card.status === 'stale' && (
            <Tag color="orange" style={{ fontSize: 10, margin: 0, lineHeight: '16px', padding: '0 4px' }}>
              {t('kms.knowledgeCards.statusStale')}
            </Tag>
          )}
        </div>
        <Text type="secondary" style={{ fontSize: 12, display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {summaryPreview}
        </Text>
        <div style={{ display: 'flex', gap: 12, marginTop: 2 }}>
          <Text type="secondary" style={{ fontSize: 11 }}>
            {t('kms.knowledgeCards.bannerSearchCount', { count: card.searchCount })}
          </Text>
          {card.citations.length > 0 && (
            <Text type="secondary" style={{ fontSize: 11 }}>
              {t('kms.knowledgeCards.bannerSources', { count: card.citations.length })}
            </Text>
          )}
          {card.lastRefreshedAt > 0 && (
            <Text type="secondary" style={{ fontSize: 11 }}>
              {t('kms.knowledgeCards.refreshedAgo', { time: formatRelativeTimeShort(card.lastRefreshedAt, i18n.language) })}
            </Text>
          )}
        </div>
      </div>
      <Button
        type="link"
        size="small"
        onClick={() => onViewCard?.(card)}
        style={{ flexShrink: 0, fontSize: 12 }}
      >
        {t('kms.knowledgeCards.bannerViewDetail')}
        <RightOutlined style={{ fontSize: 10, marginLeft: 2 }} />
      </Button>
    </div>
  )
}

export default KnowledgeCardBanner
