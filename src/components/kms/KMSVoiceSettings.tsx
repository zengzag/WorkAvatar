import React, { useState, useEffect, useCallback, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import {
  Card, Space, Typography, Input, Button, Radio, Divider, App, theme, Tag,
  InputNumber, ColorPicker, Select, Tabs,
} from 'antd'
import {
  CloudServerOutlined, DesktopOutlined, AudioOutlined, RobotOutlined,
  CheckCircleOutlined, ExclamationCircleOutlined,
  DesktopOutlined as SubtitleIcon,
} from '@ant-design/icons'
import LLMSelector from '../llm/LLMSelector'
import SettingsItem from '../common/SettingsItem'
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

  const cardStyle: React.CSSProperties = { borderColor: token.colorBorderSecondary }

  const renderEngineTab = () => (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      {/* STT 引擎模式 */}
      <Card size="small" style={cardStyle}>
        <SettingsItem
          title={t('voice.sttEngine')}
          description={localSettings.sttMode === 'api' ? t('voice.sttModeApiHint') : t('voice.sttModeLocalHint')}
          extra={
            <Radio.Group
              value={localSettings.sttMode}
              onChange={(e) => update({ sttMode: e.target.value })}
              optionType="button"
              buttonStyle="solid"
            >
              <Radio.Button value="local"><DesktopOutlined /> {t('voice.sttModeLocal')}</Radio.Button>
              <Radio.Button value="api"><CloudServerOutlined /> {t('voice.sttModeApi')}</Radio.Button>
            </Radio.Group>
          }
        />
      </Card>

      {/* 本地引擎配置 */}
      {localSettings.sttMode === 'local' && (
        <Card size="small" style={cardStyle}>
          <SettingsItem
            title={t('voice.localModelBuiltin')}
            description={t('voice.localModelBuiltinHint')}
            extra={
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
            }
          />
        </Card>
      )}

      {/* API 配置 */}
      {localSettings.sttMode === 'api' && (
        <Card size="small" style={cardStyle}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            <SettingsItem
              title={t('voice.sttModeApi')}
              description={t('voice.sttModeApiHint')}
            />
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              <div>
                <Text type="secondary" style={{ display: 'block', marginBottom: 4, fontSize: 12 }}>{t('voice.apiEndpoint')}</Text>
                <Input
                  value={localSettings.apiConfig.endpoint}
                  onChange={(e) => updateApiConfig({ endpoint: e.target.value })}
                  placeholder="https://api.openai.com/v1/audio/transcriptions"
                />
              </div>
              <div>
                <Text type="secondary" style={{ display: 'block', marginBottom: 4, fontSize: 12 }}>{t('voice.apiKey')}</Text>
                <Input.Password
                  value={localSettings.apiConfig.apiKey}
                  onChange={(e) => updateApiConfig({ apiKey: e.target.value })}
                  placeholder="sk-..."
                />
              </div>
              <Space size={12}>
                <div>
                  <Text type="secondary" style={{ display: 'block', marginBottom: 4, fontSize: 12 }}>{t('voice.sttModel')}</Text>
                  <Input
                    value={localSettings.apiConfig.model}
                    onChange={(e) => updateApiConfig({ model: e.target.value })}
                    placeholder="whisper-1"
                    style={{ width: 180 }}
                  />
                </div>
                <div>
                  <Text type="secondary" style={{ display: 'block', marginBottom: 4, fontSize: 12 }}>{t('voice.language')}</Text>
                  <Input
                    value={localSettings.apiConfig.language}
                    onChange={(e) => updateApiConfig({ language: e.target.value })}
                    placeholder="zh"
                    style={{ width: 100 }}
                  />
                </div>
              </Space>
            </div>
          </div>
        </Card>
      )}

      {/* 麦克风设备 */}
      <Card size="small" style={cardStyle}>
        <SettingsItem
          title={t('voice.micDevice')}
          description={t('voice.micDeviceHint')}
          extra={
            <Select
              style={{ width: 200 }}
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
          }
        />
        {micDevices.length === 0 && (
          <div>
            <Text type="warning" style={{ fontSize: 12 }}>
              <ExclamationCircleOutlined /> {t('voice.micDevicePermissionHint')}
            </Text>
          </div>
        )}
      </Card>
    </div>
  )

  const renderMinutesTab = () => (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <Card size="small" style={cardStyle}>
        <SettingsItem
          title={t('voice.minutesModel')}
          description={t('voice.minutesModelHint')}
          extra={
            <LLMSelector
              providerId={localSettings.minutesModel?.provider_id}
              modelId={localSettings.minutesModel?.model_id}
              onChange={(providerId, modelId) => {
                update({ minutesModel: { provider_id: providerId, model_id: modelId } })
              }}
            />
          }
        />
      </Card>
    </div>
  )

  const renderSubtitleTab = () => (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <Card size="small" style={cardStyle}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <SettingsItem
            title={t('voice.subtitleSettings')}
            description={t('voice.subtitleEnabledHint')}
          />
          <Divider style={{ margin: '4px 0' }} />
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <Text strong style={{ fontSize: 13 }}>{t('voice.subtitleFontSize')}</Text>
              <Space>
                <InputNumber
                  min={12}
                  max={72}
                  value={localSettings.subtitleConfig.fontSize}
                  onChange={(val) => updateSubtitleConfig({ fontSize: val || 28 })}
                  style={{ width: 120 }}
                />
                <Text type="secondary" style={{ fontSize: 12 }}>px</Text>
              </Space>
            </div>
            <Divider style={{ margin: '4px 0' }} />
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <Text strong style={{ fontSize: 13 }}>{t('voice.subtitleTextColor')}</Text>
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
            <Divider style={{ margin: '4px 0' }} />
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <Text strong style={{ fontSize: 13 }}>{t('voice.subtitleBgColor')}</Text>
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
            <Divider style={{ margin: '4px 0' }} />
            <div>
              <Text strong style={{ display: 'block', marginBottom: 4, fontSize: 13 }}>
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
            <Divider style={{ margin: '4px 0' }} />
            <div>
              <Text strong style={{ display: 'block', marginBottom: 4, fontSize: 13 }}>{t('voice.subtitleWindowSize')}</Text>
              <Space>
                <div>
                  <Text type="secondary" style={{ fontSize: 12 }}>{t('voice.subtitleWidth')}</Text>
                  <InputNumber
                    min={300}
                    max={1920}
                    value={localSettings.subtitleConfig.windowWidth}
                    onChange={(val) => updateSubtitleConfig({ windowWidth: val || 600 })}
                    style={{ width: 100, marginLeft: 8 }}
                  />
                </div>
                <div>
                  <Text type="secondary" style={{ fontSize: 12 }}>{t('voice.subtitleHeight')}</Text>
                  <InputNumber
                    min={60}
                    max={400}
                    value={localSettings.subtitleConfig.windowHeight}
                    onChange={(val) => updateSubtitleConfig({ windowHeight: val || 120 })}
                    style={{ width: 100, marginLeft: 8 }}
                  />
                </div>
              </Space>
            </div>
          </div>
        </div>
      </Card>
    </div>
  )

  const tabItems = [
    {
      key: 'engine',
      label: <span><AudioOutlined style={{ marginRight: 4 }} />{t('voice.settingsTabEngine')}</span>,
      children: renderEngineTab(),
    },
    {
      key: 'minutes',
      label: <span><RobotOutlined style={{ marginRight: 4 }} />{t('voice.settingsTabMinutes')}</span>,
      children: renderMinutesTab(),
    },
    {
      key: 'subtitle',
      label: <span><SubtitleIcon style={{ marginRight: 4 }} />{t('voice.settingsTabSubtitle')}</span>,
      children: renderSubtitleTab(),
    },
  ]

  return (
    <Tabs
      defaultActiveKey="engine"
      items={tabItems}
      size="small"
      style={{ height: '100%' }}
      tabBarStyle={{ marginBottom: 16 }}
    />
  )
}

export default KMSVoiceSettings
