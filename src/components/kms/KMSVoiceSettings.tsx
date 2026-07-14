import React, { useState, useEffect, useCallback, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import {
  Card, Space, Typography, Input, Button, Radio, Divider, App, theme, Tag,
  InputNumber, ColorPicker, Select, Switch,
} from 'antd'
import {
  CloudServerOutlined, DesktopOutlined, AudioOutlined, RobotOutlined,
  CheckCircleOutlined, ExclamationCircleOutlined,
  DesktopOutlined as SubtitleIcon,
} from '@ant-design/icons'
import LLMSelector from '../llm/LLMSelector'
import type { VoiceSettings, VoiceLocalModelStatus } from '../../hooks/useVoice'

const { Text } = Typography

interface KMSVoiceSettingsProps {
  settings: VoiceSettings | null
  onSaveSettings: (settings: VoiceSettings) => Promise<boolean>
  onCheckLocalModel?: () => Promise<VoiceLocalModelStatus>
}

const KMSVoiceSettings: React.FC<KMSVoiceSettingsProps> = ({
  settings, onSaveSettings, onCheckLocalModel,
}) => {
  const { t } = useTranslation()
  const { message } = App.useApp()
  const { token } = theme.useToken()

  const [localSettings, setLocalSettings] = useState<VoiceSettings | null>(settings)
  const [modelStatus, setModelStatus] = useState<VoiceLocalModelStatus | null>(null)
  const [checking, setChecking] = useState(false)
  const [micDevices, setMicDevices] = useState<MediaDeviceInfo[]>([])
  const skipAutoSaveRef = useRef(true)

  useEffect(() => {
    setLocalSettings(settings)
    skipAutoSaveRef.current = true
  }, [settings])

  // 自动保存：localSettings 变化后延迟 500ms 保存（跳过 prop 同步引起的变化）
  useEffect(() => {
    if (skipAutoSaveRef.current) {
      skipAutoSaveRef.current = false
      return
    }
    if (!localSettings) return
    const timer = setTimeout(() => {
      onSaveSettings(localSettings)
    }, 500)
    return () => clearTimeout(timer)
  }, [localSettings, onSaveSettings])

  // 枚举可用麦克风设备
  useEffect(() => {
    const enumerate = async () => {
      try {
        const devices = await navigator.mediaDevices.enumerateDevices()
        setMicDevices(devices.filter(d => d.kind === 'audioinput'))
      } catch (err) {
        console.error('Failed to enumerate mic devices:', err)
      }
    }
    enumerate()
    navigator.mediaDevices.addEventListener('devicechange', enumerate)
    return () => navigator.mediaDevices.removeEventListener('devicechange', enumerate)
  }, [])

  const update = useCallback((partial: Partial<VoiceSettings>) => {
    setLocalSettings(prev => prev ? { ...prev, ...partial } : prev)
    setModelStatus(null)
  }, [])

  const updateApiConfig = useCallback((partial: Partial<VoiceSettings['apiConfig']>) => {
    setLocalSettings(prev => prev ? { ...prev, apiConfig: { ...prev.apiConfig, ...partial } } : prev)
  }, [])

  const updateLocalConfig = useCallback((partial: Partial<VoiceSettings['localConfig']>) => {
    setLocalSettings(prev => prev ? { ...prev, localConfig: { ...prev.localConfig, ...partial } } : prev)
  }, [])

  const updateSubtitleConfig = useCallback((partial: Partial<VoiceSettings['subtitleConfig']>) => {
    setLocalSettings(prev => prev ? {
      ...prev,
      subtitleConfig: { ...prev.subtitleConfig, ...partial },
    } : prev)
  }, [])

  const handleCheckModel = useCallback(async () => {
    if (!onCheckLocalModel) return
    setChecking(true)
    try {
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
          <Radio.Button value="local"><DesktopOutlined /> {t('voice.sttModeLocal')}</Radio.Button>
          <Radio.Button value="api"><CloudServerOutlined /> {t('voice.sttModeApi')}</Radio.Button>
        </Radio.Group>

        <div style={{ marginBottom: 8, padding: 8, background: token.colorFillQuaternary, borderRadius: 6 }}>
          <Text type="secondary" style={{ fontSize: 12 }}>
            {localSettings.sttMode === 'api'
              ? t('voice.sttModeApiHint')
              : t('voice.sttModeLocalHint')}
          </Text>
        </div>

        {/* Local Config */}
        {localSettings.sttMode === 'local' && (
          <>
            <Divider style={{ margin: '12px 0' }} />
            <Space direction="vertical" style={{ width: '100%' }} size={12}>
              <div style={{ padding: 8, background: token.colorFillQuaternary, borderRadius: 6 }}>
                <Text>
                  <DesktopOutlined /> {t('voice.localModelBuiltin')}
                </Text>
                <Text type="secondary" style={{ display: 'block', fontSize: 12, marginTop: 4 }}>
                  {t('voice.localModelBuiltinHint')}
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
              {/* GPU 加速开关 */}
              <div style={{
                display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                padding: '8px 12px', background: token.colorFillQuaternary, borderRadius: 6,
              }}>
                <div>
                  <Space size={6}>
                    <Text strong>{t('voice.gpuAcceleration')}</Text>
                    <Tag color="orange" style={{ fontSize: 11 }}>{t('voice.gpuAccelerationExperimental')}</Tag>
                  </Space>
                  <Text type="secondary" style={{ display: 'block', fontSize: 12, marginTop: 2 }}>
                    {t('voice.gpuAccelerationHint')}
                  </Text>
                </div>
                <Switch
                  checked={!!localSettings.localConfig.useGPU}
                  onChange={(checked) => updateLocalConfig({ useGPU: checked })}
                />
              </div>
            </Space>
          </>
        )}

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
      </Card>

      {/* Microphone Device Selection */}
      <Card size="small" title={<Space><AudioOutlined /> {t('voice.micDevice')}</Space>}>
        <Text type="secondary" style={{ display: 'block', marginBottom: 12, fontSize: 12 }}>
          {t('voice.micDeviceHint')}
        </Text>
        <Space direction="vertical" style={{ width: '100%' }} size={12}>
          <Select
            style={{ width: '100%' }}
            value={localSettings.micDeviceId || ''}
            onChange={(val) => update({ micDeviceId: val })}
            placeholder={t('voice.micDeviceDefault')}
            options={[
              { label: t('voice.micDeviceDefault'), value: '' },
              ...micDevices.map(d => ({
                label: d.label || `Device ${d.deviceId.slice(0, 8)}`,
                value: d.deviceId,
              })),
            ]}
          />
          {micDevices.length === 0 && (
            <Text type="warning" style={{ fontSize: 12 }}>
              <ExclamationCircleOutlined /> {t('voice.micDevicePermissionHint')}
            </Text>
          )}
        </Space>
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

      {/* Floating Subtitle Settings */}
      <Card size="small" title={<Space><SubtitleIcon /> {t('voice.subtitleSettings')}</Space>}>
        <Text type="secondary" style={{ display: 'block', marginBottom: 12, fontSize: 12 }}>
          {t('voice.subtitleEnabledHint')}
        </Text>
        <Space direction="vertical" style={{ width: '100%' }} size={12}>
          <div>
            <Text strong style={{ display: 'block', marginBottom: 4 }}>{t('voice.subtitleFontSize')}</Text>
            <InputNumber
              min={12}
              max={72}
              value={localSettings.subtitleConfig.fontSize}
              onChange={(val) => updateSubtitleConfig({ fontSize: val || 28 })}
              style={{ width: 120 }}
            />
            <Text type="secondary" style={{ marginLeft: 8, fontSize: 12 }}>px</Text>
          </div>
          <Space size={24}>
            <div>
              <Text strong style={{ display: 'block', marginBottom: 4 }}>{t('voice.subtitleTextColor')}</Text>
              <ColorPicker
                value={localSettings.subtitleConfig.textColor}
                onChange={(color) => updateSubtitleConfig({ textColor: color.toHexString() })}
              >
                <div style={{
                  width: 40, height: 24, borderRadius: 4,
                  background: localSettings.subtitleConfig.textColor,
                  border: `1px solid ${token.colorBorder}`,
                  cursor: 'pointer',
                }} />
              </ColorPicker>
            </div>
            <div>
              <Text strong style={{ display: 'block', marginBottom: 4 }}>{t('voice.subtitleBgColor')}</Text>
              <ColorPicker
                value={localSettings.subtitleConfig.backgroundColor}
                onChange={(color) => updateSubtitleConfig({ backgroundColor: color.toHexString() })}
              >
                <div style={{
                  width: 40, height: 24, borderRadius: 4,
                  background: localSettings.subtitleConfig.backgroundColor,
                  border: `1px solid ${token.colorBorder}`,
                  cursor: 'pointer',
                }} />
              </ColorPicker>
            </div>
          </Space>
          <div>
            <Text strong style={{ display: 'block', marginBottom: 4 }}>
              {t('voice.subtitleOpacity')}: {localSettings.subtitleConfig.backgroundOpacity}%
            </Text>
            <input
              type="range"
              min={0}
              max={100}
              value={localSettings.subtitleConfig.backgroundOpacity}
              onChange={(e) => updateSubtitleConfig({ backgroundOpacity: Number(e.target.value) })}
              style={{ width: '100%', accentColor: token.colorPrimary }}
            />
          </div>
          <div>
            <Text strong style={{ display: 'block', marginBottom: 4 }}>{t('voice.subtitleWindowSize')}</Text>
            <Space>
              <div>
                <Text type="secondary" style={{ fontSize: 12 }}>{t('voice.subtitleWidth')}</Text>
                <InputNumber
                  min={300}
                  max={1920}
                  value={localSettings.subtitleConfig.windowWidth}
                  onChange={(val) => updateSubtitleConfig({ windowWidth: val || 600 })}
                  style={{ width: 100 }}
                />
              </div>
              <div>
                <Text type="secondary" style={{ fontSize: 12 }}>{t('voice.subtitleHeight')}</Text>
                <InputNumber
                  min={60}
                  max={400}
                  value={localSettings.subtitleConfig.windowHeight}
                  onChange={(val) => updateSubtitleConfig({ windowHeight: val || 120 })}
                  style={{ width: 100 }}
                />
              </div>
            </Space>
          </div>
        </Space>
      </Card>
    </div>
  )
}

export default KMSVoiceSettings
