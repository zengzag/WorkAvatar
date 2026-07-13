import React, { useState, useEffect, useCallback, useMemo } from 'react'
import { Card, Space, Typography, App, theme, Tooltip } from 'antd'
import { RobotOutlined, UserOutlined, ThunderboltOutlined, BugOutlined, CloudServerOutlined, BulbOutlined, InfoCircleOutlined } from '@ant-design/icons'
import { useTranslation } from 'react-i18next'
import LLMSelector from '../llm/LLMSelector'
import { getAllSceneDefaultModels, setSceneDefaultModel } from '../../utils/default-model'
import type { SceneKey, SceneDefaultModel } from '../../utils/default-model'
import type { LLMProvider } from '../../types'

const { Text } = Typography

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
    memory: null,
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

  const scenes: SceneConfig[] = useMemo(() => [
    { key: 'creation', icon: <RobotOutlined style={{ fontSize: 20, color: token.colorPrimary }} /> },
    { key: 'workbench', icon: <UserOutlined style={{ fontSize: 20, color: token.colorSuccess }} /> },
    { key: 'knowledge', icon: <ThunderboltOutlined style={{ fontSize: 20, color: token.colorError }} /> },
    { key: 'quick', icon: <BugOutlined style={{ fontSize: 20, color: token.colorWarning }} /> },
    { key: 'memory', icon: <BulbOutlined style={{ fontSize: 20, color: token.colorTextSecondary }} /> },
    { key: 'embedding', icon: <CloudServerOutlined style={{ fontSize: 20, color: token.colorInfo }} /> },
  ], [token.colorPrimary, token.colorSuccess, token.colorError, token.colorWarning, token.colorTextSecondary, token.colorInfo])

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
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 16 }}>
        <Text strong>{t('settings.defaultModelTitle')}</Text>
        <Tooltip title={t('settings.defaultModelHintDesc')}>
          <InfoCircleOutlined style={{ color: token.colorTextTertiary, fontSize: 12, cursor: 'help' }} />
        </Tooltip>
      </div>

      <Space direction="vertical" size={12} style={{ width: '100%' }}>
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
                    width: 36,
                    height: 36,
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
                    <Text strong>{t(`settings.defaultModelScene_${scene.key}`)}</Text>
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
