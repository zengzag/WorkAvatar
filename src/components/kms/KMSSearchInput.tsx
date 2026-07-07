import React, { useCallback, useRef, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { Input, Button, Space, Tooltip, Popover, Typography, Tag, List, Select, theme } from 'antd'
import { SearchOutlined, RobotOutlined, HistoryOutlined, DeleteOutlined, FileSearchOutlined } from '@ant-design/icons'
import type { SearchHistoryItem, SearchMode } from '../../hooks/useKMS'

const { Text } = Typography

const HISTORY_BLUR_DELAY_MS = 150

const formatHistoryTime = (timestamp: number, t: (key: string, options?: any) => string) => {
  const date = new Date(timestamp * 1000)
  const now = new Date()
  const diff = now.getTime() - date.getTime()
  const minutes = Math.floor(diff / 60000)
  const hours = Math.floor(diff / 3600000)
  const days = Math.floor(diff / 86400000)
  if (minutes < 1) return t('kms.historyJustNow')
  if (minutes < 60) return t('kms.historyMinutesAgo', { count: minutes })
  if (hours < 24) return t('kms.historyHoursAgo', { count: hours })
  if (days < 7) return t('kms.historyDaysAgo', { count: days })
  return date.toLocaleDateString()
}

interface KMSSearchInputProps {
  searchQuery: string
  onSearchQueryChange: (query: string) => void
  searchMode: SearchMode
  onSearchModeChange: (mode: SearchMode) => void
  isSearching: boolean
  onSearch: () => void
  searchHistory?: SearchHistoryItem[]
  onLoadSearchHistory?: (params?: { limit?: number }) => void
  onDeleteSearchHistory?: (id: string) => void
  onClearSearchHistory?: () => void
  onPickHistory: (item: SearchHistoryItem) => void
}

const KMSSearchInput: React.FC<KMSSearchInputProps> = ({
  searchQuery,
  onSearchQueryChange,
  searchMode,
  onSearchModeChange,
  isSearching,
  onSearch,
  searchHistory,
  onLoadSearchHistory,
  onDeleteSearchHistory,
  onClearSearchHistory,
  onPickHistory,
}) => {
  const { t } = useTranslation()
  const { token } = theme.useToken()
  const [historyOpen, setHistoryOpen] = React.useState(false)
  const historyBlurTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const hasOpenedHistoryRef = useRef(false)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    return () => {
      if (historyBlurTimerRef.current) {
        clearTimeout(historyBlurTimerRef.current)
        historyBlurTimerRef.current = null
      }
    }
  }, [])

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !isSearching) {
      onSearch()
    }
  }, [onSearch, isSearching])

  const handleInputFocus = useCallback(() => {
    // 输入框为空时，点击输入框显示历史记录
    if (!searchQuery.trim() && !hasOpenedHistoryRef.current) {
      setHistoryOpen(true)
      onLoadSearchHistory?.({ limit: 20 })
    }
  }, [searchQuery, onLoadSearchHistory])

  const handleInputBlur = useCallback(() => {
    if (historyBlurTimerRef.current) clearTimeout(historyBlurTimerRef.current)
    historyBlurTimerRef.current = setTimeout(() => {
      setHistoryOpen(false)
      hasOpenedHistoryRef.current = false
    }, HISTORY_BLUR_DELAY_MS)
  }, [])

  const handleQueryChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const value = e.target.value
    onSearchQueryChange(value)
    // 用户开始输入时自动隐藏历史记录
    if (value.trim()) {
      hasOpenedHistoryRef.current = true
      setHistoryOpen(false)
    } else {
      hasOpenedHistoryRef.current = false
    }
  }, [onSearchQueryChange])

  const handleDeleteHistory = useCallback((e: React.MouseEvent, id: string) => {
    e.stopPropagation()
    onDeleteSearchHistory?.(id)
  }, [onDeleteSearchHistory])

  const handleHistoryBtnMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    const newOpen = !historyOpen
    setHistoryOpen(newOpen)
    if (newOpen) onLoadSearchHistory?.({ limit: 20 })
  }, [onLoadSearchHistory, historyOpen])

  const renderHistoryContent = () => {
    if (!searchHistory || searchHistory.length === 0) {
      return (
        <div style={{ width: 380, padding: '12px 16px', textAlign: 'center' }}>
          <Text type="secondary" style={{ fontSize: 12 }}>{t('kms.noHistory')}</Text>
        </div>
      )
    }
    return (
      <div style={{ width: 380, maxHeight: 360, overflow: 'auto', padding: '4px 0' }}>
        <List
          size="small"
          split={false}
          dataSource={searchHistory}
          renderItem={(item) => (
            <List.Item
              style={{ padding: '6px 12px', cursor: 'pointer', border: 'none' }}
              onClick={() => onPickHistory(item)}
            >
              <div style={{ width: '100%', display: 'flex', alignItems: 'center', gap: 8 }}>
                <HistoryOutlined style={{ color: token.colorTextQuaternary, flexShrink: 0 }} />
                <Text ellipsis style={{ flex: 1, minWidth: 0, fontSize: 12 }}>{item.query}</Text>
                <Tag style={{ fontSize: 10, margin: 0, flexShrink: 0 }}>{item.result_count}{t('kms.historyResultsUnit')}</Tag>
                <Text type="secondary" style={{ fontSize: 10, flexShrink: 0 }}>{formatHistoryTime(item.created_at, t)}</Text>
                {onDeleteSearchHistory && (
                  <Tooltip title={t('common.delete')}>
                    <Button
                      type="text"
                      size="small"
                      danger
                      icon={<DeleteOutlined />}
                      onClick={(e) => handleDeleteHistory(e, item.id)}
                      style={{ flexShrink: 0 }}
                    />
                  </Tooltip>
                )}
              </div>
            </List.Item>
          )}
        />
        {onClearSearchHistory && (
          <div style={{ borderTop: `1px solid ${token.colorBorderSecondary}`, padding: '6px 12px', textAlign: 'right' }}>
            <Button type="link" size="small" danger icon={<DeleteOutlined />} onClick={onClearSearchHistory}>
              {t('kms.clearHistory')}
            </Button>
          </div>
        )}
      </div>
    )
  }

  const searchModeOptions = [
    { label: t('kms.hybridSearch'), value: 'hybrid' },
    { label: t('kms.keywordSearch'), value: 'keyword' },
    { label: t('kms.semanticSearch'), value: 'semantic' },
    { label: t('kms.fileSearch'), value: 'file' },
    { label: t('kms.aiSearch'), value: 'ai' },
  ]

  return (
    <div style={{ marginBottom: 12 }}>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        <Select
          value={searchMode}
          onChange={(v) => onSearchModeChange(v)}
          options={searchModeOptions}
          size="large"
          style={{ width: 140, flexShrink: 0 }}
          dropdownMatchSelectWidth={false}
        />
        <Popover
          content={renderHistoryContent()}
          trigger={[]}
          open={historyOpen}
          onOpenChange={setHistoryOpen}
          placement="bottomLeft"
          overlayInnerStyle={{ padding: 0 }}
          overlayStyle={{ paddingTop: 4 }}
        >
          <Input
            ref={inputRef as any}
            value={searchQuery}
            onChange={handleQueryChange}
            onKeyDown={handleKeyDown}
            onFocus={handleInputFocus}
            onBlur={handleInputBlur}
            placeholder={searchMode === 'file' ? t('kms.fileSearchPlaceholder') : t('kms.searchPlaceholder')}
            size="large"
            prefix={searchMode === 'ai' ? <RobotOutlined style={{ color: token.colorTextQuaternary }} /> : searchMode === 'file' ? <FileSearchOutlined style={{ color: token.colorTextQuaternary }} /> : <SearchOutlined style={{ color: token.colorTextQuaternary }} />}
            suffix={
              <Space size={4}>
                <Tooltip title={t('kms.searchHistory')}>
                  <Button
                    type="text"
                    size="small"
                    icon={<HistoryOutlined />}
                    onMouseDown={handleHistoryBtnMouseDown}
                  />
                </Tooltip>
                <Button
                  type="primary"
                  size="small"
                  icon={searchMode === 'ai' ? <RobotOutlined /> : <SearchOutlined />}
                  onClick={onSearch}
                  loading={isSearching}
                >
                  {t('kms.search')}
                </Button>
              </Space>
            }
          />
        </Popover>
      </div>
    </div>
  )
}

export default KMSSearchInput
