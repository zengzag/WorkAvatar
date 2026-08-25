import React, { useCallback, useState, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { Empty, Spin } from 'antd'
import KMSSearchInput from './KMSSearchInput'
import KMSSearchResultList from './KMSSearchResultList'
import KnowledgeCardBanner from './KnowledgeCardBanner'
import KnowledgeCardDetail from './KnowledgeCardDetail'
import type { SearchFilters, SearchHistoryItem, SearchMode } from '../../hooks/useKMS'

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
  const [selectedCard, setSelectedCard] = useState<any>(null)
  const [cardDetailOpen, setCardDetailOpen] = useState(false)

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
    // 历史记录只还原文本，以用户当前选择的模式触发搜索
    onSearch(item.query.trim(), searchMode, buildFilters())
  }, [onSearchQueryChange, onSearch, searchMode, buildFilters])

  const handleSearchModeChange = useCallback((mode: SearchMode) => {
    onSearchModeChange(mode)
    // 切换模式后自动以新模式重新搜索
    if (searchQuery.trim() && !isSearching) {
      onSearch(searchQuery.trim(), mode, buildFilters())
    }
  }, [onSearchModeChange, searchQuery, isSearching, onSearch, buildFilters])

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <KMSSearchInput
        searchQuery={searchQuery}
        onSearchQueryChange={onSearchQueryChange}
        searchMode={searchMode}
        onSearchModeChange={handleSearchModeChange}
        isSearching={isSearching}
        onSearch={handleSearch}
        searchHistory={searchHistory}
        onLoadSearchHistory={onLoadSearchHistory}
        onDeleteSearchHistory={onDeleteSearchHistory}
        onClearSearchHistory={onClearSearchHistory}
        onPickHistory={handlePickHistory}
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
        {/* 知识卡片横幅：搜索词匹配到已有卡片时显示 */}
        {searchQuery.trim() && !isSearching && (
          <div style={{ marginBottom: 8 }}>
            <KnowledgeCardBanner
              query={searchQuery.trim()}
              onViewCard={(card) => {
                setSelectedCard(card)
                setCardDetailOpen(true)
              }}
            />
          </div>
        )}
        {isSearching ? (
          <div style={{ textAlign: 'center', padding: 60 }}>
            <Spin size="large" description={t('kms.searching')} />
          </div>
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

      {/* 知识卡片详情抽屉 */}
      <KnowledgeCardDetail
        card={selectedCard}
        open={cardDetailOpen}
        onClose={() => setCardDetailOpen(false)}
        onOpenFile={onOpenFile}
      />
    </div>
  )
}

export default KMSSearchPanel
