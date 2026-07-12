import React, { useState, useEffect, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import {
  Tabs, Card, Space, Typography, App, theme, InputNumber, Button, Divider, Tag, Switch, Tooltip,
} from 'antd'
import {
  RobotOutlined, CloudServerOutlined, SaveOutlined, FolderOpenOutlined,
  DatabaseOutlined, ThunderboltOutlined, AimOutlined, FileTextOutlined, SearchOutlined,
  FireOutlined, BookOutlined,
} from '@ant-design/icons'
import LLMSelector from '../llm/LLMSelector'
import KMSDirPanel from './KMSDirPanel'
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

interface IndexProgress {
  phase: string
  current: number
  total: number
  message: string
}

interface KMSSettingsPanelProps {
  settings: KMSSettings
  onSaveSettings: (params: {
    model?: KMSModelConfig | null
    embeddingModel?: KMSModelConfig | null
    summaryModel?: KMSModelConfig | null
    searchParams?: { maxRounds?: number; topK?: number; resultLimit?: number; autoReparseHotData?: boolean; enableKnowledgeCards?: boolean; knowledgeCardThreshold?: number; autoRefreshStaleCards?: boolean }
    autoIndex?: KMSAutoIndexConfig
  }) => Promise<boolean>
  dirs: IndexDir[]
  onAddDir: (dirPath: string, displayName?: string, recursive?: boolean, fileExtensions?: string[]) => void
  onUpdateDir: (id: string, updates: { displayName?: string; enabled?: boolean; recursive?: boolean; fileExtensions?: string[] }) => void
  onDeleteDir: (id: string) => void
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
  isIndexing,
  indexProgress,
  onUpdateIndex,
  onRebuildIndex,
  onCancelIndex,
  autoIndexStatus,
  onRunAutoIndexCheck,
}) => {
  const { t } = useTranslation()
  const { message } = App.useApp()
  const { token } = theme.useToken()

  const [providers, setProviders] = useState<LLMProvider[]>([])
  const [modelConfig, setModelConfig] = useState<KMSModelConfig | null>(settings.model)
  const [embeddingModelConfig, setEmbeddingModelConfig] = useState<KMSModelConfig | null>(settings.embeddingModel)
  const [summaryModelConfig, setSummaryModelConfig] = useState<KMSModelConfig | null>(settings.summaryModel)
  const [maxRounds, setMaxRounds] = useState<number>(settings.searchParams?.maxRounds ?? 5)
  const [topK, setTopK] = useState<number>(settings.searchParams?.topK ?? 10)
  const [resultLimit, setResultLimit] = useState<number>(settings.searchParams?.resultLimit ?? 100)
  const [autoReparseHotData, setAutoReparseHotData] = useState<boolean>(settings.searchParams?.autoReparseHotData ?? true)
  const [enableKnowledgeCards, setEnableKnowledgeCards] = useState<boolean>(settings.searchParams?.enableKnowledgeCards ?? true)
  const [knowledgeCardThreshold, setKnowledgeCardThreshold] = useState<number>(settings.searchParams?.knowledgeCardThreshold ?? 5)
  const [autoRefreshStaleCards, setAutoRefreshStaleCards] = useState<boolean>(settings.searchParams?.autoRefreshStaleCards ?? true)
  const [savingModel, setSavingModel] = useState(false)
  const [savingParams, setSavingParams] = useState(false)
  const [embeddingMaxChars, setEmbeddingMaxChars] = useState<number>(2000)
  const [savingEmbeddingMaxChars, setSavingEmbeddingMaxChars] = useState(false)

  useEffect(() => {
    window.electronAPI.llm.getProviders().then((result: any) => {
      setProviders(result as LLMProvider[])
    }).catch(() => {})
    loadEmbeddingMaxChars()
  }, [])

  useEffect(() => {
    setModelConfig(settings.model)
    setEmbeddingModelConfig(settings.embeddingModel)
    setSummaryModelConfig(settings.summaryModel)
    setMaxRounds(settings.searchParams?.maxRounds ?? 5)
    setTopK(settings.searchParams?.topK ?? 10)
    setResultLimit(settings.searchParams?.resultLimit ?? 100)
    setAutoReparseHotData(settings.searchParams?.autoReparseHotData ?? true)
    setEnableKnowledgeCards(settings.searchParams?.enableKnowledgeCards ?? true)
    setKnowledgeCardThreshold(settings.searchParams?.knowledgeCardThreshold ?? 5)
    setAutoRefreshStaleCards(settings.searchParams?.autoRefreshStaleCards ?? true)
  }, [settings])

  const loadEmbeddingMaxChars = useCallback(async () => {
    try {
      const result = await window.electronAPI.settings.get({ key: 'embedding_max_chars' })
      if (result?.value) {
        setEmbeddingMaxChars(parseInt(result.value, 10))
      }
    } catch {}
  }, [])

  const handleSaveEmbeddingMaxChars = useCallback(async () => {
    setSavingEmbeddingMaxChars(true)
    try {
      await window.electronAPI.settings.set({ key: 'embedding_max_chars', value: String(embeddingMaxChars) })
      message.success(t('settings.embeddingMaxCharsSaved'))
    } catch {
      message.error(t('settings.defaultModelSaveFailed'))
    } finally {
      setSavingEmbeddingMaxChars(false)
    }
  }, [embeddingMaxChars, message, t])

  const handleSaveModel = useCallback(async () => {
    setSavingModel(true)
    const ok = await onSaveSettings({
      model: modelConfig,
      embeddingModel: embeddingModelConfig,
      summaryModel: summaryModelConfig,
    })
    setSavingModel(false)
    if (ok) {
      message.success(t('kms.settingsPanel.modelSaved'))
    } else {
      message.error(t('kms.settingsPanel.modelSaveFailed'))
    }
  }, [modelConfig, embeddingModelConfig, summaryModelConfig, onSaveSettings, message, t])

  const handleSaveParams = useCallback(async () => {
    setSavingParams(true)
    const ok = await onSaveSettings({
      searchParams: { maxRounds, topK, resultLimit, autoReparseHotData, enableKnowledgeCards, knowledgeCardThreshold, autoRefreshStaleCards },
    })
    setSavingParams(false)
    if (ok) {
      message.success(t('kms.settingsPanel.paramsSaved'))
    } else {
      message.error(t('kms.settingsPanel.modelSaveFailed'))
    }
  }, [maxRounds, topK, resultLimit, autoReparseHotData, enableKnowledgeCards, knowledgeCardThreshold, autoRefreshStaleCards, onSaveSettings, message, t])

  const renderModelTab = () => (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      {/* AI 搜索模型 */}
      <Card size="small" style={{ borderColor: token.colorBorderSecondary }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12, flex: 1, minWidth: 0 }}>
              <div style={{
                width: 40,
                height: 40,
                borderRadius: 8,
                background: token.colorBgTextHover,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                flexShrink: 0,
              }}>
                <RobotOutlined style={{ fontSize: 20, color: token.colorPrimary }} />
              </div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <Text strong style={{ display: 'block' }}>{t('kms.settingsPanel.aiSearchModel')}</Text>
                <Text type="secondary" style={{ fontSize: 12 }}>{t('kms.settingsPanel.aiSearchModelDesc')}</Text>
              </div>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
              <LLMSelector
                providerId={modelConfig?.provider_id || ''}
                modelId={modelConfig?.model_id || ''}
                onChange={(providerId, modelId) => {
                  if (providerId) {
                    setModelConfig(prev => ({
                      provider_id: providerId,
                      model_id: modelId,
                      enable_thinking: prev?.enable_thinking ?? false,
                    }))
                  } else {
                    setModelConfig(null)
                  }
                }}
                modelCategory="chat"
                providers={providers}
              />
              {modelConfig?.provider_id && (
                <Text
                  type="secondary"
                  style={{ fontSize: 12, cursor: 'pointer', whiteSpace: 'nowrap' }}
                  onClick={() => setModelConfig(null)}
                >
                  {t('common.clearAll')}
                </Text>
              )}
            </div>
          </div>
          {modelConfig?.provider_id && (
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', paddingLeft: 52 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <Text type="secondary" style={{ fontSize: 12 }}>{t('kms.settingsPanel.enableThinking')}</Text>
                <Tooltip title={t('kms.settingsPanel.enableThinkingTooltip')}>
                  <Text type="secondary" style={{ fontSize: 12, cursor: 'help' }}>ⓘ</Text>
                </Tooltip>
              </div>
              <Switch
                size="small"
                checked={modelConfig?.enable_thinking ?? false}
                onChange={(checked) => {
                  setModelConfig(prev => prev ? { ...prev, enable_thinking: checked } : prev)
                }}
              />
            </div>
          )}
        </div>
      </Card>

      {/* 摘要模型 */}
      <Card size="small" style={{ borderColor: token.colorBorderSecondary }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12, flex: 1, minWidth: 0 }}>
              <div style={{
                width: 40,
                height: 40,
                borderRadius: 8,
                background: token.colorBgTextHover,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                flexShrink: 0,
              }}>
                <FileTextOutlined style={{ fontSize: 20, color: token.colorSuccess }} />
              </div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <Text strong style={{ display: 'block' }}>{t('kms.settingsPanel.summaryModel')}</Text>
                <Text type="secondary" style={{ fontSize: 12 }}>{t('kms.settingsPanel.summaryModelDesc')}</Text>
              </div>
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
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', paddingLeft: 52 }}>
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
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, flex: 1, minWidth: 0 }}>
            <div style={{
              width: 40,
              height: 40,
              borderRadius: 8,
              background: token.colorBgTextHover,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              flexShrink: 0,
            }}>
              <CloudServerOutlined style={{ fontSize: 20, color: token.colorInfo }} />
            </div>
            <div style={{ flex: 1, minWidth: 0 }}>
              <Text strong style={{ display: 'block' }}>{t('kms.settingsPanel.embeddingModel')}</Text>
              <Text type="secondary" style={{ fontSize: 12 }}>{t('kms.settingsPanel.embeddingModelDesc')}</Text>
            </div>
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
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, flex: 1, minWidth: 0 }}>
            <div style={{
              width: 40,
              height: 40,
              borderRadius: 8,
              background: token.colorBgTextHover,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              flexShrink: 0,
            }}>
              <ThunderboltOutlined style={{ fontSize: 20, color: token.colorInfo }} />
            </div>
            <div style={{ flex: 1, minWidth: 0 }}>
              <Text strong style={{ display: 'block' }}>{t('settings.embeddingMaxCharsTitle')}</Text>
              <Text type="secondary" style={{ fontSize: 12 }}>{t('settings.embeddingMaxCharsDesc')}</Text>
            </div>
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
            <Button
              type="primary"
              size="small"
              icon={<SaveOutlined />}
              loading={savingEmbeddingMaxChars}
              onClick={handleSaveEmbeddingMaxChars}
            >
              {t('common.save')}
            </Button>
          </Space>
        </div>
      </Card>

      <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
        <Button
          type="primary"
          icon={<SaveOutlined />}
          loading={savingModel}
          onClick={handleSaveModel}
        >
          {t('common.save')}
        </Button>
      </div>
    </div>
  )

  const renderParamsTab = () => (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <Card size="small" style={{ borderColor: token.colorBorderSecondary }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <div style={{
              width: 40,
              height: 40,
              borderRadius: 8,
              background: token.colorBgTextHover,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
            }}>
              <AimOutlined style={{ fontSize: 20, color: token.colorInfo }} />
            </div>
            <div>
              <Text strong style={{ display: 'block' }}>{t('kms.settingsPanel.maxRounds')}</Text>
              <Text type="secondary" style={{ fontSize: 12 }}>{t('kms.settingsPanel.maxRoundsDesc')}</Text>
            </div>
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
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <div style={{
              width: 40,
              height: 40,
              borderRadius: 8,
              background: token.colorBgTextHover,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
            }}>
              <ThunderboltOutlined style={{ fontSize: 20, color: token.colorWarning }} />
            </div>
            <div>
              <Text strong style={{ display: 'block' }}>{t('kms.settingsPanel.topK')}</Text>
              <Text type="secondary" style={{ fontSize: 12 }}>{t('kms.settingsPanel.topKDesc')}</Text>
            </div>
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
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <div style={{
              width: 40,
              height: 40,
              borderRadius: 8,
              background: token.colorBgTextHover,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
            }}>
              <SearchOutlined style={{ fontSize: 20, color: token.colorSuccess }} />
            </div>
            <div>
              <Text strong style={{ display: 'block' }}>{t('kms.settingsPanel.resultLimit')}</Text>
              <Text type="secondary" style={{ fontSize: 12 }}>{t('kms.settingsPanel.resultLimitDesc')}</Text>
            </div>
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
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <div style={{
              width: 40,
              height: 40,
              borderRadius: 8,
              background: token.colorBgTextHover,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
            }}>
              <FireOutlined style={{ fontSize: 20, color: token.colorError }} />
            </div>
            <div>
              <Text strong style={{ display: 'block' }}>{t('kms.settingsPanel.autoReparseHotData')}</Text>
              <Text type="secondary" style={{ fontSize: 12 }}>{t('kms.settingsPanel.autoReparseHotDataDesc')}</Text>
            </div>
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
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <div style={{
              width: 40,
              height: 40,
              borderRadius: 8,
              background: token.colorBgTextHover,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
            }}>
              <BookOutlined style={{ fontSize: 20, color: token.colorPrimary }} />
            </div>
            <div>
              <Text strong style={{ display: 'block' }}>{t('kms.knowledgeCards.enableCards')}</Text>
              <Text type="secondary" style={{ fontSize: 12 }}>{t('kms.knowledgeCards.subtitle')}</Text>
            </div>
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

      <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
        <Button
          type="primary"
          icon={<SaveOutlined />}
          loading={savingParams}
          onClick={handleSaveParams}
        >
          {t('common.save')}
        </Button>
      </div>
    </div>
  )

  const renderDirsTab = () => (
    <div>
      <div style={{ marginBottom: 12 }}>
        <Space>
          <FolderOpenOutlined style={{ color: token.colorPrimary }} />
          <Title level={5} style={{ margin: 0 }}>{t('kms.dirs')}</Title>
        </Space>
        <Paragraph type="secondary" style={{ margin: '4px 0 0', fontSize: 12 }}>
          {t('kms.settingsPanel.dirsDesc')}
        </Paragraph>
      </div>
      <KMSDirPanel
        dirs={dirs}
        onUpdateDir={onUpdateDir}
        onDeleteDir={onDeleteDir}
        onAddDir={onAddDir}
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
        onSaveAutoIndex={async (config) => onSaveSettings({ autoIndex: config })}
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
