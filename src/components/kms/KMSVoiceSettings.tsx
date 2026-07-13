import React, { useState, useEffect, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import {
  Card, Space, Typography, Input, Button, Radio, Divider, App, theme, Select, Tag,
} from 'antd'
import {
  CloudServerOutlined, DesktopOutlined, AudioOutlined, RobotOutlined, SaveOutlined,
  FolderOpenOutlined, CheckCircleOutlined, ExclamationCircleOutlined,
} from '@ant-design/icons'
import LLMSelector from '../llm/LLMSelector'
import type { VoiceSettings, VoiceLocalModelStatus } from '../../hooks/useVoice'

const { Text } = Typography

interface KMSVoiceSettingsProps {
  settings: VoiceSettings | null
  onSaveSettings: (settings: VoiceSettings) => Promise<boolean>
  onCheckLocalModel?: () => Promise<VoiceLocalModelStatus>
  onSelectDirectory?: () => Promise<string | null>
}

const KMSVoiceSettings: React.FC<KMSVoiceSettingsProps> = ({
  settings, onSaveSettings, onCheckLocalModel, onSelectDirectory,
}) => {
  const { t } = useTranslation()
  const { message } = App.useApp()
  const { token } = theme.useToken()

  const [localSettings, setLocalSettings] = useState<VoiceSettings | null>(settings)
  const [saving, setSaving] = useState(false)
  const [modelStatus, setModelStatus] = useState<VoiceLocalModelStatus | null>(null)
  const [checking, setChecking] = useState(false)

  useEffect(() => {
    setLocalSettings(settings)
  }, [settings])

  const update = useCallback((partial: Partial<VoiceSettings>) => {
    setLocalSettings(prev => prev ? { ...prev, ...partial } : prev)
    setModelStatus(null)
  }, [])

  const updateApiConfig = useCallback((partial: Partial<VoiceSettings['apiConfig']>) => {
    setLocalSettings(prev => prev ? { ...prev, apiConfig: { ...prev.apiConfig, ...partial } } : prev)
  }, [])

  const updateLocalConfig = useCallback((partial: Partial<VoiceSettings['localConfig']>) => {
    setLocalSettings(prev => prev ? { ...prev, localConfig: { ...prev.localConfig, ...partial } } : prev)
    setModelStatus(null)
  }, [])

  const handleSave = useCallback(async () => {
    if (!localSettings) return
    setSaving(true)
    try {
      const ok = await onSaveSettings(localSettings)
      if (ok) {
        message.success(t('common.saveSuccess'))
      } else {
        message.error(t('common.saveFailed'))
      }
    } catch {
      message.error(t('common.saveFailed'))
    } finally {
      setSaving(false)
    }
  }, [localSettings, onSaveSettings, t, message])

  const handleCheckModel = useCallback(async () => {
    if (!onCheckLocalModel) return
    setChecking(true)
    try {
      // Save first to ensure latest config is checked
      if (localSettings) {
        await onSaveSettings(localSettings)
      }
      const status = await onCheckLocalModel()
      setModelStatus(status)
      if (status.available) {
        message.success(t('voice.localModelAvailable'))
      } else {
        message.warning(status.error || t('voice.localModelNotConfigured'))
      }
    } catch (err: any) {
      message.error(err?.message || t('voice.localModelLoadFailed'))
    } finally {
      setChecking(false)
    }
  }, [onCheckLocalModel, localSettings, onSaveSettings, t, message])

  const handleSelectDir = useCallback(async () => {
    if (!onSelectDirectory) return
    try {
      const dir = await onSelectDirectory()
      if (dir) {
        updateLocalConfig({ modelDir: dir })
      }
    } catch (err: any) {
      message.error(err?.message || 'Failed to select directory')
    }
  }, [onSelectDirectory, updateLocalConfig, message])

  if (!localSettings) {
    return <div style={{ padding: 20 }}><Text type="secondary">{t('voice.loadingSettings')}</Text></div>
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      {/* STT Mode */}
      <Card size="small" title={<Space><AudioOutlined /> {t('voice.sttEngine')}</Space>}>
        <Radio.Group
          value={localSettings.sttMode}
          onChange={(e) => update({ sttMode: e.target.value })}
          style={{ marginBottom: 16 }}
        >
          <Radio.Button value="api"><CloudServerOutlined /> {t('voice.sttModeApi')}</Radio.Button>
          <Radio.Button value="local"><DesktopOutlined /> {t('voice.sttModeLocal')}</Radio.Button>
        </Radio.Group>

        <div style={{ marginBottom: 8, padding: 8, background: token.colorFillQuaternary, borderRadius: 6 }}>
          <Text type="secondary" style={{ fontSize: 12 }}>
            {localSettings.sttMode === 'api'
              ? t('voice.sttModeApiHint')
              : t('voice.sttModeLocalHint')}
          </Text>
        </div>

        {/* API Config */}
        {localSettings.sttMode === 'api' && (
          <>
            <Divider style={{ margin: '12px 0' }} />
            <Space direction="vertical" style={{ width: '100%' }} size={12}>
              <div>
                <Text strong style={{ display: 'block', marginBottom: 4 }}>{t('voice.apiEndpoint')}</Text>
                <Input
                  value={localSettings.apiConfig.endpoint}
                  onChange={(e) => updateApiConfig({ endpoint: e.target.value })}
                  placeholder="https://api.openai.com/v1/audio/transcriptions"
                />
              </div>
              <div>
                <Text strong style={{ display: 'block', marginBottom: 4 }}>{t('voice.apiKey')}</Text>
                <Input.Password
                  value={localSettings.apiConfig.apiKey}
                  onChange={(e) => updateApiConfig({ apiKey: e.target.value })}
                  placeholder="sk-..."
                />
              </div>
              <Space size={12}>
                <div>
                  <Text strong style={{ display: 'block', marginBottom: 4 }}>{t('voice.sttModel')}</Text>
                  <Input
                    value={localSettings.apiConfig.model}
                    onChange={(e) => updateApiConfig({ model: e.target.value })}
                    placeholder="whisper-1"
                    style={{ width: 180 }}
                  />
                </div>
                <div>
                  <Text strong style={{ display: 'block', marginBottom: 4 }}>{t('voice.language')}</Text>
                  <Input
                    value={localSettings.apiConfig.language}
                    onChange={(e) => updateApiConfig({ language: e.target.value })}
                    placeholder="zh"
                    style={{ width: 100 }}
                  />
                </div>
              </Space>
            </Space>
          </>
        )}

        {/* Local Config */}
        {localSettings.sttMode === 'local' && (
          <>
            <Divider style={{ margin: '12px 0' }} />
            <Space direction="vertical" style={{ width: '100%' }} size={12}>
              <div>
                <Text strong style={{ display: 'block', marginBottom: 4 }}>{t('voice.localModelType')}</Text>
                <Select
                  value={localSettings.localConfig.modelType}
                  onChange={(val) => updateLocalConfig({ modelType: val })}
                  style={{ width: 200 }}
                  options={[
                    { value: 'whisper', label: 'Whisper (多语言)' },
                    { value: 'paraformer', label: 'Paraformer (中文)' },
                    { value: 'zipformer', label: 'Zipformer (中英文)' },
                  ]}
                />
              </div>
              <div>
                <Text strong style={{ display: 'block', marginBottom: 4 }}>{t('voice.localModelPath')}</Text>
                <Space.Compact style={{ width: '100%' }}>
                  <Input
                    value={localSettings.localConfig.modelDir}
                    onChange={(e) => updateLocalConfig({ modelDir: e.target.value })}
                    placeholder={t('voice.localModelPathHint')}
                  />
                  <Button
                    icon={<FolderOpenOutlined />}
                    onClick={handleSelectDir}
                  >
                    {t('voice.selectModelDir')}
                  </Button>
                </Space.Compact>
              </div>
              <div>
                <Text strong style={{ display: 'block', marginBottom: 4 }}>{t('voice.language')}</Text>
                <Input
                  value={localSettings.localConfig.language}
                  onChange={(e) => updateLocalConfig({ language: e.target.value })}
                  placeholder="zh"
                  style={{ width: 100 }}
                />
              </div>
              <div style={{ padding: 8, background: token.colorFillQuaternary, borderRadius: 6 }}>
                <Text type="secondary" style={{ fontSize: 12 }}>
                  {t('voice.localModelPathHint')}
                </Text>
              </div>
              {/* Model status check */}
              <Space>
                <Button
                  icon={<CheckCircleOutlined />}
                  loading={checking}
                  onClick={handleCheckModel}
                >
                  {t('voice.checkModel')}
                </Button>
                {modelStatus && (
                  modelStatus.available ? (
                    <Tag icon={<CheckCircleOutlined />} color="success">
                      {t('voice.modelAvailable')}
                    </Tag>
                  ) : (
                    <Tag icon={<ExclamationCircleOutlined />} color="error">
                      {modelStatus.error || t('voice.localModelNotConfigured')}
                    </Tag>
                  )
                )}
              </Space>
            </Space>
          </>
        )}
      </Card>

      {/* Minutes LLM Model */}
      <Card size="small" title={<Space><RobotOutlined /> {t('voice.minutesModel')}</Space>}>
        <Text type="secondary" style={{ display: 'block', marginBottom: 12, fontSize: 12 }}>
          {t('voice.minutesModelHint')}
        </Text>
        <LLMSelector
          providerId={localSettings.minutesModel?.provider_id}
          modelId={localSettings.minutesModel?.model_id}
          onChange={(providerId, modelId) => {
            update({ minutesModel: { provider_id: providerId, model_id: modelId } })
          }}
        />
      </Card>

      {/* Save Button */}
      <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
        <Button
          type="primary"
          icon={<SaveOutlined />}
          loading={saving}
          onClick={handleSave}
        >
          {t('common.save')}
        </Button>
      </div>
    </div>
  )
}

export default KMSVoiceSettings
