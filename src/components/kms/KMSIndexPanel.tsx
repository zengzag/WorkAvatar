import React from 'react'
import { useTranslation } from 'react-i18next'
import {
  Button, Card, Space, Progress, Typography, Spin, theme,
} from 'antd'
import {
  DatabaseOutlined, FileTextOutlined, ThunderboltOutlined,
  SyncOutlined, BuildOutlined, StopOutlined,
  FireOutlined, InboxOutlined,
} from '@ant-design/icons'

const { Text, Title } = Typography

interface IndexProgress {
  phase: string
  current: number
  total: number
  message: string
}

interface KMSStats {
  dirs: { total: number; enabled: number }
  files: { total: number; byStatus: Record<string, number>; byTier: Record<string, number>; byExt: Record<string, number> }
  index: { totalEntries: number; byType: Record<string, number>; embeddingCount: number; ftsEntryCount: number }
}

interface KMSIndexPanelProps {
  stats: KMSStats | null
  isIndexing: boolean
  indexProgress: IndexProgress | null
  onBuildIndex: () => void
  onIncrementalIndex: () => void
  onRebuildIndex: () => void
  onCancelIndex: () => void
}

const PHASE_LABEL_KEYS: Record<string, string> = {
  crawling: 'kms.indexPhaseCrawling',
  parsing: 'kms.indexPhaseParsing',
  indexing: 'kms.indexPhaseIndexing',
  embedding: 'kms.indexPhaseEmbedding',
  done: 'kms.indexPhaseDone',
  error: 'kms.indexPhaseError',
}

const KMSIndexPanel: React.FC<KMSIndexPanelProps> = ({
  stats,
  isIndexing,
  indexProgress,
  onBuildIndex,
  onIncrementalIndex,
  onRebuildIndex,
  onCancelIndex,
}) => {
  const { t } = useTranslation()
  const { token } = theme.useToken()

  const totalFiles = stats?.files?.total ?? 0
  const indexedFiles = stats?.files?.byStatus?.completed ?? 0
  const pendingFiles = stats?.files?.byStatus?.pending ?? 0
  const failedFiles = stats?.files?.byStatus?.failed ?? 0
  const hotFiles = stats?.files?.byTier?.hot ?? 0
  const coldFiles = stats?.files?.byTier?.cold ?? 0
  const indexEntries = stats?.index?.totalEntries ?? 0
  const embeddingCount = stats?.index?.embeddingCount ?? 0

  const statCards = [
    { label: t('kms.totalFiles'), value: totalFiles, icon: <FileTextOutlined style={{ color: token.colorPrimary }} /> },
    { label: t('kms.indexedFiles'), value: indexedFiles, icon: <DatabaseOutlined style={{ color: token.colorSuccess }} /> },
    { label: t('kms.pendingFiles'), value: pendingFiles, icon: <ThunderboltOutlined style={{ color: token.colorWarning }} /> },
    { label: t('kms.failedFiles'), value: failedFiles, icon: <FileTextOutlined style={{ color: token.colorError }} /> },
    { label: t('kms.hotFiles'), value: hotFiles, icon: <FireOutlined style={{ color: '#f5222d' }} /> },
    { label: t('kms.coldFiles'), value: coldFiles, icon: <InboxOutlined style={{ color: token.colorTextQuaternary }} /> },
    { label: t('kms.indexEntries'), value: indexEntries, icon: <DatabaseOutlined style={{ color: token.colorInfo }} /> },
    { label: t('kms.embeddingCount'), value: embeddingCount, icon: <ThunderboltOutlined style={{ color: '#722ed1' }} /> },
  ]

  const progressPercent = indexProgress && indexProgress.total > 0
    ? Math.round((indexProgress.current / indexProgress.total) * 100)
    : 0

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', gap: 16 }}>
      <div style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fill, minmax(140px, 1fr))',
        gap: 12,
      }}>
        {statCards.map((card) => (
          <Card
            key={card.label}
            size="small"
            style={{ textAlign: 'center' }}
          >
            <div style={{ marginBottom: 4 }}>{card.icon}</div>
            <Title level={4} style={{ margin: 0, fontSize: 20 }}>{card.value}</Title>
            <Text type="secondary" style={{ fontSize: 12 }}>{card.label}</Text>
          </Card>
        ))}
      </div>

      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <Button
          type="primary"
          icon={<BuildOutlined />}
          onClick={() => onBuildIndex()}
          disabled={isIndexing}
          loading={isIndexing && indexProgress?.phase === 'crawling'}
        >
          {t('kms.buildIndex')}
        </Button>
        <Button
          icon={<SyncOutlined />}
          onClick={() => onIncrementalIndex()}
          disabled={isIndexing}
        >
          {t('kms.incrementalIndex')}
        </Button>
        <Button
          icon={<ThunderboltOutlined />}
          onClick={() => onRebuildIndex()}
          disabled={isIndexing}
        >
          {t('kms.rebuildIndex')}
        </Button>
        {isIndexing && (
          <Button
            danger
            icon={<StopOutlined />}
            onClick={() => onCancelIndex()}
          >
            {t('kms.cancelIndex')}
          </Button>
        )}
      </div>

      {isIndexing && indexProgress && (
        <Card size="small" style={{ borderColor: token.colorPrimary }}>
          <div style={{ marginBottom: 8 }}>
            <Space>
              <Spin size="small" />
              <Text strong>
                {t(PHASE_LABEL_KEYS[indexProgress.phase] || indexProgress.phase)}
              </Text>
            </Space>
          </div>
          {indexProgress.total > 0 && (
            <Progress
              percent={progressPercent}
              size="small"
              format={() => `${indexProgress.current} / ${indexProgress.total}`}
            />
          )}
          {indexProgress.message && (
            <Text type="secondary" style={{ fontSize: 12, display: 'block', marginTop: 4 }}>
              {indexProgress.message}
            </Text>
          )}
        </Card>
      )}

      {!isIndexing && indexProgress && (indexProgress.phase === 'done' || indexProgress.phase === 'error') && (
        <Card
          size="small"
          style={{
            borderColor: indexProgress.phase === 'done' ? token.colorSuccess : token.colorError,
            backgroundColor: indexProgress.phase === 'done' ? token.colorSuccessBg : token.colorErrorBg,
          }}
        >
          <Text style={{ color: indexProgress.phase === 'done' ? token.colorSuccess : token.colorError }}>
            {t(PHASE_LABEL_KEYS[indexProgress.phase] || indexProgress.phase)}
          </Text>
          {indexProgress.message && (
            <Text type="secondary" style={{ fontSize: 12, display: 'block', marginTop: 4 }}>
              {indexProgress.message}
            </Text>
          )}
        </Card>
      )}
    </div>
  )
}

export default KMSIndexPanel
