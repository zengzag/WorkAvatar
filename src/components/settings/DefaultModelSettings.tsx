import { useState, useEffect } from 'react'
import { Card, Space, Typography, App, theme, Alert } from 'antd'
import { RobotOutlined, UserOutlined, ThunderboltOutlined, BugOutlined } from '@ant-design/icons'
import { useTranslation } from 'react-i18next'
import LLMSelector from '../llm/LLMSelector'
import { getAllSceneDefaultModels, setSceneDefaultModel } from '../../utils/default-model'
import type { SceneKey, SceneDefaultModel } from '../../utils/default-model'

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
  })

  useEffect(() => {
    loadConfigs()
  }, [])

  const loadConfigs = async () => {
    try {
      const result = await getAllSceneDefaultModels()
      setConfigs(result)
    } catch {}
  }

  const scenes: SceneConfig[] = [
    { key: 'creation', icon: <RobotOutlined style={{ fontSize: 20, color: token.colorPrimary }} /> },
    { key: 'workbench', icon: <UserOutlined style={{ fontSize: 20, color: '#52c41a' }} /> },
    { key: 'knowledge', icon: <ThunderboltOutlined style={{ fontSize: 20, color: '#722ed1' }} /> },
    { key: 'quick', icon: <BugOutlined style={{ fontSize: 20, color: '#fa8c16' }} /> },
  ]

  const handleProviderChange = (scene: SceneKey) => async (providerId: string) => {
    const newConfig: SceneDefaultModel = {
      provider_id: providerId,
      model_id: '',
    }
    try {
      await setSceneDefaultModel(scene, newConfig)
      setConfigs(prev => ({ ...prev, [scene]: newConfig }))
      message.success(t('settings.defaultModelSaved'))
    } catch {
      message.error(t('settings.defaultModelSaveFailed'))
    }
  }

  const handleModelChange = (scene: SceneKey) => async (modelId: string) => {
    const current = configs[scene]
    if (!current) return
    const newConfig: SceneDefaultModel = {
      ...current,
      model_id: modelId,
    }
    try {
      await setSceneDefaultModel(scene, newConfig)
      setConfigs(prev => ({ ...prev, [scene]: newConfig }))
      message.success(t('settings.defaultModelSaved'))
    } catch {
      message.error(t('settings.defaultModelSaveFailed'))
    }
  }

  const handleClear = (scene: SceneKey) => async () => {
    try {
      await setSceneDefaultModel(scene, { provider_id: '', model_id: '' })
      setConfigs(prev => ({ ...prev, [scene]: null }))
      message.success(t('settings.defaultModelCleared'))
    } catch {
      message.error(t('settings.defaultModelSaveFailed'))
    }
  }

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
                    onProviderChange={handleProviderChange(scene.key)}
                    onModelChange={handleModelChange(scene.key)}
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

export default DefaultModelSettings
