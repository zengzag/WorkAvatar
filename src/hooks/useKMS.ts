import { useState, useCallback, useEffect, useRef } from 'react'
import { useTranslation } from 'react-i18next'

interface IndexDir {
  id: string
  dir_path: string
  display_name: string
  enabled: number
  recursive: number
  file_extensions: string
  file_count?: number
  created_at: number
  updated_at: number
}

interface HighlightRange {
  start: number
  end: number
}

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
}

interface IndexProgress {
  phase: string
  current: number
  total: number
  message: string
  /** 当前处理的文件ID（文件级阶段时填充） */
  fileId?: string
  /** 当前处理的文件名 */
  fileName?: string
  /** 当前处理的合集ID（合集级阶段时填充） */
  collectionId?: string
  /** 当前处理的合集名称 */
  collectionName?: string
  /** 阶段开始时间（秒） */
  startedAt?: number
}

interface KMSStats {
  dirs: { total: number; enabled: number }
  files: { total: number; byStatus: Record<string, number>; byTier: Record<string, number>; byExt: Record<string, number> }
  index: { totalEntries: number; byType: Record<string, number>; embeddingCount: number; ftsEntryCount: number }
}

export interface AgentSearchSource {
  fileId: string
  fileName: string
  filePath: string
  paragraphId?: string
  paragraphTitle?: string
  snippet: string
  startLine?: number
  endLine?: number
  startOffset?: number
  endOffset?: number
  score?: number
}

export interface AgentSearchResult {
  queryType: 'locate' | 'concept' | 'trend' | 'analysis'
  queryTypeLabel: string
  conclusion: string
  sources: AgentSearchSource[]
  searchRounds: number
  searchTrace: string[]
  searchSteps?: SearchTraceStep[]
}

export interface SearchTraceStep {
  phase: string
  action: string
  detail?: string
  durationMs?: number
  type: 'info' | 'llm' | 'search' | 'read' | 'plan' | 'result'
}

export interface SearchFilters {
  dirIds?: string[]
  collectionIds?: string[]
  fileExtensions?: string[]
  timeRangeStart?: number
  timeRangeEnd?: number
}

/** KMS 模型设置 */
export interface KMSModelConfig {
  provider_id: string
  model_id: string
  enable_thinking?: boolean
}

/** KMS 自动索引配置 */
export interface KMSAutoIndexConfig {
  enabled: boolean
  intervalMinutes: number
  stableThresholdSeconds: number
}

/** KMS 自动索引状态 */
export interface KMSAutoIndexStatus {
  running: boolean
  config: KMSAutoIndexConfig
  lastRunAt: number | null
  nextRunAt: number | null
  lastResult: { newFiles: number; modifiedFiles: number; deletedFiles: number; skippedUnstableFiles: number } | null
}

/** KMS 设置（模型 + 检索参数 + 自动索引） */
export interface KMSSettings {
  model: KMSModelConfig | null
  embeddingModel: KMSModelConfig | null
  summaryModel: KMSModelConfig | null
  searchParams: {
    maxRounds?: number
    topK?: number
  }
  autoIndex: KMSAutoIndexConfig
}

/** 文件摘要项 */
export interface FileSummaryItem {
  id: string
  file_name: string
  file_path: string
  file_ext: string
  file_size: number
  data_tier: 'hot' | 'cold'
  index_status: string
  modified_time: number
  updated_at: number
  summary: string
  light_summary: string
  preview_text: string
  keywords_json: string
  main_topics_json: string
  dir_name?: string
  dir_path?: string
  has_embedding?: number
}

export interface FileSummariesResult {
  items: FileSummaryItem[]
  total: number
}

/** 搜索历史项（不再保存结果数据，仅用于搜索框下拉提示） */
export interface SearchHistoryItem {
  id: string
  query: string
  search_mode: string
  result_count: number
  created_at: number
}

export type SearchMode = 'keyword' | 'semantic' | 'hybrid' | 'ai' | 'file'

