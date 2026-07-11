import React from 'react'
import { useTranslation } from 'react-i18next'
import { Card, Space, Tooltip, Tag, Button, Popconfirm, Typography, theme } from 'antd'
import {
  FolderOutlined, SearchOutlined, ThunderboltOutlined, LoadingOutlined,
  FileTextOutlined, EditOutlined, DeleteOutlined, ExclamationCircleOutlined,
} from '@ant-design/icons'
import { formatTime } from '../kms-columns'
import type { CollectionItem } from './index'
import {
  type CollectionStats,
  type CollectionSummary,
  type ProcessingCollectionState,
  parseJsonArray,
} from './collection-types'

const { Text, Paragraph } = Typography

export interface CollectionCardHandlers {
  onSearchInCollection?: (collectionId: string) => void
  onProcessDeep: (collection: CollectionItem) => void
  onOpenSummaryModal: (collection: CollectionItem) => void
  onOpenEditModal: (collection: CollectionItem) => void
  onDeleteCollection: (collection: CollectionItem) => void
  onOpenFilesDrawer: (collection: CollectionItem) => void
}

interface CollectionCardProps {
  collection: CollectionItem
  summary: CollectionSummary | null | undefined
  stats: CollectionStats | null | undefined
  processing?: ProcessingCollectionState
  handlers: CollectionCardHandlers
}

const CollectionCard: React.FC<CollectionCardProps> = ({
  collection: c,
  summary,
  stats,
  processing,
  handlers,
}) => {
  const { t } = useTranslation()
  const { token } = theme.useToken()

  const keyTopics = parseJsonArray(summary?.key_topics_json)

  const statsTag = (() => {
    if (!stats) return null
    const { indexedCount, fileCount, pendingCount } = stats
    if (fileCount === 0) {
      return <Tag style={{ fontSize: 11 }}>{t('kms.collections.fileCount', { count: 0 })}</Tag>
    }
    let color = 'success'
    if (pendingCount > 0 || indexedCount < fileCount) color = 'processing'
    return (
      <Tooltip title={pendingCount > 0 ? t('kms.collections.pendingIndexHint', { count: pendingCount }) : ''}>
        <Tag color={color} style={{ fontSize: 11 }}>
          {t('kms.collections.indexedCount', { count: indexedCount, total: fileCount })}
        </Tag>
      </Tooltip>
    )
  })()

  return (
    <Card
      size="small"
      hoverable
      styles={{ body: { padding: 12 } }}
      onClick={() => handlers.onOpenFilesDrawer(c)}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 6 }}>
        <Space size={6} style={{ minWidth: 0, flex: 1 }}>
          <FolderOutlined style={{ color: token.colorPrimary, fontSize: 16, flexShrink: 0 }} />
          <Text strong ellipsis style={{ fontSize: 14 }}>{c.name}</Text>
        </Space>
        <Space size={2} onClick={(e) => e.stopPropagation()}>
          <Tooltip title={t('kms.collections.searchInCollection')}>
            <Button type="text" size="small" icon={<SearchOutlined />} onClick={() => handlers.onSearchInCollection?.(c.id)} />
          </Tooltip>
          <Tooltip title={processing ? t('kms.collectionProcess.viewProgress') : t('kms.collectionProcess.title')}>
            <Button
              type="text"
              size="small"
              icon={processing ? <LoadingOutlined /> : <ThunderboltOutlined />}
              onClick={() => handlers.onProcessDeep(c)}
            />
          </Tooltip>
          <Tooltip title={t('kms.collections.editSummary')}>
            <Button type="text" size="small" icon={<FileTextOutlined />} onClick={() => handlers.onOpenSummaryModal(c)} />
          </Tooltip>
          <Tooltip title={t('kms.collections.editCollection')}>
            <Button type="text" size="small" icon={<EditOutlined />} onClick={() => handlers.onOpenEditModal(c)} />
          </Tooltip>
          <Popconfirm
            title={t('kms.collections.deleteCollectionConfirm')}
            icon={<ExclamationCircleOutlined style={{ color: token.colorError }} />}
            onConfirm={() => handlers.onDeleteCollection(c)}
          >
            <Button type="text" size="small" danger icon={<DeleteOutlined />} />
          </Popconfirm>
        </Space>
      </div>

      {c.description && (
        <Paragraph type="secondary" ellipsis={{ rows: 1 }} style={{ fontSize: 12, marginBottom: 6, marginTop: 2 }}>
          {c.description}
        </Paragraph>
      )}

      {summary?.summary ? (
        <Tooltip title={summary.summary}>
          <Paragraph type="secondary" ellipsis={{ rows: 2 }} style={{ fontSize: 12, marginBottom: 6, color: token.colorTextSecondary }}>
            {summary.summary}
          </Paragraph>
        </Tooltip>
      ) : (
        <div style={{ marginBottom: 6 }}>
          <Text type="secondary" style={{ fontSize: 11, opacity: 0.6, fontStyle: 'italic' }}>
            {t('kms.collections.noCollectionSummary')}
          </Text>
        </div>
      )}

      {keyTopics.length > 0 && (
        <div style={{ marginBottom: 6, display: 'flex', gap: 4, flexWrap: 'wrap' }}>
          {keyTopics.slice(0, 4).map((topic, idx) => (
            <Tag key={`topic-${idx}-${topic}`} color="purple" style={{ fontSize: 10, margin: 0 }}>{topic}</Tag>
          ))}
          {keyTopics.length > 4 && (
            <Tag style={{ fontSize: 10, margin: 0 }}>+{keyTopics.length - 4}</Tag>
          )}
        </div>
      )}

      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center', marginTop: 4 }}>
        {statsTag}
        <Tag style={{ fontSize: 11 }}>{formatTime(c.updated_at, 'datetime')}</Tag>
      </div>
    </Card>
  )
}

export default CollectionCard
