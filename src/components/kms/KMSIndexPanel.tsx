import React, { useState, useEffect, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import {
  Button, Card, Space, Progress, Typography, Spin, theme, Switch, InputNumber, Tooltip, Tag, App,
} from 'antd'
import {
  ThunderboltOutlined,
  SyncOutlined, BuildOutlined, StopOutlined,
  ClockCircleOutlined, RadarChartOutlined,
  PlayCircleOutlined, InfoCircleOutlined, SaveOutlined,
  CloudServerOutlined,
} from '@ant-design/icons'
import type { KMSAutoIndexConfig, KMSAutoIndexStatus } from '../../hooks/useKMS'
import { formatTime } from './kms-columns'

const { Text } = Typography

interface IndexProgress {
  phase: string
  current: number
  total: number
  message: string
}

interface KMSIndexPanelProps {
  isIndexing: boolean
  indexProgress: IndexProgress | null
  onBuildIndex: (withEmbedding?: boolean) => void
  onIncrementalIndex: (withEmbedding?: boolean) => void
  onRebuildIndex: (withEmbedding?: boolean) => void
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
  // 是否同时构建智能索引（向量嵌入），默认开启
  const [withEmbedding, setWithEmbedding] = useState(true)

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

  // 格式化时间戳为可读字符串（time 格式：HH:mm:ss）
  const formatProgressTime = (ts: number | null): string => ts ? formatTime(ts, 'time') : '-'

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
                <span>{t('kms.settingsPanel.autoIndexLastRun')}: {formatProgressTime(autoIndexStatus.lastRunAt)}</span>
              )}
              {autoIndexStatus.nextRunAt && (
                <span>{t('kms.settingsPanel.autoIndexNextRun')}: {formatProgressTime(autoIndexStatus.nextRunAt)}</span>
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

      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
        <Button
          type="primary"
          icon={<BuildOutlined />}
          onClick={() => onBuildIndex(withEmbedding)}
          disabled={isIndexing}
          loading={isIndexing && indexProgress?.phase === 'crawling'}
        >
          {t('kms.buildIndex')}
        </Button>
        <Button
          icon={<SyncOutlined />}
          onClick={() => onIncrementalIndex(withEmbedding)}
          disabled={isIndexing}
        >
          {t('kms.incrementalIndex')}
        </Button>
        <Button
          icon={<ThunderboltOutlined />}
          onClick={() => onRebuildIndex(withEmbedding)}
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
        <Tooltip title={t('kms.withEmbeddingTooltip')}>
          <div style={{
            display: 'flex', alignItems: 'center', gap: 6,
            padding: '4px 10px', borderRadius: 6,
            background: withEmbedding ? token.colorPrimaryBg : token.colorFillQuaternary,
            border: `1px solid ${withEmbedding ? token.colorPrimaryBorder : token.colorBorderSecondary}`,
            fontSize: 12, color: withEmbedding ? token.colorPrimary : token.colorTextSecondary,
            cursor: 'pointer', userSelect: 'none',
            transition: 'all 0.2s',
          }} onClick={() => setWithEmbedding(!withEmbedding)}>
            <CloudServerOutlined style={{ fontSize: 12 }} />
            <span>{t('kms.withEmbedding')}</span>
            <Switch size="small" checked={withEmbedding} onChange={setWithEmbedding} />
          </div>
        </Tooltip>
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
