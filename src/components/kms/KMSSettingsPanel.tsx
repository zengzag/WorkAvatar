import React, { useState, useEffect, useCallback, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import {
  Tabs, Card, Space, Typography, theme, InputNumber, Divider, Tag, Switch, Tooltip,
} from 'antd'
import {
  RobotOutlined, FolderOpenOutlined,
  DatabaseOutlined, ThunderboltOutlined,
} from '@ant-design/icons'
import LLMSelector from '../llm/LLMSelector'
import KMSDirPanel from './KMSDirPanel'
import KMSSearchDirPanel from './KMSSearchDirPanel'
import KMSIndexPanel from './KMSIndexPanel'
import type { LLMProvider } from '../../types'
import type { KMSSettings, KMSModelConfig, KMSAutoIndexConfig, KMSAutoIndexStatus } from '../../hooks/useKMS'

const { Title, Text, Paragraph } = Typography

interface IndexDir {
  id: string
  dir_path: string
  display_name: string
  enabled: number
  recursive: number
  file_extensions: string
  file_count?: number
  created_at: number
  updated_at: number
}

interface SearchDir {
  id: string
  dir_path: string
  display_name: string
  enabled: number
  recursive: number
  file_extensions: string
  file_count?: number
  created_at: number
  updated_at: number
}

interface IndexProgress {
  phase: string
  current: number
  total: number
  message: string
}

interface KMSSettingsPanelProps {
  settings: KMSSettings
  onSaveSettings: (params: {
    embeddingModel?: KMSModelConfig | null
    summaryModel?: KMSModelConfig | null
    searchParams?: { maxRounds?: number; topK?: number; resultLimit?: number; autoReparseHotData?: boolean; enableKnowledgeCards?: boolean; knowledgeCardThreshold?: number; autoRefreshStaleCards?: boolean }
    autoIndex?: KMSAutoIndexConfig
  }) => Promise<boolean>
  dirs: IndexDir[]
  onAddDir: (dirPath: string, displayName?: string, recursive?: boolean, fileExtensions?: string[]) => void
  onUpdateDir: (id: string, updates: { displayName?: string; enabled?: boolean; recursive?: boolean; fileExtensions?: string[] }) => void
  onDeleteDir: (id: string) => Promise<{ migrated?: number; removed?: number } | undefined>
  searchDirs: SearchDir[]
  onAddSearchDir: (dirPath: string, displayName?: string, recursive?: boolean, fileExtensions?: string[]) => void
  onUpdateSearchDir: (id: string, updates: { displayName?: string; enabled?: boolean; recursive?: boolean; fileExtensions?: string[] }) => void
  onDeleteSearchDir: (id: string) => void
  isIndexing: boolean
  indexProgress: IndexProgress | null
  onUpdateIndex: (withEmbedding?: boolean) => void
  onRebuildIndex: (withEmbedding?: boolean, dirId?: string, resetHotData?: boolean) => void
  onCancelIndex: () => void
  autoIndexStatus: KMSAutoIndexStatus | null
  onRunAutoIndexCheck: () => void
}

const KMSSettingsPanel: React.FC<KMSSettingsPanelProps> = ({
  settings,
  onSaveSettings,
  dirs,
  onAddDir,
  onUpdateDir,
  onDeleteDir,
  searchDirs,
  onAddSearchDir,
  onUpdateSearchDir,
  onDeleteSearchDir,
  isIndexing,
  indexProgress,
  onUpdateIndex,
  onRebuildIndex,
  onCancelIndex,
  autoIndexStatus,
  onRunAutoIndexCheck,
}) => {
  const { t } = useTranslation()
  const { token } = theme.useToken()

  const [providers, setProviders] = useState<LLMProvider[]>([])
  const [embeddingModelConfig, setEmbeddingModelConfig] = useState<KMSModelConfig | null>(settings.embeddingModel)
  const [summaryModelConfig, setSummaryModelConfig] = useState<KMSModelConfig | null>(settings.summaryModel)
  const [maxRounds, setMaxRounds] = useState<number>(settings.searchParams?.maxRounds ?? 5)
  const [topK, setTopK] = useState<number>(settings.searchParams?.topK ?? 10)
  const [resultLimit, setResultLimit] = useState<number>(settings.searchParams?.resultLimit ?? 100)
  const [autoReparseHotData, setAutoReparseHotData] = useState<boolean>(settings.searchParams?.autoReparseHotData ?? true)
  const [enableKnowledgeCards, setEnableKnowledgeCards] = useState<boolean>(settings.searchParams?.enableKnowledgeCards ?? true)
  const [knowledgeCardThreshold, setKnowledgeCardThreshold] = useState<number>(settings.searchParams?.knowledgeCardThreshold ?? 5)
  const [autoRefreshStaleCards, setAutoRefreshStaleCards] = useState<boolean>(settings.searchParams?.autoRefreshStaleCards ?? true)
  const [embeddingMaxChars, setEmbeddingMaxChars] = useState<number>(2000)
  const skipModelSaveRef = useRef(true)
  const skipParamsSaveRef = useRef(true)
  const skipEmbeddingSaveRef = useRef(true)

  useEffect(() => {
    window.electronAPI.llm.getProviders().then((result: any) => {
      setProviders(result as LLMProvider[])
    }).catch(() => {})
    loadEmbeddingMaxChars()
  }, [])

  useEffect(() => {
    setEmbeddingModelConfig(settings.embeddingModel)
    setSummaryModelConfig(settings.summaryModel)
    setMaxRounds(settings.searchParams?.maxRounds ?? 5)
    setTopK(settings.searchParams?.topK ?? 10)
    setResultLimit(settings.searchParams?.resultLimit ?? 100)
    setAutoReparseHotData(settings.searchParams?.autoReparseHotData ?? true)
    setEnableKnowledgeCards(settings.searchParams?.enableKnowledgeCards ?? true)
    setKnowledgeCardThreshold(settings.searchParams?.knowledgeCardThreshold ?? 5)
    setAutoRefreshStaleCards(settings.searchParams?.autoRefreshStaleCards ?? true)
    skipModelSaveRef.current = true
    skipParamsSaveRef.current = true
  }, [settings])

  const handleSaveAutoIndex = useCallback(async (config: KMSAutoIndexConfig): Promise<boolean> => {
    return onSaveSettings({ autoIndex: config })
  }, [onSaveSettings])

  const loadEmbeddingMaxChars = useCallback(async () => {
    try {
      const result = await window.electronAPI.settings.get({ key: 'embedding_max_chars' })
      if (result?.value) {
        setEmbeddingMaxChars(parseInt(result.value, 10))
      }
    } catch {}
  }, [])

  // 自动保存：模型配置变化后延迟 500ms 保存
  useEffect(() => {
    if (skipModelSaveRef.current) {
      skipModelSaveRef.current = false
      return
    }
    const timer = setTimeout(() => {
      onSaveSettings({
        embeddingModel: embeddingModelConfig,
        summaryModel: summaryModelConfig,
      })
    }, 500)
    return () => clearTimeout(timer)
  }, [embeddingModelConfig, summaryModelConfig, onSaveSettings])

  // 自动保存：检索参数变化后延迟 500ms 保存
  useEffect(() => {
    if (skipParamsSaveRef.current) {
      skipParamsSaveRef.current = false
      return
    }
    const timer = setTimeout(() => {
      onSaveSettings({
        searchParams: { maxRounds, topK, resultLimit, autoReparseHotData, enableKnowledgeCards, knowledgeCardThreshold, autoRefreshStaleCards },
      })
    }, 500)
    return () => clearTimeout(timer)
  }, [maxRounds, topK, resultLimit, autoReparseHotData, enableKnowledgeCards, knowledgeCardThreshold, autoRefreshStaleCards, onSaveSettings])

  // 自动保存：embedding 最大字符数变化后延迟 500ms 保存
  useEffect(() => {
    if (skipEmbeddingSaveRef.current) {
      skipEmbeddingSaveRef.current = false
      return
    }
    const timer = setTimeout(() => {
      window.electronAPI.settings.set({ key: 'embedding_max_chars', value: String(embeddingMaxChars) })
    }, 500)
    return () => clearTimeout(timer)
  }, [embeddingMaxChars])

  const renderModelTab = () => (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      {/* 摘要模型 */}
      <Card size="small" style={{ borderColor: token.colorBorderSecondary }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <Text strong style={{ display: 'block' }}>{t('kms.settingsPanel.summaryModel')}</Text>
              <Text type="secondary" style={{ fontSize: 12 }}>{t('kms.settingsPanel.summaryModelDesc')}</Text>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
              <LLMSelector
                providerId={summaryModelConfig?.provider_id || ''}
                modelId={summaryModelConfig?.model_id || ''}
                onChange={(providerId, modelId) => {
                  if (providerId) {
                    setSummaryModelConfig(prev => ({
                      provider_id: providerId,
                      model_id: modelId,
                      enable_thinking: prev?.enable_thinking ?? false,
                    }))
                  } else {
                    setSummaryModelConfig(null)
                  }
                }}
                modelCategory="chat"
                providers={providers}
              />
              {summaryModelConfig?.provider_id && (
                <Text
                  type="secondary"
                  style={{ fontSize: 12, cursor: 'pointer', whiteSpace: 'nowrap' }}
                  onClick={() => setSummaryModelConfig(null)}
                >
                  {t('common.clearAll')}
                </Text>
              )}
            </div>
          </div>
          {summaryModelConfig?.provider_id && (
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <Text type="secondary" style={{ fontSize: 12 }}>{t('kms.settingsPanel.enableThinking')}</Text>
                <Tooltip title={t('kms.settingsPanel.enableThinkingTooltip')}>
                  <Text type="secondary" style={{ fontSize: 12, cursor: 'help' }}>ⓘ</Text>
                </Tooltip>
              </div>
              <Switch
                size="small"
                checked={summaryModelConfig?.enable_thinking ?? false}
                onChange={(checked) => {
                  setSummaryModelConfig(prev => prev ? { ...prev, enable_thinking: checked } : prev)
                }}
              />
            </div>
          )}
        </div>
      </Card>

      {/* 智能索引模型 */}
      <Card size="small" style={{ borderColor: token.colorBorderSecondary }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <Text strong style={{ display: 'block' }}>{t('kms.settingsPanel.embeddingModel')}</Text>
            <Text type="secondary" style={{ fontSize: 12 }}>{t('kms.settingsPanel.embeddingModelDesc')}</Text>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
            <LLMSelector
              providerId={embeddingModelConfig?.provider_id || ''}
              modelId={embeddingModelConfig?.model_id || ''}
              onChange={(providerId, modelId) => {
                if (providerId) {
                  setEmbeddingModelConfig({ provider_id: providerId, model_id: modelId })
                } else {
                  setEmbeddingModelConfig(null)
                }
              }}
              modelCategory="embedding"
              providers={providers}
            />
            {embeddingModelConfig?.provider_id && (
              <Text
                type="secondary"
                style={{ fontSize: 12, cursor: 'pointer', whiteSpace: 'nowrap' }}
                onClick={() => setEmbeddingModelConfig(null)}
              >
                {t('common.clearAll')}
              </Text>
            )}
          </div>
        </div>
      </Card>

      {/* 智能索引最大字符数 */}
      <Card size="small" style={{ borderColor: token.colorBorderSecondary }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <Text strong style={{ display: 'block' }}>{t('settings.embeddingMaxCharsTitle')}</Text>
            <Text type="secondary" style={{ fontSize: 12 }}>{t('settings.embeddingMaxCharsDesc')}</Text>
          </div>
          <Space style={{ flexShrink: 0 }}>
            <InputNumber
              value={embeddingMaxChars}
              onChange={v => setEmbeddingMaxChars(v || 2000)}
              min={100}
              max={32000}
              step={100}
              style={{ width: 120 }}
            />
          </Space>
        </div>
      </Card>
    </div>
  )

  const renderParamsTab = () => (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <Card size="small" style={{ borderColor: token.colorBorderSecondary }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16 }}>
          <div>
            <Text strong style={{ display: 'block' }}>{t('kms.settingsPanel.maxRounds')}</Text>
            <Text type="secondary" style={{ fontSize: 12 }}>{t('kms.settingsPanel.maxRoundsDesc')}</Text>
          </div>
          <InputNumber
            value={maxRounds}
            onChange={v => setMaxRounds(v || 5)}
            min={1}
            max={20}
            style={{ width: 120 }}
          />
        </div>

        <Divider style={{ margin: '12px 0' }} />

        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <div>
            <Text strong style={{ display: 'block' }}>{t('kms.settingsPanel.topK')}</Text>
            <Text type="secondary" style={{ fontSize: 12 }}>{t('kms.settingsPanel.topKDesc')}</Text>
          </div>
          <InputNumber
            value={topK}
            onChange={v => setTopK(v || 10)}
            min={3}
            max={100}
            style={{ width: 120 }}
          />
        </div>

        <Divider style={{ margin: '12px 0' }} />

        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <div>
            <Text strong style={{ display: 'block' }}>{t('kms.settingsPanel.resultLimit')}</Text>
            <Text type="secondary" style={{ fontSize: 12 }}>{t('kms.settingsPanel.resultLimitDesc')}</Text>
          </div>
          <InputNumber
            value={resultLimit}
            onChange={v => setResultLimit(v || 100)}
            min={5}
            max={500}
            style={{ width: 120 }}
          />
        </div>

        <Divider style={{ margin: '12px 0' }} />

        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <div>
            <Text strong style={{ display: 'block' }}>{t('kms.settingsPanel.autoReparseHotData')}</Text>
            <Text type="secondary" style={{ fontSize: 12 }}>{t('kms.settingsPanel.autoReparseHotDataDesc')}</Text>
          </div>
          <Switch
            checked={autoReparseHotData}
            onChange={setAutoReparseHotData}
          />
        </div>
      </Card>

      {/* 知识卡片设置 */}
      <Card size="small" style={{ borderColor: token.colorBorderSecondary }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16 }}>
          <div>
            <Text strong style={{ display: 'block' }}>{t('kms.knowledgeCards.enableCards')}</Text>
            <Text type="secondary" style={{ fontSize: 12 }}>{t('kms.knowledgeCards.subtitle')}</Text>
          </div>
          <Switch
            checked={enableKnowledgeCards}
            onChange={setEnableKnowledgeCards}
          />
        </div>

        <Divider style={{ margin: '12px 0' }} />

        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <div>
              <Text strong style={{ display: 'block' }}>{t('kms.knowledgeCards.cardThreshold')}</Text>
              <Text type="secondary" style={{ fontSize: 12 }}>{t('kms.knowledgeCards.cardThresholdDesc')}</Text>
            </div>
          </div>
          <InputNumber
            value={knowledgeCardThreshold}
            onChange={v => setKnowledgeCardThreshold(v || 5)}
            min={2}
            max={50}
            style={{ width: 120 }}
          />
        </div>

        <Divider style={{ margin: '12px 0' }} />

        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <div>
              <Text strong style={{ display: 'block' }}>{t('kms.knowledgeCards.autoRefresh')}</Text>
              <Text type="secondary" style={{ fontSize: 12 }}>{t('kms.settingsPanel.autoRefreshStaleCardsDesc')}</Text>
            </div>
          </div>
          <Switch
            checked={autoRefreshStaleCards}
            onChange={setAutoRefreshStaleCards}
          />
        </div>
      </Card>
    </div>
  )

  const renderDirsTab = () => (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 24 }}>
      <KMSDirPanel
        dirs={dirs}
        onUpdateDir={onUpdateDir}
        onDeleteDir={onDeleteDir}
        onAddDir={onAddDir}
      />
      <KMSSearchDirPanel
        dirs={searchDirs}
        onUpdateDir={onUpdateSearchDir}
        onDeleteDir={onDeleteSearchDir}
        onAddDir={onAddSearchDir}
      />
    </div>
  )

  const renderIndexTab = () => (
    <div>
      <div style={{ marginBottom: 12 }}>
        <Space>
          <DatabaseOutlined style={{ color: token.colorPrimary }} />
          <Title level={5} style={{ margin: 0 }}>{t('kms.indexSettings')}</Title>
        </Space>
        <Paragraph type="secondary" style={{ margin: '4px 0 0', fontSize: 12 }}>
          {t('kms.settingsPanel.indexDesc')}
        </Paragraph>
      </div>
      <KMSIndexPanel
        isIndexing={isIndexing}
        indexProgress={indexProgress}
        onUpdateIndex={onUpdateIndex}
        onRebuildIndex={onRebuildIndex}
        onCancelIndex={onCancelIndex}
        autoIndexConfig={settings.autoIndex}
        autoIndexStatus={autoIndexStatus}
        onSaveAutoIndex={handleSaveAutoIndex}
        onRunAutoIndexCheck={onRunAutoIndexCheck}
        dirs={dirs}
      />
    </div>
  )

  const tabItems = [
    {
      key: 'model',
      label: (
        <span>
          <RobotOutlined style={{ marginRight: 4 }} />
          {t('kms.settingsPanel.modelTab')}
        </span>
      ),
      children: renderModelTab(),
    },
    {
      key: 'params',
      label: (
        <span>
          <ThunderboltOutlined style={{ marginRight: 4 }} />
          {t('kms.settingsPanel.paramsTab')}
        </span>
      ),
      children: renderParamsTab(),
    },
    {
      key: 'dirs',
      label: (
        <span>
          <FolderOpenOutlined style={{ marginRight: 4 }} />
          {t('kms.settingsPanel.dirsTab')}
          {dirs.length > 0 && (
            <Tag color="blue" style={{ fontSize: 10, margin: '0 0 0 4px', lineHeight: '16px', padding: '0 4px' }}>
              {dirs.length}
            </Tag>
          )}
        </span>
      ),
      children: renderDirsTab(),
    },
    {
      key: 'index',
      label: (
        <span>
          <DatabaseOutlined style={{ marginRight: 4 }} />
          {t('kms.settingsPanel.indexTab')}
        </span>
      ),
      children: renderIndexTab(),
    },
  ]

  return (
    <Tabs
      defaultActiveKey="model"
      items={tabItems}
      size="small"
      style={{ height: '100%' }}
      tabBarStyle={{ marginBottom: 16 }}
    />
  )
}

export default KMSSettingsPanel
