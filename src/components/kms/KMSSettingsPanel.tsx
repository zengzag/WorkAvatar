import React, { useState, useEffect, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import {
  Tabs, Card, Space, Typography, App, theme, InputNumber, Button, Alert, Divider, Tag,
} from 'antd'
import {
  RobotOutlined, CloudServerOutlined, SaveOutlined, FolderOpenOutlined,
  DatabaseOutlined, ThunderboltOutlined, AimOutlined,
} from '@ant-design/icons'
import LLMSelector from '../llm/LLMSelector'
import KMSDirPanel from './KMSDirPanel'
import KMSIndexPanel from './KMSIndexPanel'
import type { LLMProvider } from '../../types'
import type { KMSSettings, KMSModelConfig } from '../../hooks/useKMS'

const { Title, Text, Paragraph } = Typography

interface IndexDir {
  id: string
  dir_path: string
  display_name: string
  enabled: number
  recursive: number
  file_extensions: string
  created_at: number
  updated_at: number
}

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

interface KMSSettingsPanelProps {
  settings: KMSSettings
  onSaveSettings: (params: {
    model?: KMSModelConfig | null
    embeddingModel?: KMSModelConfig | null
    searchParams?: { maxRounds?: number; topK?: number }
  }) => Promise<boolean>
  // 目录管理
  dirs: IndexDir[]
  onAddDir: (dirPath: string, displayName?: string, recursive?: boolean, fileExtensions?: string[]) => void
  onUpdateDir: (id: string, updates: { displayName?: string; enabled?: boolean; recursive?: boolean; fileExtensions?: string[] }) => void
  onDeleteDir: (id: string) => void
  // 索引管理
  stats: KMSStats | null
  isIndexing: boolean
  indexProgress: IndexProgress | null
  onBuildIndex: () => void
  onIncrementalIndex: () => void
  onRebuildIndex: () => void
  onCancelIndex: () => void
}

const KMSSettingsPanel: React.FC<KMSSettingsPanelProps> = ({
  settings,
  onSaveSettings,
  dirs,
  onAddDir,
  onUpdateDir,
  onDeleteDir,
  stats,
  isIndexing,
  indexProgress,
  onBuildIndex,
  onIncrementalIndex,
  onRebuildIndex,
  onCancelIndex,
}) => {
  const { t } = useTranslation()
  const { message } = App.useApp()
  const { token } = theme.useToken()

  const [providers, setProviders] = useState<LLMProvider[]>([])
  // 本地编辑态（避免每次选择都立即保存）
  const [modelConfig, setModelConfig] = useState<KMSModelConfig | null>(settings.model)
  const [embeddingModelConfig, setEmbeddingModelConfig] = useState<KMSModelConfig | null>(settings.embeddingModel)
  const [maxRounds, setMaxRounds] = useState<number>(settings.searchParams?.maxRounds ?? 3)
  const [topK, setTopK] = useState<number>(settings.searchParams?.topK ?? 10)
  const [savingModel, setSavingModel] = useState(false)
  const [savingParams, setSavingParams] = useState(false)

  // 加载 LLM 提供商列表
  useEffect(() => {
    window.electronAPI.llm.getProviders().then((result: any) => {
      setProviders(result as LLMProvider[])
    }).catch(() => {})
  }, [])

  // 同步外部 settings 变化
  useEffect(() => {
    setModelConfig(settings.model)
    setEmbeddingModelConfig(settings.embeddingModel)
    setMaxRounds(settings.searchParams?.maxRounds ?? 3)
    setTopK(settings.searchParams?.topK ?? 10)
  }, [settings])

  // 保存模型设置
  const handleSaveModel = useCallback(async () => {
    setSavingModel(true)
    const ok = await onSaveSettings({
      model: modelConfig,
      embeddingModel: embeddingModelConfig,
    })
    setSavingModel(false)
    if (ok) {
      message.success(t('kms.settingsPanel.modelSaved'))
    } else {
      message.error(t('kms.settingsPanel.modelSaveFailed'))
    }
  }, [modelConfig, embeddingModelConfig, onSaveSettings, message, t])

  // 保存检索参数
  const handleSaveParams = useCallback(async () => {
    setSavingParams(true)
    const ok = await onSaveSettings({
      searchParams: { maxRounds, topK },
    })
    setSavingParams(false)
    if (ok) {
      message.success(t('kms.settingsPanel.paramsSaved'))
    } else {
      message.error(t('kms.settingsPanel.modelSaveFailed'))
    }
  }, [maxRounds, topK, onSaveSettings, message, t])

  // 模型设置 Tab
  const renderModelTab = () => (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <Alert
        type="info"
        showIcon
        message={t('kms.settingsPanel.modelHint')}
        description={t('kms.settingsPanel.modelHintDesc')}
      />

      {/* AI 搜索模型 */}
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
                  setModelConfig({ provider_id: providerId, model_id: modelId })
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
      </Card>

      {/* Embedding 模型 */}
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
              <CloudServerOutlined style={{ fontSize: 20, color: '#13c2c2' }} />
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

  // 检索参数 Tab
  const renderParamsTab = () => (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <Alert
        type="info"
        showIcon
        message={t('kms.settingsPanel.paramsHint')}
        description={t('kms.settingsPanel.paramsHintDesc')}
      />

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
              <AimOutlined style={{ fontSize: 20, color: '#722ed1' }} />
            </div>
            <div>
              <Text strong style={{ display: 'block' }}>{t('kms.settingsPanel.maxRounds')}</Text>
              <Text type="secondary" style={{ fontSize: 12 }}>{t('kms.settingsPanel.maxRoundsDesc')}</Text>
            </div>
          </div>
          <InputNumber
            value={maxRounds}
            onChange={v => setMaxRounds(v || 3)}
            min={1}
            max={5}
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
              <ThunderboltOutlined style={{ fontSize: 20, color: '#fa8c16' }} />
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
            max={30}
            style={{ width: 120 }}
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

  // 目录管理 Tab
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

  // 索引管理 Tab
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
        stats={stats}
        isIndexing={isIndexing}
        indexProgress={indexProgress}
        onBuildIndex={onBuildIndex}
        onIncrementalIndex={onIncrementalIndex}
        onRebuildIndex={onRebuildIndex}
        onCancelIndex={onCancelIndex}
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
