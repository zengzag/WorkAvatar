import React, { useState, useEffect, useCallback, useMemo } from 'react'
import { Typography, Select, Slider, Button, Divider, Card, Space, Segmented, Input, Tag, App, theme } from 'antd'
import { GlobalOutlined, ExportOutlined } from '@ant-design/icons'
import { useTranslation } from 'react-i18next'
import SettingsItem from '../common/SettingsItem'
import type {
  SearchApiProviderId,
  SearchApiProviderInfo,
  WebSearchMode,
} from '../../../electron/shared/channels/tool'

const { Title, Text } = Typography

interface EngineInfo {
  id: string
  name: string
  homepage: string
}

const SEARCH_RESULT_COUNT_MIN = 1
const SEARCH_RESULT_COUNT_MAX = 10

// 滑块刻度（模块级常量，避免每次渲染重建）
const RESULT_COUNT_MARKS: Record<number, string> = {
  1: '1',
  3: '3',
  5: '5',
  7: '7',
  10: '10',
}

const getDefaultEngineKey = () => 'web_search_engine'
const getDefaultResultCountKey = () => 'web_search_result_count'
const getSearchModeKey = () => 'web_search_mode'
const getSearchApiProviderKey = () => 'web_search_api_provider'

const DEFAULT_PROVIDERS: SearchApiProviderInfo[] = [
  { id: 'deepseek', name: 'DeepSeek', hasKey: false },
  { id: 'tavily', name: 'Tavily', hasKey: false },
  { id: 'brave', name: 'Brave Search', hasKey: false },
]

