import React, { useCallback, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Drawer, Button, Segmented } from 'antd'
import { SettingOutlined, SearchOutlined, DatabaseOutlined, FolderOutlined } from '@ant-design/icons'
import { KMSSearchPanel, KMSFilePreview, KMSSettingsPanel, KMSKnowledgeView, KMSCollectionsView } from '../components/kms'
import { useKMS } from '../hooks/useKMS'

type ViewMode = 'search' | 'knowledge' | 'collections'

const KMSPage: React.FC = () => {
  const { t } = useTranslation()

  const {
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
    // KMS 设置
    kmsSettings,
    saveKmsSettings,
    // 自动索引
    autoIndexStatus,
    runAutoIndexCheckNow,
    // 知识沉淀
    dirSummaries,
    fileSummaries,
    isLoadingSummaries,
    loadDirSummaries,
    loadFileSummaries,
    // 搜索历史（嵌入搜索框下拉）
    searchHistory,
    loadSearchHistory,
    clearSearchHistory,
    deleteSearchHistory,
    addDir,
    updateDir,
    deleteDir,
    search,
    buildIndex,
    incrementalIndex,
    cancelIndex,
    openFile,
    openFileDir,
    previewFile,
    setPreviewFile,
  } = useKMS()

  const [settingsOpen, setSettingsOpen] = useState(false)
  const [viewMode, setViewMode] = useState<ViewMode>('search')
  // 跨视图联动：合集页"在此合集中搜索"使用
  const [filterCollectionIds, setFilterCollectionIds] = useState<string[]>([])

  const handlePreview = useCallback((result: any) => {
    setPreviewFile(result)
  }, [setPreviewFile])

  const handleClosePreview = useCallback(() => {
    setPreviewFile(null)
  }, [setPreviewFile])

  // 从合集视图跳转过来：设置合集筛选 + 切到搜索视图 + 触发一次空查询清空旧结果
  const handleSearchInCollection = useCallback((collectionId: string) => {
    setFilterCollectionIds([collectionId])
    setViewMode('search')
  }, [])

  // 收集当前搜索结果中的所有关键词用于预览高亮
  const previewKeywords = useMemo(() => {
    if (!previewFile) return []
    const kws = new Set<string>()
    if (previewFile.matched_keywords) {
      previewFile.matched_keywords.forEach((kw: string) => kws.add(kw))
    }
    // 同时把搜索词分词后加入
    if (searchQuery.trim()) {
      searchQuery.trim().split(/\s+/).forEach((kw) => {
        if (kw) kws.add(kw)
      })
    }
    return Array.from(kws)
  }, [previewFile, searchQuery])

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column', padding: 16 }}>
      {/* 顶部工具栏：视图切换 + 设置 */}
      <div style={{
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center',
        marginBottom: 12,
        flexShrink: 0,
      }}>
        <Segmented
          value={viewMode}
          onChange={(v) => setViewMode(v as ViewMode)}
          options={[
            {
              label: (
                <span>
                  <SearchOutlined style={{ marginRight: 4 }} />
                  {t('kms.searchView')}
                </span>
              ),
              value: 'search',
            },
            {
              label: (
                <span>
                  <FolderOutlined style={{ marginRight: 4 }} />
                  {t('kms.collectionsView')}
                </span>
              ),
              value: 'collections',
            },
            {
              label: (
                <span>
                  <DatabaseOutlined style={{ marginRight: 4 }} />
                  {t('kms.knowledgeView')}
                </span>
              ),
              value: 'knowledge',
            },
          ]}
        />
        <Button
          type="text"
          icon={<SettingOutlined />}
          onClick={() => setSettingsOpen(true)}
        >
          {t('kms.settings')}
        </Button>
      </div>

      {/* 主体内容区 */}
      <div style={{ flex: 1, minHeight: 0 }}>
        {viewMode === 'search' ? (
          <KMSSearchPanel
            searchQuery={searchQuery}
            onSearchQueryChange={setSearchQuery}
            searchMode={searchMode}
            onSearchModeChange={setSearchMode}
            searchResults={searchResults}
            agentResult={agentResult}
            liveSteps={liveSteps}
            isSearching={isSearching}
            onSearch={search}
            dirs={dirs}
            onOpenFile={openFile}
            onOpenFileDir={openFileDir}
            onPreview={handlePreview}
            filterCollectionIds={filterCollectionIds}
            onFilterCollectionIdsChange={setFilterCollectionIds}
            searchHistory={searchHistory}
            onLoadSearchHistory={loadSearchHistory}
            onDeleteSearchHistory={deleteSearchHistory}
            onClearSearchHistory={clearSearchHistory}
          />
        ) : viewMode === 'knowledge' ? (
          <KMSKnowledgeView
            dirs={dirs}
            dirSummaries={dirSummaries}
            fileSummaries={fileSummaries}
            isLoadingSummaries={isLoadingSummaries}
            onLoadDirSummaries={loadDirSummaries}
            onLoadFileSummaries={loadFileSummaries}
            onOpenFile={openFile}
            onOpenFileDir={openFileDir}
          />
        ) : (
          <KMSCollectionsView
            onSearchInCollection={handleSearchInCollection}
            onPreviewFile={handlePreview}
          />
        )}
      </div>

      {/* 设置抽屉（分Tab结构） */}
      <Drawer
        title={t('kms.settings')}
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        width={640}
        styles={{ body: { padding: 16, overflow: 'auto' } }}
      >
        <KMSSettingsPanel
          settings={kmsSettings}
          onSaveSettings={saveKmsSettings}
          dirs={dirs}
          onAddDir={addDir}
          onUpdateDir={updateDir}
          onDeleteDir={deleteDir}
          stats={stats}
          isIndexing={isIndexing}
          indexProgress={indexProgress}
          onBuildIndex={buildIndex}
          onIncrementalIndex={incrementalIndex}
          onRebuildIndex={buildIndex}
          onCancelIndex={cancelIndex}
          autoIndexStatus={autoIndexStatus}
          onRunAutoIndexCheck={runAutoIndexCheckNow}
        />
      </Drawer>

      {/* 文件预览弹窗 */}
      <KMSFilePreview
        open={!!previewFile}
        result={previewFile}
        keywords={previewKeywords}
        onClose={handleClosePreview}
        onOpenFile={openFile}
        onOpenFileDir={openFileDir}
      />
    </div>
  )
}

export default KMSPage
