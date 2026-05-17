import { useTranslation } from 'react-i18next'
import { Card, Button, Space, Empty, Tabs, theme } from 'antd'
import { PlusOutlined, FileTextOutlined, BookOutlined, ThunderboltOutlined, NodeIndexOutlined, SearchOutlined } from '@ant-design/icons'
import PageHeader from '../components/common/PageHeader'
import {
  KBListPanel, KBDocList, KBKnowledgeView, KBEntityGraph, KBSearchPanel,
  KBHeaderCard, KBCreateModal, KBEditModal, KBLinkProjectModal,
  KBExportModal, KBImportModal, KBFolderScanModal,
} from '../components/knowledge-base'
import { useKnowledgeBase } from '../hooks/useKnowledgeBase'

const KnowledgeBasePage: React.FC = () => {
  const { t } = useTranslation()
  const { token } = theme.useToken()

  const {
    kbs, selectedKB, onSelectKB, onDeleteKB,
    docs, pendingCount, completedCount, failedCount, pausedCount,
    parsingAll, uploadLoading, processedDocIds,
    onParseDocument, onParseAll, onDeleteDoc,
    onPauseParse, onResumeParse, onRetryParse,
    onPauseAll, onResumeAll, onCancelAll,
    onUploadFiles, onUploadFolder, onRefreshDocs,
    processingDocId, processingAll, buildingGlobal, processProgress,
    knowledgeStats, globalSummary, docSummaries, allRelations,
    onProcessDocument, onProcessAll, onBuildGlobal,
    onViewChapters, onViewDocContent, onViewParseDetail,
    docChapters, chapterModalOpen, selectedDocSummary, onCloseChapterModal,
    docContent, docContentTitle, docContentModalOpen, onCloseDocContentModal,
    entities, entityFilter, selectedEntity, entityRelations, entityModalOpen,
    onEntityFilterChange, onLoadEntities, onViewEntity, onCloseEntityModal,
    linkedProjects, allProjects, onLinkProject, onProjectLink,
    createModalOpen, setCreateModalOpen, newKBName, setNewKBName, newKBDesc, setNewKBDesc, onCreateKB,
    editKBModalOpen, setEditKBModalOpen, editKBName, setEditKBName, editKBDesc, setEditKBDesc, onConfirmEditKB, onEditKB,
    linkModalOpen, setLinkModalOpen,
    activeTab, onTabChange,
    selectedProviderId, selectedModelId, enableThinking,
    onProviderChange, onModelChange, onThinkingChange,
    exportModalOpen, setExportModalOpen, exportType, setExportType, exportFormat, setExportFormat, exporting, exportProgress, onExport,
    importModalOpen, setImportModalOpen, importType, setImportType, importFormat, setImportFormat, importConflictStrategy, setImportConflictStrategy, importing, importProgress, importKBName, setImportKBName, onImport, onOpenImportModal,
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
            <Button icon={<SearchOutlined />} onClick={() => setSearchPanelOpen(true)} disabled={kbs.length === 0}>{t('knowledgeBase.kbSearch')}</Button>
            <Button icon={<PlusOutlined />} type="primary" onClick={() => setCreateModalOpen(true)}>{t('knowledgeBase.createKb')}</Button>
          </Space>
        }
      />

      <div style={{ flex: 1, display: 'flex', gap: 16, minHeight: 0 }}>
        <KBListPanel
          kbs={kbs}
          selectedKB={selectedKB}
          onSelectKB={onSelectKB}
          onDeleteKB={onDeleteKB}
        />

        <div style={{ flex: 1, overflow: 'auto' }}>
          {!selectedKB ? (
            <Card>
              <Empty image={<BookOutlined style={{ fontSize: 64, color: token.colorTextQuaternary }} />}
                description={t('knowledgeBase.selectOrCreate')} />
              <div style={{ textAlign: 'center' }}>
                <Button type="primary" icon={<PlusOutlined />} onClick={() => setCreateModalOpen(true)}>{t('knowledgeBase.createKb')}</Button>
              </div>
            </Card>
          ) : (
            <div>
              <KBHeaderCard
                selectedKB={selectedKB}
                linkedProjects={linkedProjects}
                uploadLoading={uploadLoading}
                onUploadFiles={onUploadFiles}
                onUploadFolder={onUploadFolder}
                onEditKB={onEditKB}
                onOpenExportModal={() => setExportModalOpen(true)}
                onOpenImportModal={onOpenImportModal}
                onLinkProject={onLinkProject}
                selectedProviderId={selectedProviderId}
                selectedModelId={selectedModelId}
                enableThinking={enableThinking}
                onProviderChange={onProviderChange}
                onModelChange={onModelChange}
                onThinkingChange={onThinkingChange}
              />

              <Tabs activeKey={activeTab} onChange={onTabChange} items={[
                {
                  key: 'docs',
                  label: <Space><FileTextOutlined />{t('knowledgeBase.tabDocs')}</Space>,
                  children: (
                    <KBDocList
                      docs={docs}
                      parsingAll={parsingAll}
                      processingAll={processingAll}
                      processProgress={processProgress}
                      completedCount={completedCount}
                      pendingCount={pendingCount}
                      failedCount={failedCount}
                      pausedCount={pausedCount}
                      processedDocIds={processedDocIds}
                      processingDocId={processingDocId}
                      onParseAll={onParseAll}
                      onParseDocument={onParseDocument}
                      onProcessDocument={onProcessDocument}
                      onDeleteDoc={onDeleteDoc}
                      onRefresh={onRefreshDocs}
                      onPauseParse={onPauseParse}
                      onResumeParse={onResumeParse}
                      onRetryParse={onRetryParse}
                      onPauseAll={onPauseAll}
                      onResumeAll={onResumeAll}
                      onCancelAll={onCancelAll}
                      onViewDetail={onViewParseDetail}
                    />
                  ),
                },
                {
                  key: 'knowledge',
                  label: <Space><ThunderboltOutlined />{t('knowledgeBase.tabKnowledge')}</Space>,
                  children: (
                    <KBKnowledgeView
                      selectedKbId={selectedKB?.id || ''}
                      knowledgeStats={knowledgeStats}
                      globalSummary={globalSummary}
                      docSummaries={docSummaries}
                      allRelations={allRelations}
                      processingDocId={processingDocId}
                      processingAll={processingAll}
                      buildingGlobal={buildingGlobal}
                      processProgress={processProgress}
                      onProcessAll={onProcessAll}
                      onBuildGlobal={onBuildGlobal}
                      onProcessDocument={onProcessDocument}
                      onViewChapters={onViewChapters}
                      onViewDocContent={onViewDocContent}
                      docChapters={docChapters}
                      chapterModalOpen={chapterModalOpen}
                      selectedDocSummary={selectedDocSummary}
                      onCloseChapterModal={onCloseChapterModal}
                      docContent={docContent}
                      docContentTitle={docContentTitle}
                      docContentModalOpen={docContentModalOpen}
                      onCloseDocContentModal={onCloseDocContentModal}
                      onViewParseDetail={onViewParseDetail}
                    />
                  ),
                },
                {
                  key: 'entities',
                  label: <Space><NodeIndexOutlined />{t('knowledgeBase.tabEntity')}</Space>,
                  children: (
                    <KBEntityGraph
                      entities={entities}
                      entityFilter={entityFilter}
                      selectedEntity={selectedEntity}
                      entityRelations={entityRelations}
                      entityModalOpen={entityModalOpen}
                      onEntityFilterChange={onEntityFilterChange}
                      onLoadEntities={onLoadEntities}
                      onViewEntity={onViewEntity}
                      onCloseEntityModal={onCloseEntityModal}
                      selectedKBId={selectedKB.id}
                    />
                  ),
                },
              ]} />
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

      <KBLinkProjectModal
        open={linkModalOpen}
        onCancel={() => setLinkModalOpen(false)}
        allProjects={allProjects}
        linkedProjects={linkedProjects}
        onProjectLink={onProjectLink}
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
        exportType={exportType}
        onTypeChange={setExportType}
        exportFormat={exportFormat}
        onFormatChange={setExportFormat}
        exporting={exporting}
        exportProgress={exportProgress}
      />

      <KBImportModal
        open={importModalOpen}
        onCancel={() => setImportModalOpen(false)}
        onConfirm={onImport}
        importType={importType}
        onTypeChange={setImportType}
        importFormat={importFormat}
        onFormatChange={setImportFormat}
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
