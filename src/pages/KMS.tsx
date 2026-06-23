import React, { useCallback, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Drawer, Button, Typography, Space, theme } from 'antd'
import { SettingOutlined, FolderOpenOutlined, DatabaseOutlined } from '@ant-design/icons'
import { KMSSearchPanel, KMSDirPanel, KMSIndexPanel, KMSFilePreview } from '../components/kms'
import { useKMS } from '../hooks/useKMS'

const { Title } = Typography

const KMSPage: React.FC = () => {
  const { t } = useTranslation()
  const { token } = theme.useToken()

  const {
    dirs,
    searchQuery,
    setSearchQuery,
    searchMode,
    setSearchMode,
    searchResults,
    agentResult,
    isSearching,
    indexProgress,
    isIndexing,
    stats,
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

  const handlePreview = useCallback((result: any) => {
    setPreviewFile(result)
  }, [setPreviewFile])

  const handleClosePreview = useCallback(() => {
    setPreviewFile(null)
  }, [setPreviewFile])

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
      {/* 顶部工具栏 */}
      <div style={{
        display: 'flex',
        justifyContent: 'flex-end',
        alignItems: 'center',
        marginBottom: 8,
        flexShrink: 0,
      }}>
        <Button
          type="text"
          icon={<SettingOutlined />}
          onClick={() => setSettingsOpen(true)}
        >
          {t('kms.settings')}
        </Button>
      </div>

      {/* 搜索面板（主体，占满剩余空间） */}
      <div style={{ flex: 1, minHeight: 0 }}>
        <KMSSearchPanel
          searchQuery={searchQuery}
          onSearchQueryChange={setSearchQuery}
          searchMode={searchMode}
          onSearchModeChange={setSearchMode}
          searchResults={searchResults}
          agentResult={agentResult}
          isSearching={isSearching}
          onSearch={search}
          dirs={dirs}
          onOpenFile={openFile}
          onOpenFileDir={openFileDir}
          onPreview={handlePreview}
        />
      </div>

      {/* 设置抽屉 */}
      <Drawer
        title={t('kms.settings')}
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        width={520}
        styles={{ body: { padding: 16, overflow: 'auto' } }}
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: 24 }}>
          {/* 目录管理 */}
          <div>
            <Space style={{ marginBottom: 12 }}>
              <FolderOpenOutlined style={{ color: token.colorPrimary }} />
              <Title level={5} style={{ margin: 0 }}>{t('kms.dirs')}</Title>
            </Space>
            <KMSDirPanel
              dirs={dirs}
              onUpdateDir={updateDir}
              onDeleteDir={deleteDir}
              onAddDir={addDir}
            />
          </div>

          {/* 索引管理 */}
          <div>
            <Space style={{ marginBottom: 12 }}>
              <DatabaseOutlined style={{ color: token.colorPrimary }} />
              <Title level={5} style={{ margin: 0 }}>{t('kms.indexSettings')}</Title>
            </Space>
            <KMSIndexPanel
              stats={stats}
              isIndexing={isIndexing}
              indexProgress={indexProgress}
              onBuildIndex={buildIndex}
              onIncrementalIndex={incrementalIndex}
              onRebuildIndex={buildIndex}
              onCancelIndex={cancelIndex}
            />
          </div>
        </div>
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
