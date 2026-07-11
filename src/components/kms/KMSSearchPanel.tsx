import React, { useCallback, useMemo, useState, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { Empty, Spin, Typography, theme } from 'antd'
import KMSSearchInput from './KMSSearchInput'
import KMSFilterPanel from './KMSFilterPanel'
import KMSSearchResultList from './KMSSearchResultList'
import KMSAgentResult from './KMSAgentResult'
import type { SearchFilters, AgentSearchResult, SearchTraceStep, SearchHistoryItem, SearchMode } from '../../hooks/useKMS'

const { Text } = Typography

interface HighlightRange { start: number; end: number }

interface SearchResult {
  file_id: string
  file_name: string
  file_path: string
  paragraph_id?: string
  paragraph_title?: string
  text: string
  match_type: string
  start_offset?: number
  end_offset?: number
  start_line?: number
  end_line?: number
  score?: number
  highlights?: HighlightRange[]
  matched_keywords?: string[]
  /** 文件最后修改时间（unix 秒） */
  modified_time?: number
}

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

interface KMSSearchPanelProps {
  searchQuery: string
  onSearchQueryChange: (query: string) => void
  searchMode: SearchMode
  onSearchModeChange: (mode: SearchMode) => void
  searchResults: SearchResult[]
  agentResult: AgentSearchResult | null
  liveSteps: SearchTraceStep[]
  isSearching: boolean
  onSearch: (query: string, mode?: SearchMode, filters?: SearchFilters) => void
  dirs: IndexDir[]
  onOpenFile: (filePath: string) => void
  onOpenFileDir: (filePath: string) => void
  onPreview: (result: SearchResult) => void
  filterCollectionIds?: string[]
  onFilterCollectionIdsChange?: (ids: string[]) => void
  searchHistory?: SearchHistoryItem[]
  onLoadSearchHistory?: (params?: { limit?: number }) => void
  onDeleteSearchHistory?: (id: string) => void
  onClearSearchHistory?: () => void
}

const KMSSearchPanel: React.FC<KMSSearchPanelProps> = ({
  searchQuery,
  onSearchQueryChange,
  searchMode,
  onSearchModeChange,
  searchResults,
  agentResult,
  liveSteps,
  isSearching,
  onSearch,
  dirs,
  onOpenFile,
  onOpenFileDir,
  onPreview,
  filterCollectionIds: controlledCollectionIds,
  onFilterCollectionIdsChange,
  searchHistory,
  onLoadSearchHistory,
  onDeleteSearchHistory,
  onClearSearchHistory,
}) => {
  const { t } = useTranslation()
  const { token } = theme.useToken()

  const [filterDirIds, setFilterDirIds] = useState<string[]>([])
  const [internalCollectionIds, setInternalCollectionIds] = useState<string[]>([])
  const filterCollectionIds = controlledCollectionIds ?? internalCollectionIds
  const setFilterCollectionIds = useCallback((ids: string[]) => {
    if (onFilterCollectionIdsChange) {
      onFilterCollectionIdsChange(ids)
    } else {
      setInternalCollectionIds(ids)
    }
  }, [onFilterCollectionIdsChange])
  const [filterExtensions, setFilterExtensions] = useState<string[]>([])
  const [filterTimeRange, setFilterTimeRange] = useState<[number, number] | null>(null)
  const [collectionOptions, setCollectionOptions] = useState<{ label: string; value: string }[]>([])

  useEffect(() => {
    let cancelled = false
    window.electronAPI.kms.listCollections().then((result: any[]) => {
      if (cancelled) return
      // safeHandle 错误时返回 { error }（truthy），需 Array.isArray 兜底，否则后续 .map 会抛错
      const list = Array.isArray(result) ? result : []
      setCollectionOptions(list.map((c: any) => ({ label: c.name, value: c.id })))
    }).catch(() => {})
    return () => { cancelled = true }
  }, [])

  const buildFilters = useCallback((): SearchFilters => {
    const filters: SearchFilters = {}
    if (filterDirIds.length > 0) filters.dirIds = filterDirIds
    if (filterCollectionIds.length > 0) filters.collectionIds = filterCollectionIds
    if (filterExtensions.length > 0) filters.fileExtensions = filterExtensions
    if (filterTimeRange) {
      filters.timeRangeStart = filterTimeRange[0]
      filters.timeRangeEnd = filterTimeRange[1]
    }
    return filters
  }, [filterDirIds, filterCollectionIds, filterExtensions, filterTimeRange])

  const handleSearch = useCallback(() => {
    if (searchQuery.trim()) {
      onSearch(searchQuery.trim(), searchMode, buildFilters())
    }
  }, [searchQuery, searchMode, onSearch, buildFilters])

  const handlePickHistory = useCallback((item: SearchHistoryItem) => {
    onSearchQueryChange(item.query)
    // 直接用选中的 query 触发搜索（避免 state 异步更新导致读到旧值）
    if (item.search_mode) {
      onSearchModeChange(item.search_mode as SearchMode)
    }
    onSearch(item.query.trim(), (item.search_mode || searchMode) as SearchMode, buildFilters())
  }, [onSearchQueryChange, onSearchModeChange, onSearch, searchMode, buildFilters])

  const searchKeywords = useMemo(() => {
    if (!searchQuery.trim()) return []
    return searchQuery.trim().split(/\s+/).filter(kw => kw.length > 0)
  }, [searchQuery])

  const stepTypeColors = useMemo<Record<string, string>>(() => ({
    info: token.colorTextTertiary,
    llm: token.colorInfo,
    search: token.colorPrimary,
    read: token.colorWarning,
    plan: token.colorSuccess,
    result: token.colorError,
  }), [token])

  const typeIcons = useMemo<Record<string, string>>(() => ({
    info: '•', llm: '🤖', search: '🔍', read: '📄', plan: '📋', result: '✓',
  }), [])

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <KMSSearchInput
        searchQuery={searchQuery}
        onSearchQueryChange={onSearchQueryChange}
        searchMode={searchMode}
        onSearchModeChange={onSearchModeChange}
        isSearching={isSearching}
        onSearch={handleSearch}
        searchHistory={searchHistory}
        onLoadSearchHistory={onLoadSearchHistory}
        onDeleteSearchHistory={onDeleteSearchHistory}
        onClearSearchHistory={onClearSearchHistory}
        onPickHistory={handlePickHistory}
      />

      <KMSFilterPanel
        searchMode={searchMode}
        filterDirIds={filterDirIds}
        onFilterDirIdsChange={setFilterDirIds}
        filterCollectionIds={filterCollectionIds}
        onFilterCollectionIdsChange={setFilterCollectionIds}
        filterExtensions={filterExtensions}
        onFilterExtensionsChange={setFilterExtensions}
        filterTimeRange={filterTimeRange}
        onFilterTimeRangeChange={setFilterTimeRange}
        dirs={dirs}
        collectionOptions={collectionOptions}
      />

      <div style={{ flex: 1, overflow: 'auto', minHeight: 0 }}>
        {isSearching ? (
          searchMode === 'ai' && liveSteps.length > 0 ? (
            <div style={{ padding: '12px 4px' }}>
              <div style={{ marginBottom: 12, display: 'flex', alignItems: 'center', gap: 8 }}>
                <Spin size="small" />
                <Text type="secondary" style={{ fontSize: 12 }}>{t('kms.aiSearching')}</Text>
              </div>
              {liveSteps.map((step, i) => (
                <div key={`live-${step.phase}-${i}`} style={{
                  display: 'flex', alignItems: 'flex-start', gap: 8, padding: '4px 0',
                  fontSize: 12, lineHeight: 1.6, color: token.colorTextSecondary,
                  borderBottom: `1px solid ${token.colorBorderSecondary}`,
                }}>
                  <span style={{ color: stepTypeColors[step.type] || token.colorTextTertiary, flexShrink: 0 }}>
                    {typeIcons[step.type] || '•'}
                  </span>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div>
                      <Text style={{ fontSize: 12, fontWeight: 500 }}>{step.action}</Text>
                      {step.durationMs !== undefined && (
                        <Text type="secondary" style={{ fontSize: 11, marginLeft: 8 }}>{step.durationMs}ms</Text>
                      )}
                    </div>
                    {step.detail && (
                      <Text type="secondary" style={{ fontSize: 11, wordBreak: 'break-all' }}>{step.detail}</Text>
                    )}
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <div style={{ textAlign: 'center', padding: 60 }}>
              <Spin size="large" description={searchMode === 'ai' ? t('kms.aiSearching') : t('kms.searching')} />
            </div>
          )
        ) : searchMode === 'ai' ? (
          agentResult ? (
            <KMSAgentResult
              agentResult={agentResult}
              searchKeywords={searchKeywords}
              stepTypeColors={stepTypeColors}
              onPreview={onPreview}
              onOpenFile={onOpenFile}
              onOpenFileDir={onOpenFileDir}
            />
          ) : (
            <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t('kms.noAiResult')} />
          )
        ) : searchResults.length === 0 ? (
          <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t('kms.noResults')} />
        ) : (
          <KMSSearchResultList
            results={searchResults}
            searchMode={searchMode}
            searchQuery={searchQuery}
            onPreview={onPreview}
            onOpenFile={onOpenFile}
            onOpenFileDir={onOpenFileDir}
          />
        )}
      </div>
    </div>
  )
}

export default KMSSearchPanel
