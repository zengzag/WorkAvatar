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

export interface SearchFilters {
  dirIds?: string[]
  fileExtensions?: string[]
  timeRangeStart?: number
  timeRangeEnd?: number
}

export function useKMS() {
  const [dirs, setDirs] = useState<IndexDir[]>([])
  const [searchQuery, setSearchQuery] = useState('')
  const [searchMode, setSearchMode] = useState<'keyword' | 'semantic' | 'hybrid'>('keyword')
  const [searchResults, setSearchResults] = useState<SearchResult[]>([])
  const [isSearching, setIsSearching] = useState(false)
  const [indexProgress, setIndexProgress] = useState<IndexProgress | null>(null)
  const [isIndexing, setIsIndexing] = useState(false)
  const [stats, setStats] = useState<KMSStats | null>(null)
  const [fileContent, setFileContent] = useState<{ fileId: string; content: string; fileName: string } | null>(null)
  const [fileSummary, setFileSummary] = useState<any>(null)
  const [previewFile, setPreviewFile] = useState<SearchResult | null>(null)
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
  const search = useCallback(async (query: string, mode?: 'keyword' | 'semantic' | 'hybrid', filters?: SearchFilters) => {
    if (!query.trim()) {
      setSearchResults([])
      return
    }
    setIsSearching(true)
    try {
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
      setSearchResults(results || [])
    } catch (err) {
      console.error('KMS search failed:', err)
      setSearchResults([])
    } finally {
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
  }, [loadDirs, loadStats])

  return {
    dirs,
    searchQuery,
    setSearchQuery,
    searchMode,
    setSearchMode,
    searchResults,
    isSearching,
    indexProgress,
    isIndexing,
    stats,
    fileContent,
    fileSummary,
    previewFile,
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
  }
}
