import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Button, Space, Empty, Tabs, theme } from 'antd'
import { PlusOutlined, BookOutlined, FileSearchOutlined, EyeOutlined } from '@ant-design/icons'
import PageHeader from '../components/common/PageHeader'
import TaskProgressPanel from '../components/common/TaskProgressPanel'
import {
  KBListPanel, KBDocList, KBSearchPanel,
  KBHeaderCard, KBCreateModal, KBEditModal,
  KBExportModal, KBImportModal, KBFolderScanModal,
  KBContentBrowser,
} from '../components/knowledge-base'
import { useKnowledgeBase } from '../hooks/useKnowledgeBase'

const KnowledgeBasePage: React.FC = () => {
  const { t } = useTranslation()
  const { token } = theme.useToken()
  const [listPanelCollapsed, setListPanelCollapsed] = useState(true)

  const {
    kbs, selectedKB, onSelectKB, onDeleteKB,
    docs, pendingCount, completedCount, failedCount, pausedCount,
    parsingAll, uploadLoading, processedDocIds,
    onParseDocument, onParseAll, onDeleteDoc,
    onPauseParse, onResumeParse, onRetryParse,
    onPauseAll, onResumeAll, onCancelAll,
    onUploadFiles, onUploadFolder, onRefreshDocs,
    processingDocId, processingAll, buildingGlobal, docProcessProgress,
    knowledgeStats, globalSummary,
    onProcessDocument, onProcessAll, onBuildGlobal,
    createModalOpen, setCreateModalOpen, newKBName, setNewKBName, newKBDesc, setNewKBDesc, onCreateKB,
    editKBModalOpen, setEditKBModalOpen, editKBName, setEditKBName, editKBDesc, setEditKBDesc, onConfirmEditKB, onEditKB,
    activeTab, onTabChange,
    selectedProviderId, selectedModelId, enableThinking,
    onLlmChange, onThinkingChange,
    exportModalOpen, setExportModalOpen, exporting, exportProgress, onExport,
    importModalOpen, setImportModalOpen, importConflictStrategy, setImportConflictStrategy, importing, importProgress, importKBName, setImportKBName, onImport, onOpenImportModal,
    folderScanModalOpen, folderScanning, scannedFiles, scannedUnsupported, selectedScannedKeys, setSelectedScannedKeys, scannedTreeData, expandedFolderKeys, folderUploading, onTreeSelect, onFolderUploadConfirm, onFolderScanModalClose,
    searchPanelOpen, setSearchPanelOpen,
  } = useKnowledgeBase()

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column', padding: 24 }}>
      <PageHeader
        title={t('knowledgeBase.title')}
        subTitle={t('knowledgeBase.subtitle')}
        extra={
          <Space>
            <TaskProgressPanel />
            <Button icon={<FileSearchOutlined />} onClick={() => setSearchPanelOpen(true)} disabled={kbs.length === 0}>{t('knowledgeBase.kbSearch')}</Button>
            <Button icon={<PlusOutlined />} type="primary" onClick={() => setCreateModalOpen(true)}>{t('knowledgeBase.createKb')}</Button>
          </Space>
        }
      />

      <div style={{ flex: 1, display: 'flex', gap: 12, minHeight: 0 }}>
        <KBListPanel
          kbs={kbs}
          selectedKB={selectedKB}
          onSelectKB={onSelectKB}
          onDeleteKB={onDeleteKB}
          collapsed={listPanelCollapsed}
          onToggleCollapse={() => setListPanelCollapsed(!listPanelCollapsed)}
        />

        <div style={{ flex: 1, overflow: 'auto', minHeight: 0 }}>
          {!selectedKB ? (
            <div style={{
              height: '100%',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
            }}>
              <Empty image={<BookOutlined style={{ fontSize: 64, color: token.colorTextQuaternary }} />}
                description={t('knowledgeBase.selectOrCreate')}>
                <Button type="primary" icon={<PlusOutlined />} onClick={() => setCreateModalOpen(true)}>{t('knowledgeBase.createKb')}</Button>
              </Empty>
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
              <KBHeaderCard
                selectedKB={selectedKB}
                uploadLoading={uploadLoading}
                onUploadFiles={onUploadFiles}
                onUploadFolder={onUploadFolder}
                onEditKB={onEditKB}
                onOpenExportModal={() => setExportModalOpen(true)}
                onOpenImportModal={onOpenImportModal}
                selectedProviderId={selectedProviderId}
                selectedModelId={selectedModelId}
                enableThinking={enableThinking}
                onLlmChange={onLlmChange}
                onThinkingChange={onThinkingChange}
              />

              <div style={{ flex: 1, minHeight: 0 }}>
                <Tabs activeKey={activeTab} onChange={onTabChange} items={[
                  {
                    key: 'docs',
                    label: <Space><FileSearchOutlined />{t('knowledgeBase.tabDocs')}</Space>,
                    children: (
                      <KBDocList
                        docs={docs}
                        parsingAll={parsingAll}
                        processingAll={processingAll}
                        buildingGlobal={buildingGlobal}
                        completedCount={completedCount}
                        pendingCount={pendingCount}
                        failedCount={failedCount}
                        pausedCount={pausedCount}
                        processedDocIds={processedDocIds}
                        processingDocId={processingDocId}
                        docProcessProgress={docProcessProgress}
                        knowledgeStats={knowledgeStats}
                        globalSummary={globalSummary}
                        selectedKbId={selectedKB?.id || ''}
                        onParseAll={onParseAll}
                        onParseDocument={onParseDocument}
                        onProcessDocument={onProcessDocument}
                        onProcessAll={onProcessAll}
                        onBuildGlobal={onBuildGlobal}
                        onDeleteDoc={onDeleteDoc}
                        onRefresh={onRefreshDocs}
                        onPauseParse={onPauseParse}
                        onResumeParse={onResumeParse}
                        onRetryParse={onRetryParse}
                        onPauseAll={onPauseAll}
                        onResumeAll={onResumeAll}
                        onCancelAll={onCancelAll}
                      />
                    ),
                  },
                  {
                    key: 'content',
                    label: <Space><EyeOutlined />{t('knowledgeBase.tabContent')}</Space>,
                    children: (
                      <KBContentBrowser
                        kbId={selectedKB?.id || ''}
                        docs={docs.filter(d => d.parse_status === 'completed')}
                        loading={false}
                      />
                    ),
                  },
                ]} />
              </div>
            </div>
          )}
        </div>
      </div>

      <KBCreateModal
        open={createModalOpen}
        onCancel={() => setCreateModalOpen(false)}
        onConfirm={onCreateKB}
        name={newKBName}
        onNameChange={setNewKBName}
        desc={newKBDesc}
        onDescChange={setNewKBDesc}
      />

      <KBEditModal
        open={editKBModalOpen}
        onCancel={() => setEditKBModalOpen(false)}
        onConfirm={onConfirmEditKB}
        name={editKBName}
        onNameChange={setEditKBName}
        desc={editKBDesc}
        onDescChange={setEditKBDesc}
      />

      <KBExportModal
        open={exportModalOpen}
        onCancel={() => setExportModalOpen(false)}
        onConfirm={onExport}
        exporting={exporting}
        exportProgress={exportProgress}
      />

      <KBImportModal
        open={importModalOpen}
        onCancel={() => setImportModalOpen(false)}
        onConfirm={onImport}
        conflictStrategy={importConflictStrategy}
        onConflictStrategyChange={setImportConflictStrategy}
        importing={importing}
        importProgress={importProgress}
        importKBName={importKBName}
        onKBNameChange={setImportKBName}
      />

      <KBFolderScanModal
        open={folderScanModalOpen}
        onClose={onFolderScanModalClose}
        scanning={folderScanning}
        scannedFiles={scannedFiles}
        scannedUnsupported={scannedUnsupported}
        selectedKeys={selectedScannedKeys}
        onSelectedKeysChange={setSelectedScannedKeys}
        treeData={scannedTreeData}
        expandedKeys={expandedFolderKeys}
        uploading={folderUploading}
        onTreeSelect={onTreeSelect}
        onConfirm={onFolderUploadConfirm}
      />

      <KBSearchPanel
        open={searchPanelOpen}
        onClose={() => setSearchPanelOpen(false)}
        kbList={kbs}
      />
    </div>
  )
}

export default KnowledgeBasePage