export function useKMS() {
  const { t } = useTranslation()
  const [dirs, setDirs] = useState<IndexDir[]>([])
  const [searchQuery, setSearchQuery] = useState('')
  const [searchMode, setSearchMode] = useState<SearchMode>('hybrid')
  const [searchResults, setSearchResults] = useState<SearchResult[]>([])
  const [agentResult, setAgentResult] = useState<AgentSearchResult | null>(null)
  const [liveSteps, setLiveSteps] = useState<SearchTraceStep[]>([])
  const [isSearching, setIsSearching] = useState(false)
  const [indexProgress, setIndexProgress] = useState<IndexProgress | null>(null)
  const [isIndexing, setIsIndexing] = useState(false)
  const [stats, setStats] = useState<KMSStats | null>(null)
  const [fileContent, setFileContent] = useState<{ fileId: string; content: string; fileName: string } | null>(null)
  const [fileSummary, setFileSummary] = useState<any>(null)
  const [previewFile, setPreviewFile] = useState<SearchResult | null>(null)
  const [kmsSettings, setKmsSettings] = useState<KMSSettings>({
    model: null,
    embeddingModel: null,
    summaryModel: null,
    searchParams: { maxRounds: 3, topK: 10 },
    autoIndex: { enabled: false, intervalMinutes: 10, stableThresholdSeconds: 300 },
  })
  const [autoIndexStatus, setAutoIndexStatus] = useState<KMSAutoIndexStatus | null>(null)
  const [fileSummaries, setFileSummaries] = useState<FileSummariesResult>({ items: [], total: 0 })
  const [isLoadingSummaries, setIsLoadingSummaries] = useState(false)
  const [searchHistory, setSearchHistory] = useState<SearchHistoryItem[]>([])
  const progressUnsubscribe = useRef<(() => void) | null>(null)
  // 用 ref 追踪最新设置，避免 search 回调因 kmsSettings 变化而频繁重建
  const kmsSettingsRef = useRef(kmsSettings)
  kmsSettingsRef.current = kmsSettings

  const loadDirs = useCallback(async () => {
    try {
      const result = await window.electronAPI.kms.listDirs()
      setDirs(result || [])
    } catch (err) {
      console.error('Failed to load KMS dirs:', err)
    }
  }, [])

  const loadStats = useCallback(async () => {
    try {
      const result = await window.electronAPI.kms.getStats()
      setStats(result)
    } catch (err) {
      console.error('Failed to load KMS stats:', err)
    }
  }, [])

  const addDir = useCallback(async (dirPath: string, displayName?: string, recursive?: boolean, fileExtensions?: string[]) => {
    try {
      await window.electronAPI.kms.addDir({ dirPath, displayName, recursive, fileExtensions })
      await loadDirs()
      await loadStats()
    } catch (err) {
      console.error('Failed to add KMS dir:', err)
      throw err
    }
  }, [loadDirs, loadStats])

  const updateDir = useCallback(async (id: string, updates: { displayName?: string; enabled?: boolean; recursive?: boolean; fileExtensions?: string[] }) => {
    try {
      await window.electronAPI.kms.updateDir({ id, ...updates })
      await loadDirs()
    } catch (err) {
      console.error('Failed to update KMS dir:', err)
    }
  }, [loadDirs])

  const deleteDir = useCallback(async (id: string) => {
    try {
      await window.electronAPI.kms.deleteDir(id)
      await loadDirs()
      await loadStats()
    } catch (err) {
      console.error('Failed to delete KMS dir:', err)
    }
  }, [loadDirs, loadStats])

  const search = useCallback(async (query: string, mode?: SearchMode, filters?: SearchFilters) => {
    if (!query.trim()) {
      setSearchResults([])
      setAgentResult(null)
      setLiveSteps([])
      return
    }
    setIsSearching(true)
    setLiveSteps([])

    let unsubscribe: (() => void) | null = null
    if (mode === 'ai') {
      unsubscribe = window.electronAPI.kms.onAgentSearchProgress((step: SearchTraceStep) => {
        setLiveSteps(prev => [...prev, step])
      })
    }

    try {
      if (mode === 'ai') {
        const aiTopK = kmsSettingsRef.current.searchParams?.topK || 10
        const result = await window.electronAPI.kms.agentSearch({
          query,
          topK: aiTopK,
          maxRounds: 3,
          dirIds: filters?.dirIds,
          collectionIds: filters?.collectionIds,
          fileExtensions: filters?.fileExtensions,
          timeRangeStart: filters?.timeRangeStart,
          timeRangeEnd: filters?.timeRangeEnd,
        })
        if (result && !result.error) {
          setAgentResult(result)
          setSearchResults([])
          window.electronAPI.kms.recordSearchHistory({
            query,
            searchMode: 'ai',
            resultCount: result.sources?.length || 0,
            filters,
          }).catch(() => {})
        } else {
          const errorMsg = result?.error || 'Unknown error'
          setAgentResult({
            queryType: 'locate',
            queryTypeLabel: t('kms.queryTypeLocate'),
            conclusion: `${t('kms.aiSearchFailed', { error: errorMsg })}${errorMsg.includes('LLM provider') ? `\n\n${t('kms.aiSearchLLMHint')}` : ''}`,
            sources: [],
            searchRounds: 0,
            searchTrace: [],
            searchSteps: [],
          })
          setSearchResults([])
        }
      } else if (mode === 'file') {
        const results = await window.electronAPI.kms.searchFiles({
          query,
          dirIds: filters?.dirIds,
          collectionIds: filters?.collectionIds,
          fileExtensions: filters?.fileExtensions,
          timeRangeStart: filters?.timeRangeStart,
          timeRangeEnd: filters?.timeRangeEnd,
        })
        setAgentResult(null)
        setSearchResults(results || [])
        window.electronAPI.kms.recordSearchHistory({
          query,
          searchMode: 'file',
          resultCount: results?.length || 0,
          filters,
        }).catch(() => {})
      } else {
        const useSemantic = mode === 'semantic' || mode === 'hybrid'
        // 手动搜索不限制返回数量，获取全部匹配结果
        const results = await window.electronAPI.kms.search({
          query,
          useSemantic,
          topK: 500,
          fileExtensions: filters?.fileExtensions,
          timeRangeStart: filters?.timeRangeStart,
          timeRangeEnd: filters?.timeRangeEnd,
          dirIds: filters?.dirIds,
          collectionIds: filters?.collectionIds,
        })
        setAgentResult(null)
        setSearchResults(results || [])
        window.electronAPI.kms.recordSearchHistory({
          query,
          searchMode: mode || 'keyword',
          resultCount: results?.length || 0,
          filters,
        }).catch(() => {})
      }
    } catch (err) {
      console.error('KMS search failed:', err)
      setSearchResults([])
      setAgentResult(null)
    } finally {
      if (unsubscribe) unsubscribe()
      setIsSearching(false)
    }
  }, [])

  const getFileContent = useCallback(async (fileId: string, options?: { paragraphId?: string; startOffset?: number; endOffset?: number; startLine?: number; maxChars?: number }) => {
    try {
      const content = await window.electronAPI.kms.getFileContent({ fileId, ...options })
      setFileContent({ fileId, content, fileName: '' })
      return content
    } catch (err) {
      console.error('Failed to get file content:', err)
      return ''
    }
  }, [])

  const getFileFullContent = useCallback(async (fileId: string) => {
    try {
      return await window.electronAPI.kms.getFileFullContent(fileId)
    } catch (err) {
      console.error('Failed to get file full content:', err)
      return ''
    }
  }, [])

  const getFileSummary = useCallback(async (fileId: string) => {
    try {
      const summary = await window.electronAPI.kms.getFileSummary(fileId)
      setFileSummary(summary)
      return summary
    } catch (err) {
      console.error('Failed to get file summary:', err)
      return null
    }
  }, [])

  const openFile = useCallback(async (filePath: string) => {
    try {
      await window.electronAPI.kms.openFile(filePath)
    } catch (err) {
      console.error('Failed to open file:', err)
    }
  }, [])

  const openFileDir = useCallback(async (filePath: string) => {
    try {
      await window.electronAPI.kms.openFileDir(filePath)
    } catch (err) {
      console.error('Failed to open file directory:', err)
    }
  }, [])

  const buildIndex = useCallback(async (providerId?: string, withEmbedding: boolean = true) => {
    setIsIndexing(true)
    setIndexProgress({ phase: 'crawling', current: 0, total: 0, message: '' })
    await window.electronAPI.kms.buildIndex(providerId, withEmbedding)
  }, [])

  const incrementalIndex = useCallback(async (providerId?: string, withEmbedding: boolean = true) => {
    setIsIndexing(true)
    setIndexProgress({ phase: 'crawling', current: 0, total: 0, message: '' })
    await window.electronAPI.kms.incrementalIndex(providerId, withEmbedding)
  }, [])

  const rebuildDirIndex = useCallback(async (dirId: string, providerId?: string, withEmbedding: boolean = true) => {
    setIsIndexing(true)
    setIndexProgress({ phase: 'crawling', current: 0, total: 0, message: '' })
    await window.electronAPI.kms.rebuildDirIndex(dirId, providerId, withEmbedding)
  }, [])

  const cancelIndex = useCallback(async () => {
    await window.electronAPI.kms.cancelIndex()
  }, [])

  const loadKmsSettings = useCallback(async () => {
    try {
      const result = await window.electronAPI.kms.getSettings()
      if (result && !result.error) {
        setKmsSettings({
          model: result.model || null,
          embeddingModel: result.embeddingModel || null,
          summaryModel: result.summaryModel || null,
          searchParams: {
            maxRounds: result.searchParams?.maxRounds ?? 3,
            topK: result.searchParams?.topK ?? 10,
          },
          autoIndex: {
            enabled: result.autoIndex?.enabled ?? false,
            intervalMinutes: result.autoIndex?.intervalMinutes ?? 10,
            stableThresholdSeconds: result.autoIndex?.stableThresholdSeconds ?? 300,
          },
        })
      }
    } catch (err) {
      console.error('Failed to load KMS settings:', err)
    }
  }, [])

  const saveKmsSettings = useCallback(async (params: {
    model?: KMSModelConfig | null
    embeddingModel?: KMSModelConfig | null
    summaryModel?: KMSModelConfig | null
    searchParams?: { maxRounds?: number; topK?: number }
    autoIndex?: KMSAutoIndexConfig
  }) => {
    try {
      const result = await window.electronAPI.kms.setSettings(params)
      if (result?.error) {
        console.error('Failed to save KMS settings:', result.error)
        return false
      }
      await loadKmsSettings()
      return true
    } catch (err) {
      console.error('Failed to save KMS settings:', err)
      return false
    }
  }, [loadKmsSettings])

  const loadAutoIndexStatus = useCallback(async () => {
    try {
      const result = await window.electronAPI.kms.getAutoIndexStatus()
      setAutoIndexStatus(result)
    } catch (err) {
      console.error('Failed to load auto-index status:', err)
    }
  }, [])

  const runAutoIndexCheckNow = useCallback(async () => {
    try {
      await window.electronAPI.kms.runAutoIndexCheck()
    } catch (err) {
      console.error('Failed to trigger auto-index check:', err)
    }
  }, [])

  const loadFileSummaries = useCallback(async (params?: {
    dirId?: string
    dataTier?: 'cold' | 'hot'
    keyword?: string
    page?: number
    pageSize?: number
  }) => {
    setIsLoadingSummaries(true)
    try {
      const result = await window.electronAPI.kms.getFileSummaries(params || {})
      if (result && !result.error) {
        setFileSummaries({
          items: result.items || [],
          total: result.total || 0,
        })
      }
    } catch (err) {
      console.error('Failed to load file summaries:', err)
    } finally {
      setIsLoadingSummaries(false)
    }
  }, [])

  const loadSearchHistory = useCallback(async (params?: { limit?: number; searchMode?: string }) => {
    try {
      const result = await window.electronAPI.kms.getSearchHistory(params)
      setSearchHistory(result || [])
      return result || []
    } catch (err) {
      console.error('Failed to load search history:', err)
      return []
    }
  }, [])

  const clearSearchHistory = useCallback(async (searchMode?: string) => {
    try {
      await window.electronAPI.kms.clearSearchHistory(searchMode)
      await loadSearchHistory()
    } catch (err) {
      console.error('Failed to clear search history:', err)
    }
  }, [loadSearchHistory])

  const deleteSearchHistory = useCallback(async (id: string) => {
    try {
      await window.electronAPI.kms.deleteSearchHistory(id)
      await loadSearchHistory()
    } catch (err) {
      console.error('Failed to delete search history:', err)
    }
  }, [loadSearchHistory])

  useEffect(() => {
    if (progressUnsubscribe.current) {
      progressUnsubscribe.current()
    }
    progressUnsubscribe.current = window.electronAPI.kms.onIndexProgress((progress: IndexProgress) => {
      setIndexProgress(progress)
      if (progress.phase === 'done' || progress.phase === 'error') {
        setIsIndexing(false)
        setTimeout(() => setIndexProgress(null), 3000)
        loadDirs()
        loadStats()
        loadAutoIndexStatus()
      }
    })
    return () => {
      if (progressUnsubscribe.current) {
        progressUnsubscribe.current()
      }
    }
  }, [loadDirs, loadStats, loadAutoIndexStatus])

  useEffect(() => {
    loadDirs()
    loadStats()
    loadKmsSettings()
    loadAutoIndexStatus()
  }, [loadDirs, loadStats, loadKmsSettings, loadAutoIndexStatus])

  return {
    dirs,
    searchQuery,
    setSearchQuery,
    searchMode,
    setSearchMode,
    searchResults,
    agentResult,
    liveSteps,
    isSearching,
    indexProgress,
    isIndexing,
    stats,
    fileContent,
    fileSummary,
    previewFile,
    kmsSettings,
    autoIndexStatus,
    fileSummaries,
    isLoadingSummaries,
    searchHistory,
    setFileContent: (v: { fileId: string; content: string; fileName: string } | null) => setFileContent(v),
    setFileSummary: (v: any) => setFileSummary(v),
    setPreviewFile: (v: SearchResult | null) => setPreviewFile(v),
    loadDirs,
    loadStats,
    addDir,
    updateDir,
    deleteDir,
    search,
    getFileContent,
    getFileFullContent,
    getFileSummary,
    openFile,
    openFileDir,
    buildIndex,
    incrementalIndex,
    rebuildDirIndex,
    cancelIndex,
    loadKmsSettings,
    saveKmsSettings,
    loadAutoIndexStatus,
    runAutoIndexCheckNow,
    loadFileSummaries,
    loadSearchHistory,
    clearSearchHistory,
    deleteSearchHistory,
  }
}
