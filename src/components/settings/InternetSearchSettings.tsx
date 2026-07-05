import React, { useState, useEffect, useCallback, useMemo } from 'react'
import { Typography, Select, Slider, Button, Divider, Card, Space, App, theme } from 'antd'
import { GlobalOutlined, ExportOutlined } from '@ant-design/icons'
import { useTranslation } from 'react-i18next'

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

const InternetSearchSettings: React.FC = () => {
  const { t } = useTranslation()
  const { message } = App.useApp()
  const { token } = theme.useToken()

  const [engines, setEngines] = useState<EngineInfo[]>([])
  const [defaultEngine, setDefaultEngine] = useState<string>('google')
  const [resultCount, setResultCount] = useState<number>(5)
  const [loading, setLoading] = useState(false)

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
    } catch {
      // ignore load errors
    }
  }, [])

  useEffect(() => {
    loadSettings()
  }, [loadSettings])

  const engineOptions = useMemo(() => engines.map((e) => ({ label: e.name, value: e.id })), [engines])

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
      </div>
    </div>
  )
}

export default React.memo(InternetSearchSettings)
