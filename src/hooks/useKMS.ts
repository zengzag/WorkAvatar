import { useState, useCallback, useEffect, useRef } from 'react'

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
  fileExtensions?: string[]
  timeRangeStart?: number
  timeRangeEnd?: number
}

/** KMS 模型设置 */
export interface KMSModelConfig {
  provider_id: string
  model_id: string
}

/** KMS 设置（模型 + 检索参数） */
export interface KMSSettings {
  model: KMSModelConfig | null
  embeddingModel: KMSModelConfig | null
  searchParams: {
    maxRounds?: number
    topK?: number
  }
}

/** 目录摘要 */
export interface DirSummary {
  dir_id: string
  dir_path: string
  display_name?: string
  enabled?: number
  summary: string
  file_count: number
  keywords_json: string
  updated_at: number
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
}

export interface FileSummariesResult {
  items: FileSummaryItem[]
  total: number
}

export function useKMS() {
  const [dirs, setDirs] = useState<IndexDir[]>([])
  const [searchQuery, setSearchQuery] = useState('')
  const [searchMode, setSearchMode] = useState<'keyword' | 'semantic' | 'hybrid' | 'ai'>('keyword')
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
  // KMS 设置
  const [kmsSettings, setKmsSettings] = useState<KMSSettings>({
    model: null,
    embeddingModel: null,
    searchParams: { maxRounds: 3, topK: 10 },
  })
  // 知识沉淀
  const [dirSummaries, setDirSummaries] = useState<DirSummary[]>([])
  const [fileSummaries, setFileSummaries] = useState<FileSummariesResult>({ items: [], total: 0 })
  const [isLoadingSummaries, setIsLoadingSummaries] = useState(false)
  const progressUnsubscribe = useRef<(() => void) | null>(null)

  // 加载目录列表
  const loadDirs = useCallback(async () => {
    try {
      const result = await window.electronAPI.kms.listDirs()
      setDirs(result || [])
    } catch (err) {
      console.error('Failed to load KMS dirs:', err)
    }
  }, [])

  // 加载统计
  const loadStats = useCallback(async () => {
    try {
      const result = await window.electronAPI.kms.getStats()
      setStats(result)
    } catch (err) {
      console.error('Failed to load KMS stats:', err)
    }
  }, [])

  // 添加目录
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

  // 更新目录
  const updateDir = useCallback(async (id: string, updates: { displayName?: string; enabled?: boolean; recursive?: boolean; fileExtensions?: string[] }) => {
    try {
      await window.electronAPI.kms.updateDir({ id, ...updates })
      await loadDirs()
    } catch (err) {
      console.error('Failed to update KMS dir:', err)
    }
  }, [loadDirs])

  // 删除目录
  const deleteDir = useCallback(async (id: string) => {
    try {
      await window.electronAPI.kms.deleteDir(id)
      await loadDirs()
      await loadStats()
    } catch (err) {
      console.error('Failed to delete KMS dir:', err)
    }
  }, [loadDirs, loadStats])

  // 搜索
  const search = useCallback(async (query: string, mode?: 'keyword' | 'semantic' | 'hybrid' | 'ai', filters?: SearchFilters) => {
    if (!query.trim()) {
      setSearchResults([])
      setAgentResult(null)
      setLiveSteps([])
      return
    }
    setIsSearching(true)
    setLiveSteps([])

    // 订阅 AI 检索实时进度
    let unsubscribe: (() => void) | null = null
    if (mode === 'ai') {
      unsubscribe = window.electronAPI.kms.onAgentSearchProgress((step: SearchTraceStep) => {
        setLiveSteps(prev => [...prev, step])
      })
    }

    try {
      if (mode === 'ai') {
        // AI 智能检索：通过子智能体自主规划+提纯
        const result = await window.electronAPI.kms.agentSearch({
          query,
          topK: 10,
          maxRounds: 3,
          dirIds: filters?.dirIds,
          fileExtensions: filters?.fileExtensions,
          timeRangeStart: filters?.timeRangeStart,
          timeRangeEnd: filters?.timeRangeEnd,
        })
        if (result && !result.error) {
          setAgentResult(result)
          setSearchResults([])
        } else {
          // 显示错误信息作为结论
          const errorMsg = result?.error || 'Unknown error'
          setAgentResult({
            queryType: 'locate',
            queryTypeLabel: '定位查找',
            conclusion: `AI 检索失败：${errorMsg}${errorMsg.includes('LLM provider') ? '\n\n请在设置中配置 LLM 提供商后再使用 AI 搜索。' : ''}`,
            sources: [],
            searchRounds: 0,
            searchTrace: [],
            searchSteps: [],
          })
          setSearchResults([])
        }
      } else {
        const useSemantic = mode === 'semantic' || mode === 'hybrid'
        const results = await window.electronAPI.kms.search({
          query,
          useSemantic,
          topK: 20,
          fileExtensions: filters?.fileExtensions,
          timeRangeStart: filters?.timeRangeStart,
          timeRangeEnd: filters?.timeRangeEnd,
          dirIds: filters?.dirIds,
        })
        setAgentResult(null)
        setSearchResults(results || [])
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

  // 获取文件内容
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

  // 获取文件完整内容
  const getFileFullContent = useCallback(async (fileId: string) => {
    try {
      return await window.electronAPI.kms.getFileFullContent(fileId)
    } catch (err) {
      console.error('Failed to get file full content:', err)
      return ''
    }
  }, [])

  // 获取文件摘要
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

  // 打开文件（系统默认应用）
  const openFile = useCallback(async (filePath: string) => {
    try {
      await window.electronAPI.kms.openFile(filePath)
    } catch (err) {
      console.error('Failed to open file:', err)
    }
  }, [])

  // 打开文件所在目录
  const openFileDir = useCallback(async (filePath: string) => {
    try {
      await window.electronAPI.kms.openFileDir(filePath)
    } catch (err) {
      console.error('Failed to open file directory:', err)
    }
  }, [])

  // 构建索引（fire-and-forget，通过进度事件更新状态）
  const buildIndex = useCallback(async (providerId?: string) => {
    setIsIndexing(true)
    setIndexProgress({ phase: 'crawling', current: 0, total: 0, message: '' })
    await window.electronAPI.kms.buildIndex(providerId)
  }, [])

  // 增量索引
  const incrementalIndex = useCallback(async (providerId?: string) => {
    setIsIndexing(true)
    setIndexProgress({ phase: 'crawling', current: 0, total: 0, message: '' })
    await window.electronAPI.kms.incrementalIndex(providerId)
  }, [])

  // 重建目录索引
  const rebuildDirIndex = useCallback(async (dirId: string, providerId?: string) => {
    setIsIndexing(true)
    setIndexProgress({ phase: 'crawling', current: 0, total: 0, message: '' })
    await window.electronAPI.kms.rebuildDirIndex(dirId, providerId)
  }, [])

  // 取消索引
  const cancelIndex = useCallback(async () => {
    await window.electronAPI.kms.cancelIndex()
  }, [])

  // ==================== KMS 设置 ====================

  // 加载 KMS 设置
  const loadKmsSettings = useCallback(async () => {
    try {
      const result = await window.electronAPI.kms.getSettings()
      if (result && !result.error) {
        setKmsSettings({
          model: result.model || null,
          embeddingModel: result.embeddingModel || null,
          searchParams: {
            maxRounds: result.searchParams?.maxRounds ?? 3,
            topK: result.searchParams?.topK ?? 10,
          },
        })
      }
    } catch (err) {
      console.error('Failed to load KMS settings:', err)
    }
  }, [])

  // 保存 KMS 设置
  const saveKmsSettings = useCallback(async (params: {
    model?: KMSModelConfig | null
    embeddingModel?: KMSModelConfig | null
    searchParams?: { maxRounds?: number; topK?: number }
  }) => {
    try {
      await window.electronAPI.kms.setSettings(params)
      // 重新加载设置
      await loadKmsSettings()
      return true
    } catch (err) {
      console.error('Failed to save KMS settings:', err)
      return false
    }
  }, [loadKmsSettings])

  // ==================== 知识沉淀（摘要查看） ====================

  // 加载目录摘要
  const loadDirSummaries = useCallback(async () => {
    try {
      const result = await window.electronAPI.kms.getDirSummaries()
      setDirSummaries(result || [])
    } catch (err) {
      console.error('Failed to load dir summaries:', err)
    }
  }, [])

  // 加载文件摘要列表
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

  // 监听索引进度
  useEffect(() => {
    if (progressUnsubscribe.current) {
      progressUnsubscribe.current()
    }
    progressUnsubscribe.current = window.electronAPI.kms.onIndexProgress((progress: IndexProgress) => {
      setIndexProgress(progress)
      if (progress.phase === 'done' || progress.phase === 'error') {
        setIsIndexing(false)
        setTimeout(() => setIndexProgress(null), 3000)
        loadStats()
      }
    })
    return () => {
      if (progressUnsubscribe.current) {
        progressUnsubscribe.current()
      }
    }
  }, [loadStats])

  // 初始加载
  useEffect(() => {
    loadDirs()
    loadStats()
    loadKmsSettings()
  }, [loadDirs, loadStats, loadKmsSettings])

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
    // KMS 设置
    kmsSettings,
    // 知识沉淀
    dirSummaries,
    fileSummaries,
    isLoadingSummaries,
    setFileContent: (v: null) => setFileContent(v),
    setFileSummary: (v: null) => setFileSummary(v),
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
    // KMS 设置
    loadKmsSettings,
    saveKmsSettings,
    // 知识沉淀
    loadDirSummaries,
    loadFileSummaries,
  }
}