const InternetSearchSettings: React.FC = () => {
  const { t } = useTranslation()
  const { message } = App.useApp()
  const { token } = theme.useToken()

  const [engines, setEngines] = useState<EngineInfo[]>([])
  const [defaultEngine, setDefaultEngine] = useState<string>('google')
  const [resultCount, setResultCount] = useState<number>(5)
  const [loading, setLoading] = useState(false)

  const [mode, setMode] = useState<WebSearchMode>('browser')
  const [provider, setProvider] = useState<SearchApiProviderId>('deepseek')
  const [providers, setProviders] = useState<SearchApiProviderInfo[]>(DEFAULT_PROVIDERS)
  const [apiKeyInput, setApiKeyInput] = useState('')
  const [savingKey, setSavingKey] = useState(false)

  const refreshApiStatus = useCallback(async () => {
    try {
      const status = await window.electronAPI.searchApi.getStatus()
      if (status?.providers) {
        setMode(status.mode)
        setProvider(status.provider)
        setProviders(status.providers)
      }
    } catch {
      // 状态读取失败时保留默认值
    }
  }, [])

  const loadSettings = useCallback(async () => {
    try {
      const result = await window.electronAPI.searchWindow.getEngines()
      setEngines(result as EngineInfo[])

      const engineVal = await window.electronAPI.settings.get({ key: getDefaultEngineKey() })
      if (engineVal) setDefaultEngine(engineVal)

      const countVal = await window.electronAPI.settings.get({ key: getDefaultResultCountKey() })
      // 明确判空，避免 "0" 被当作 falsy 跳过
      if (countVal !== undefined && countVal !== null && countVal !== '') {
        const parsed = parseInt(countVal, 10)
        if (!Number.isNaN(parsed)) setResultCount(parsed)
      }

      await refreshApiStatus()
    } catch {
      // ignore load errors
    }
  }, [refreshApiStatus])

  useEffect(() => {
    loadSettings()
  }, [loadSettings])

  const engineOptions = useMemo(() => engines.map((e) => ({ label: e.name, value: e.id })), [engines])
  const providerOptions = useMemo(() => providers.map((p) => ({ label: p.name, value: p.id })), [providers])
  const currentProvider = providers.find((p) => p.id === provider)
  const providerName = currentProvider?.name || provider
  const hasKey = !!currentProvider?.hasKey

  const handleEngineChange = useCallback(async (value: string) => {
    setDefaultEngine(value)
    try {
      await window.electronAPI.settings.set({ key: getDefaultEngineKey(), value })
      message.success(t('settings.saved'))
    } catch {
      message.error(t('common.saveFailed'))
    }
  }, [message, t])

  const handleResultCountChange = useCallback(async (value: number) => {
    setResultCount(value)
    try {
      await window.electronAPI.settings.set({ key: getDefaultResultCountKey(), value: String(value) })
    } catch {
      // save failed silently
    }
  }, [])

  const handleModeChange = useCallback(async (value: string | number) => {
    const next = value as WebSearchMode
    setMode(next)
    try {
      await window.electronAPI.settings.set({ key: getSearchModeKey(), value: next })
      message.success(t('settings.saved'))
    } catch {
      message.error(t('common.saveFailed'))
    }
  }, [message, t])

  const handleProviderChange = useCallback(async (value: SearchApiProviderId) => {
    setProvider(value)
    setApiKeyInput('')
    try {
      await window.electronAPI.settings.set({ key: getSearchApiProviderKey(), value })
    } catch {
      message.error(t('common.saveFailed'))
    }
  }, [message, t])

  const handleSaveKey = useCallback(async () => {
    const key = apiKeyInput.trim()
    if (!key) {
      message.warning(t('settings.searchApiKeyRequired'))
      return
    }
    setSavingKey(true)
    try {
      const res = await window.electronAPI.searchApi.setKey({ provider, apiKey: key })
      if (res?.success) {
        setApiKeyInput('')
        await refreshApiStatus()
        message.success(t('settings.saved'))
      } else {
        message.error(res?.error || t('common.saveFailed'))
      }
    } catch {
      message.error(t('common.saveFailed'))
    } finally {
      setSavingKey(false)
    }
  }, [apiKeyInput, provider, refreshApiStatus, message, t])

  const handleClearKey = useCallback(async () => {
    setSavingKey(true)
    try {
      const res = await window.electronAPI.searchApi.clearKey(provider)
      if (res?.success) {
        await refreshApiStatus()
        message.success(t('settings.saved'))
      } else {
        message.error(res?.error || t('common.saveFailed'))
      }
    } catch {
      message.error(t('common.saveFailed'))
    } finally {
      setSavingKey(false)
    }
  }, [provider, refreshApiStatus, message, t])

  const handleOpenWindow = useCallback(async (engine: string) => {
    setLoading(true)
    try {
      const result = await window.electronAPI.searchWindow.open(engine)
      if (!result.success) {
        message.error(result.error || t('common.failed'))
      }
    } catch {
      message.error(t('common.failed'))
    } finally {
      setLoading(false)
    }
  }, [message, t])

  return (
    <div>
      <Title level={5}>{t('settings.internetSearchTitle')}</Title>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
        <SettingsItem
          title={t('settings.searchMode')}
          description={t('settings.searchModeDesc')}
          extra={
            <Segmented
              value={mode}
              onChange={handleModeChange}
              options={[
                { label: t('settings.searchModeBrowser'), value: 'browser' },
                { label: t('settings.searchModeApi'), value: 'api' },
              ]}
            />
          }
        />

        <Divider style={{ margin: '4px 0' }} />

        {mode === 'browser' ? (
          <>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <Text strong>{t('settings.defaultSearchEngine')}</Text>
              <Select
                value={defaultEngine}
                onChange={handleEngineChange}
                style={{ width: 200 }}
                options={engineOptions}
              />
            </div>

            <Divider style={{ margin: '4px 0' }} />
          </>
        ) : (
          <>
            <SettingsItem
              title={t('settings.searchApiProvider')}
              description={t(`settings.searchApiProviderDesc_${provider}`)}
              extra={
                <Select
                  value={provider}
                  onChange={handleProviderChange}
                  style={{ width: 200 }}
                  options={providerOptions}
                />
              }
            />

            <SettingsItem
              title={t('settings.searchApiKey')}
              description={t('settings.searchApiKeyDesc')}
              extra={
                <Tag color={hasKey ? 'success' : 'default'}>
                  {hasKey ? t('settings.searchApiKeyConfigured') : t('settings.searchApiKeyNotConfigured')}
                </Tag>
              }
            >
              <Space.Compact style={{ width: '100%' }}>
                <Input.Password
                  value={apiKeyInput}
                  onChange={(e) => setApiKeyInput(e.target.value)}
                  placeholder={t('settings.searchApiKeyPlaceholder', { provider: providerName })}
                />
                <Button type="primary" loading={savingKey} onClick={handleSaveKey}>
                  {t('common.save')}
                </Button>
                {hasKey && (
                  <Button danger loading={savingKey} onClick={handleClearKey}>
                    {t('settings.searchApiClearKey')}
                  </Button>
                )}
              </Space.Compact>
              <Text type="secondary" style={{ fontSize: 12 }}>
                {t('settings.searchApiKeyHint')}
              </Text>
            </SettingsItem>

            <Divider style={{ margin: '4px 0' }} />
          </>
        )}

        <div>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
            <Text strong>{t('settings.searchResultCount')}</Text>
            <Text type="secondary">{resultCount}</Text>
          </div>
          <Slider
            min={SEARCH_RESULT_COUNT_MIN}
            max={SEARCH_RESULT_COUNT_MAX}
            value={resultCount}
            onChange={(value) => setResultCount(value)}
            onChangeComplete={handleResultCountChange}
            marks={RESULT_COUNT_MARKS}
          />
        </div>

        {mode === 'browser' && (
          <>
            <Divider style={{ margin: '4px 0' }} />

            <div>
              <Text strong style={{ display: 'block', marginBottom: 12 }}>
                <GlobalOutlined style={{ marginRight: 6 }} />
                {t('settings.searchWindowManagement')}
              </Text>
              <Text type="secondary" style={{ display: 'block', marginBottom: 12, fontSize: 12 }}>
                {t('settings.searchWindowDesc')}
              </Text>
              <Space orientation="vertical" style={{ width: '100%' }}>
                {engines.map((engine) => (
                  <Card
                    key={engine.id}
                    size="small"
                    styles={{
                      body: {
                        padding: '10px 14px',
                        display: 'flex',
                        justifyContent: 'space-between',
                        alignItems: 'center',
                        background: token.colorBgContainer
                      }
                    }}
                  >
                    <div>
                      <Text strong>{engine.name}</Text>
                      <br />
                      <Text type="secondary" style={{ fontSize: 12 }}>{engine.homepage}</Text>
                    </div>
                    <Button
                      type="primary"
                      size="small"
                      icon={<ExportOutlined />}
                      loading={loading}
                      onClick={() => handleOpenWindow(engine.id)}
                    >
                      {t('settings.openSearchWindow')}
                    </Button>
                  </Card>
                ))}
              </Space>
            </div>
          </>
        )}
      </div>
    </div>
  )
}

export default React.memo(InternetSearchSettings)
