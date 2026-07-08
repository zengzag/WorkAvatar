import React, { useState, useEffect, useCallback, useMemo } from 'react'
import { Card, Space, Typography, App, theme, Alert } from 'antd'
import { RobotOutlined, UserOutlined, ThunderboltOutlined, BugOutlined, CloudServerOutlined } from '@ant-design/icons'
import { useTranslation } from 'react-i18next'
import LLMSelector from '../llm/LLMSelector'
import { getAllSceneDefaultModels, setSceneDefaultModel } from '../../utils/default-model'
import type { SceneKey, SceneDefaultModel } from '../../utils/default-model'
import type { LLMProvider } from '../../types'

const { Title, Text, Paragraph } = Typography

interface SceneConfig {
  key: SceneKey
  icon: React.ReactNode
}

const DefaultModelSettings: React.FC = () => {
  const { t } = useTranslation()
  const { message } = App.useApp()
  const { token } = theme.useToken()

  const [configs, setConfigs] = useState<Record<SceneKey, SceneDefaultModel | null>>({
    creation: null,
    workbench: null,
    knowledge: null,
    quick: null,
    embedding: null,
  })
  const [providers, setProviders] = useState<LLMProvider[]>([])

  const loadProviders = useCallback(async () => {
    try {
      const result = await window.electronAPI.llm.getProviders()
      setProviders(result as LLMProvider[])
    } catch {}
  }, [])

  const loadConfigs = useCallback(async () => {
    try {
      const result = await getAllSceneDefaultModels()
      setConfigs(result)
    } catch {}
  }, [])

  useEffect(() => {
    loadProviders()
    loadConfigs()
  }, [loadProviders, loadConfigs])

  // 场景图标使用语义色 token，自动适配明暗主题
  const scenes: SceneConfig[] = useMemo(() => [
    { key: 'creation', icon: <RobotOutlined style={{ fontSize: 20, color: token.colorPrimary }} /> },
    { key: 'workbench', icon: <UserOutlined style={{ fontSize: 20, color: token.colorSuccess }} /> },
    { key: 'knowledge', icon: <ThunderboltOutlined style={{ fontSize: 20, color: token.colorError }} /> },
    { key: 'quick', icon: <BugOutlined style={{ fontSize: 20, color: token.colorWarning }} /> },
    { key: 'embedding', icon: <CloudServerOutlined style={{ fontSize: 20, color: token.colorInfo }} /> },
  ], [token.colorPrimary, token.colorSuccess, token.colorError, token.colorWarning, token.colorInfo])

  const handleLlmChange = useCallback((scene: SceneKey) => async (providerId: string, modelId: string) => {
    const newConfig: SceneDefaultModel = {
      provider_id: providerId,
      model_id: modelId,
    }
    try {
      await setSceneDefaultModel(scene, newConfig)
      setConfigs(prev => ({ ...prev, [scene]: newConfig }))
      if (providerId) {
        message.success(t('settings.defaultModelSaved'))
      }
    } catch {
      message.error(t('settings.defaultModelSaveFailed'))
    }
  }, [message, t])

  const handleClear = useCallback((scene: SceneKey) => async () => {
    try {
      await setSceneDefaultModel(scene, { provider_id: '', model_id: '' })
      setConfigs(prev => ({ ...prev, [scene]: null }))
      message.success(t('settings.defaultModelCleared'))
    } catch {
      message.error(t('settings.defaultModelSaveFailed'))
    }
  }, [message, t])

  return (
    <div>
      <div style={{ marginBottom: 16 }}>
        <Title level={5} style={{ margin: 0 }}>{t('settings.defaultModelTitle')}</Title>
        <Paragraph type="secondary" style={{ margin: '4px 0 0' }}>{t('settings.defaultModelDesc')}</Paragraph>
      </div>

      <Alert
        title={t('settings.defaultModelHint')}
        description={t('settings.defaultModelHintDesc')}
        type="info"
        showIcon
        style={{ marginBottom: 16 }}
      />

      <Space orientation="vertical" size={16} style={{ width: '100%' }}>
        {scenes.map(scene => {
          const config = configs[scene.key]
          return (
            <Card
              key={scene.key}
              size="small"
              style={{ borderColor: token.colorBorderSecondary }}
            >
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
                    {scene.icon}
                  </div>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <Text strong style={{ display: 'block' }}>{t(`settings.defaultModelScene_${scene.key}`)}</Text>
                    <Text type="secondary" style={{ fontSize: 12 }}>{t(`settings.defaultModelScene_${scene.key}_desc`)}</Text>
                  </div>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <LLMSelector
                    providerId={config?.provider_id || ''}
                    modelId={config?.model_id || ''}
                    onChange={handleLlmChange(scene.key)}
                    modelCategory={scene.key === 'embedding' ? 'embedding' : 'chat'}
                    providers={providers}
                    style={{ flexShrink: 0 }}
                  />
                  {config?.provider_id && (
                    <Text
                      type="secondary"
                      style={{ fontSize: 12, cursor: 'pointer', whiteSpace: 'nowrap' }}
                      onClick={handleClear(scene.key)}
                    >
                      {t('common.clearAll')}
                    </Text>
                  )}
                </div>
              </div>
            </Card>
          )
        })}
      </Space>
    </div>
  )
}

export default React.memo(DefaultModelSettings)
