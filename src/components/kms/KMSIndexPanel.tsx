import React, { useState, useEffect, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import {
  Button, Card, Space, Progress, Typography, Spin, theme, Switch, InputNumber, Tooltip, Tag, App,
} from 'antd'
import {
  DatabaseOutlined, FileTextOutlined, ThunderboltOutlined,
  SyncOutlined, BuildOutlined, StopOutlined,
  FireOutlined, InboxOutlined, ClockCircleOutlined, RadarChartOutlined,
  PlayCircleOutlined, InfoCircleOutlined, SaveOutlined,
} from '@ant-design/icons'
import type { KMSAutoIndexConfig, KMSAutoIndexStatus } from '../../hooks/useKMS'

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
  // 自动索引
  autoIndexConfig: KMSAutoIndexConfig
  autoIndexStatus: KMSAutoIndexStatus | null
  onSaveAutoIndex: (config: KMSAutoIndexConfig) => Promise<boolean>
  onRunAutoIndexCheck: () => void
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
  autoIndexConfig,
  autoIndexStatus,
  onSaveAutoIndex,
  onRunAutoIndexCheck,
}) => {
  const { t } = useTranslation()
  const { token } = theme.useToken()
  const { message } = App.useApp()

  // 本地编辑态
  const [autoEnabled, setAutoEnabled] = useState(autoIndexConfig.enabled)
  const [intervalMin, setIntervalMin] = useState(autoIndexConfig.intervalMinutes)
  const [stableThreshold, setStableThreshold] = useState(autoIndexConfig.stableThresholdSeconds)
  const [savingAuto, setSavingAuto] = useState(false)

  useEffect(() => {
    setAutoEnabled(autoIndexConfig.enabled)
    setIntervalMin(autoIndexConfig.intervalMinutes)
    setStableThreshold(autoIndexConfig.stableThresholdSeconds)
  }, [autoIndexConfig])

  const handleSaveAutoIndex = useCallback(async () => {
    setSavingAuto(true)
    const ok = await onSaveAutoIndex({
      enabled: autoEnabled,
      intervalMinutes: intervalMin,
      stableThresholdSeconds: stableThreshold,
    })
    setSavingAuto(false)
    if (ok) {
      message.success(t('kms.settingsPanel.autoIndexSaved'))
    } else {
      message.error(t('kms.settingsPanel.modelSaveFailed'))
    }
  }, [autoEnabled, intervalMin, stableThreshold, onSaveAutoIndex, message, t])

  // 格式化时间戳为可读字符串
  const formatTime = (ts: number | null): string => {
    if (!ts) return '-'
    const d = new Date(ts * 1000)
    const h = String(d.getHours()).padStart(2, '0')
    const m = String(d.getMinutes()).padStart(2, '0')
    const s = String(d.getSeconds()).padStart(2, '0')
    return `${h}:${m}:${s}`
  }

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
      {/* 自动索引配置 */}
      <Card
        size="small"
        style={{ borderColor: token.colorBorderSecondary }}
        title={
          <Space size={6}>
            <RadarChartOutlined style={{ color: token.colorPrimary }} />
            <Text strong style={{ fontSize: 13 }}>{t('kms.settingsPanel.autoIndexTitle')}</Text>
            <Tooltip title={t('kms.settingsPanel.autoIndexHint')}>
              <InfoCircleOutlined style={{ color: token.colorTextTertiary, fontSize: 12, cursor: 'help' }} />
            </Tooltip>
          </Space>
        }
        extra={
          <Space size={8}>
            {autoIndexStatus?.running && (
              <Tag color="processing" style={{ fontSize: 10, margin: 0, lineHeight: '18px', padding: '0 6px' }}>
                <Spin size="small" style={{ marginRight: 2 }} />{t('kms.settingsPanel.autoIndexRunning')}
              </Tag>
            )}
            {autoIndexStatus?.config.enabled && !autoIndexStatus?.running && (
              <Tag color="success" style={{ fontSize: 10, margin: 0, lineHeight: '18px', padding: '0 6px' }}>
                {t('kms.settingsPanel.autoIndexActive')}
              </Tag>
            )}
            <Switch
              size="small"
              checked={autoEnabled}
              onChange={setAutoEnabled}
            />
          </Space>
        }
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          {/* 提示文案 */}
          {autoEnabled && (
            <Text type="secondary" style={{ fontSize: 12 }}>
              {t('kms.settingsPanel.autoIndexDesc')}
            </Text>
          )}

          {/* 参数配置 */}
          <div style={{ display: 'flex', gap: 24, flexWrap: 'wrap', alignItems: 'center' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <ClockCircleOutlined style={{ color: token.colorTextTertiary }} />
              <div>
                <Text style={{ display: 'block', fontSize: 12 }}>{t('kms.settingsPanel.autoIndexInterval')}</Text>
                <InputNumber
                  value={intervalMin}
                  onChange={v => setIntervalMin(v || 10)}
                  min={1}
                  max={1440}
                  size="small"
                  style={{ width: 100, marginTop: 2 }}
                  addonAfter={t('kms.settingsPanel.minutesUnit')}
                  disabled={!autoEnabled}
                />
              </div>
            </div>

            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <ThunderboltOutlined style={{ color: token.colorTextTertiary }} />
              <div>
                <Text style={{ display: 'block', fontSize: 12 }}>
                  {t('kms.settingsPanel.autoIndexStableThreshold')}
                </Text>
                <InputNumber
                  value={stableThreshold}
                  onChange={v => setStableThreshold(v || 0)}
                  min={0}
                  max={86400}
                  size="small"
                  style={{ width: 100, marginTop: 2 }}
                  addonAfter={t('kms.settingsPanel.secondsUnit')}
                  disabled={!autoEnabled}
                />
              </div>
            </div>
          </div>

          {/* 稳定阈值说明 */}
          {autoEnabled && stableThreshold > 0 && (
            <Text type="secondary" style={{ fontSize: 11 }}>
              {t('kms.settingsPanel.autoIndexStableThresholdDesc')}
            </Text>
          )}

          {/* 状态信息 */}
          {autoIndexStatus && autoIndexStatus.config.enabled && (
            <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', fontSize: 12, color: token.colorTextSecondary }}>
              {autoIndexStatus.lastRunAt && (
                <span>{t('kms.settingsPanel.autoIndexLastRun')}: {formatTime(autoIndexStatus.lastRunAt)}</span>
              )}
              {autoIndexStatus.nextRunAt && (
                <span>{t('kms.settingsPanel.autoIndexNextRun')}: {formatTime(autoIndexStatus.nextRunAt)}</span>
              )}
              {autoIndexStatus.lastResult && (
                <span>
                  {t('kms.settingsPanel.autoIndexLastResult')}:
                  {' +' + autoIndexStatus.lastResult.newFiles}
                  {' ~' + autoIndexStatus.lastResult.modifiedFiles}
                  {' -' + autoIndexStatus.lastResult.deletedFiles}
                  {autoIndexStatus.lastResult.skippedUnstableFiles > 0 && (
                    <Text type="secondary"> (⏳{autoIndexStatus.lastResult.skippedUnstableFiles})</Text>
                  )}
                </span>
              )}
            </div>
          )}

          {/* 操作按钮 */}
          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
            <Tooltip title={t('kms.settingsPanel.autoIndexRunNowTooltip')}>
              <Button
                size="small"
                icon={<PlayCircleOutlined />}
                onClick={onRunAutoIndexCheck}
                disabled={isIndexing || autoIndexStatus?.running === true}
              >
                {t('kms.settingsPanel.autoIndexRunNow')}
              </Button>
            </Tooltip>
            <Button
              size="small"
              type="primary"
              icon={<SaveOutlined />}
              loading={savingAuto}
              onClick={handleSaveAutoIndex}
            >
              {t('common.save')}
            </Button>
          </div>
        </div>
      </Card>

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
