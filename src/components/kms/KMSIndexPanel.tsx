import React, { useState, useEffect, useCallback, useImperativeHandle, forwardRef, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import {
  Button, Card, Space, Progress, Typography, Spin, theme, Switch, InputNumber, Tooltip, Tag, App, Select, Checkbox,
} from 'antd'
import {
  ThunderboltOutlined,
  SyncOutlined, BuildOutlined, StopOutlined,
  ClockCircleOutlined, RadarChartOutlined,
  PlayCircleOutlined, InfoCircleOutlined,
  CloudServerOutlined, ExclamationCircleOutlined,
  DatabaseOutlined, DeleteOutlined, ReloadOutlined,
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

interface IndexDir {
  id: string
  dir_path: string
  display_name: string
}

interface KMSIndexPanelProps {
  isIndexing: boolean
  indexProgress: IndexProgress | null
  onUpdateIndex: (withEmbedding?: boolean) => void
  onRebuildIndex: (withEmbedding?: boolean, dirId?: string, resetHotData?: boolean) => void
  onCancelIndex: () => void
  autoIndexConfig: KMSAutoIndexConfig
  autoIndexStatus: KMSAutoIndexStatus | null
  onSaveAutoIndex: (config: KMSAutoIndexConfig) => Promise<boolean>
  onRunAutoIndexCheck: () => void
  dirs?: IndexDir[]
}

const PHASE_LABEL_KEYS: Record<string, string> = {
  crawling: 'kms.indexPhaseCrawling',
  parsing: 'kms.indexPhaseParsing',
  indexing: 'kms.indexPhaseIndexing',
  embedding: 'kms.indexPhaseEmbedding',
  done: 'kms.indexPhaseDone',
  error: 'kms.indexPhaseError',
}

interface RebuildFormValue {
  dirId: string
  resetHotData: boolean
}

interface RebuildConfirmContentProps {
  dirs: IndexDir[]
}

const RebuildConfirmContent = forwardRef<RebuildFormValue, RebuildConfirmContentProps>(({ dirs }, ref) => {
  const { t } = useTranslation()
  const [dirId, setDirId] = useState<string>('')
  const [resetHot, setResetHot] = useState(false)

  useImperativeHandle(ref, () => ({ dirId, resetHotData: resetHot }), [dirId, resetHot])

  const dirOptions = dirs && dirs.length > 0
    ? [
        { label: t('kms.allDirs'), value: '' },
        ...dirs.map(d => ({ label: d.display_name || d.dir_path, value: d.id })),
      ]
    : []

  return (
    <div>
      <p>{t('kms.rebuildIndexConfirm')}</p>
      {dirOptions.length > 0 && (
        <div style={{ marginTop: 12 }}>
          <Text type="secondary" style={{ fontSize: 12, display: 'block', marginBottom: 4 }}>{t('kms.rebuildIndexSelectDir')}</Text>
          <Select
            value={dirId}
            onChange={setDirId}
            style={{ width: '100%' }}
            options={dirOptions}
          />
        </div>
      )}
      <div style={{ marginTop: 12 }}>
        <Checkbox checked={resetHot} onChange={e => setResetHot(e.target.checked)}>
          {t('kms.rebuildIndexResetHot')}
        </Checkbox>
      </div>
    </div>
  )
})

const KMSIndexPanel: React.FC<KMSIndexPanelProps> = ({
  isIndexing,
  indexProgress,
  onUpdateIndex,
  onRebuildIndex,
  onCancelIndex,
  autoIndexConfig,
  autoIndexStatus,
  onSaveAutoIndex,
  onRunAutoIndexCheck,
  dirs,
}) => {
  const { t } = useTranslation()
  const { token } = theme.useToken()
  const { message, modal } = App.useApp()

  const [autoEnabled, setAutoEnabled] = useState(autoIndexConfig.enabled)
  const [intervalMin, setIntervalMin] = useState(autoIndexConfig.intervalMinutes)
  const [stableThreshold, setStableThreshold] = useState(autoIndexConfig.stableThresholdMinutes)
  const skipAutoIndexSaveRef = useRef(true)
  // 用 ref 持有最新的 onSaveAutoIndex，避免回调引用变化触发自动保存 effect
  const onSaveAutoIndexRef = useRef(onSaveAutoIndex)
  onSaveAutoIndexRef.current = onSaveAutoIndex
  const [withEmbedding, setWithEmbedding] = useState(true)
  const [dbStats, setDbStats] = useState<any>(null)
  const [loadingStats, setLoadingStats] = useState(false)
  const [cleaning, setCleaning] = useState(false)

  useEffect(() => {
    setAutoEnabled(autoIndexConfig.enabled)
    setIntervalMin(autoIndexConfig.intervalMinutes)
    setStableThreshold(autoIndexConfig.stableThresholdMinutes)
    skipAutoIndexSaveRef.current = true
  }, [autoIndexConfig])

  // 自动保存：自动索引配置变化后延迟 500ms 保存
  // 注意：依赖数组只含实际配置值，不含 onSaveAutoIndex（用 ref 调用），
  // 否则父组件每次 re-render 传入新函数引用会反复触发保存
  useEffect(() => {
    if (skipAutoIndexSaveRef.current) {
      skipAutoIndexSaveRef.current = false
      return
    }
    const timer = setTimeout(() => {
      onSaveAutoIndexRef.current({
        enabled: autoEnabled,
        intervalMinutes: intervalMin,
        stableThresholdMinutes: stableThreshold,
      })
    }, 500)
    return () => clearTimeout(timer)
  }, [autoEnabled, intervalMin, stableThreshold])

  const loadDbStats = useCallback(async () => {
    setLoadingStats(true)
    try {
      const result = await window.electronAPI.kms.getDatabaseStats()
      // safeHandle 异常时返回 { error }，需兜底避免下游访问 undefined 字段
      setDbStats(result && !result.error ? result : null)
    } catch {
      // ignore
    } finally {
      setLoadingStats(false)
    }
  }, [])

  const formatBytes = useCallback((bytes: number): string => {
    if (!bytes || bytes <= 0) return '0 B'
    const units = ['B', 'KB', 'MB', 'GB']
    let val = bytes
    let unitIdx = 0
    while (val >= 1024 && unitIdx < units.length - 1) {
      val /= 1024
      unitIdx++
    }
    return `${val.toFixed(val >= 100 ? 0 : val >= 10 ? 1 : 2)} ${units[unitIdx]}`
  }, [])

  const handleCleanup = useCallback(() => {
    modal.confirm({
      title: t('kms.settingsPanel.cleanupDatabase'),
      icon: <ExclamationCircleOutlined />,
      content: t('kms.settingsPanel.cleanupConfirm'),
      okText: t('common.confirm'),
      cancelText: t('common.cancel'),
      okButtonProps: { danger: true },
      onOk: async () => {
        setCleaning(true)
        try {
          const result = await window.electronAPI.kms.cleanupDatabase()
          if (result && result.error) {
            message.error(t('kms.settingsPanel.cleanupFailed') + `: ${result.error}`)
            return
          }
          const freed = (result?.before?.mainDbSize ?? 0) + (result?.before?.vectorDbSize ?? 0)
            - (result?.after?.mainDbSize ?? 0) - (result?.after?.vectorDbSize ?? 0)
          const freedStr = freed > 0 ? formatBytes(freed) : '0 B'
          message.success(t('kms.settingsPanel.cleanupDone', { size: freedStr }))
          await loadDbStats()
        } catch (err: any) {
          message.error(t('kms.settingsPanel.cleanupFailed') + (err?.message ? `: ${err.message}` : ''))
        } finally {
          setCleaning(false)
        }
      },
    })
  }, [modal, t, formatBytes, message, loadDbStats])

  const formatProgressTime = (ts: number | null): string => ts ? formatTime(ts, 'time') : '-'

  const progressPercent = indexProgress && indexProgress.total > 0
    ? Math.round((indexProgress.current / indexProgress.total) * 100)
    : 0

  const handleRebuild = useCallback(() => {
    const formRef = React.createRef<RebuildFormValue>()

    modal.confirm({
      title: t('kms.rebuildIndex'),
      icon: <ExclamationCircleOutlined />,
      content: (
        <RebuildConfirmContent ref={formRef} dirs={dirs ?? []} />
      ),
      okText: t('common.confirm'),
      cancelText: t('common.cancel'),
      onOk: () => {
        const { dirId, resetHotData } = formRef.current ?? { dirId: '', resetHotData: false }
        onRebuildIndex(withEmbedding, dirId || undefined, resetHotData)
      },
    })
  }, [dirs, withEmbedding, onRebuildIndex, modal, t])

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
                  max={1440}
                  size="small"
                  style={{ width: 100, marginTop: 2 }}
                  addonAfter={t('kms.settingsPanel.minutesUnit')}
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
          </div>
        </div>
      </Card>

      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
        <Button
          type="primary"
          icon={<SyncOutlined />}
          onClick={() => onUpdateIndex(withEmbedding)}
          disabled={isIndexing}
          loading={isIndexing && indexProgress?.phase === 'crawling'}
        >
          {t('kms.updateIndex')}
        </Button>
        <Button
          icon={<BuildOutlined />}
          onClick={handleRebuild}
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

      {/* 数据库清理 */}
      <Card
        size="small"
        style={{ borderColor: token.colorBorderSecondary }}
        title={
          <Space size={6}>
            <DatabaseOutlined style={{ color: token.colorPrimary }} />
            <Text strong style={{ fontSize: 13 }}>{t('kms.settingsPanel.dbCleanupTitle')}</Text>
            <Tooltip title={t('kms.settingsPanel.dbCleanupHint')}>
              <InfoCircleOutlined style={{ color: token.colorTextTertiary, fontSize: 12, cursor: 'help' }} />
            </Tooltip>
          </Space>
        }
        extra={
          <Button
            size="small"
            type="text"
            icon={<ReloadOutlined />}
            onClick={loadDbStats}
            loading={loadingStats}
            disabled={cleaning}
          >
            {t('kms.settingsPanel.refreshStats')}
          </Button>
        }
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <Text type="secondary" style={{ fontSize: 12 }}>{t('kms.settingsPanel.dbCleanupDesc')}</Text>

          {dbStats && (
            <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', fontSize: 12 }}>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                <Text type="secondary" style={{ fontSize: 11 }}>{t('kms.settingsPanel.mainDbSize')}</Text>
                <Text strong style={{ fontSize: 13 }}>{formatBytes(dbStats.mainDbSize)}</Text>
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                <Text type="secondary" style={{ fontSize: 11 }}>{t('kms.settingsPanel.vectorDbSize')}</Text>
                <Text strong style={{ fontSize: 13 }}>{formatBytes(dbStats.vectorDbSize)}</Text>
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                <Text type="secondary" style={{ fontSize: 11 }}>{t('kms.settingsPanel.orphanedFts')}</Text>
                <Text strong style={{ fontSize: 13, color: dbStats.orphanedFtsCount > 0 ? token.colorWarning : undefined }}>
                  {dbStats.orphanedFtsCount}
                </Text>
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                <Text type="secondary" style={{ fontSize: 11 }}>{t('kms.settingsPanel.orphanedEmbeddings')}</Text>
                <Text strong style={{ fontSize: 13, color: dbStats.orphanedEmbeddingCount > 0 ? token.colorWarning : undefined }}>
                  {dbStats.orphanedEmbeddingCount}
                </Text>
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                <Text type="secondary" style={{ fontSize: 11 }}>{t('kms.settingsPanel.orphanedFiles')}</Text>
                <Text strong style={{ fontSize: 13, color: dbStats.orphanedFileCount > 0 ? token.colorWarning : undefined }}>
                  {dbStats.orphanedFileCount}
                </Text>
              </div>
            </div>
          )}

          {!dbStats && loadingStats && (
            <div style={{ textAlign: 'center', padding: '8px 0' }}><Spin size="small" /></div>
          )}

          <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
            <Button
              size="small"
              danger
              icon={<DeleteOutlined />}
              onClick={handleCleanup}
              loading={cleaning}
              disabled={cleaning || isIndexing}
            >
              {cleaning ? t('kms.settingsPanel.cleanupRunning') : t('kms.settingsPanel.cleanupDatabase')}
            </Button>
          </div>
        </div>
      </Card>
    </div>
  )
}

export default KMSIndexPanel
