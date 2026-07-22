import { useEffect, useMemo, useState, useCallback } from 'react'
import { Button, Segmented, Tooltip, Empty, Spin, theme, App } from 'antd'
import {
  PlusOutlined,
  FileTextOutlined,
  EditOutlined,
  ColumnHeightOutlined,
  EyeOutlined,
  MenuFoldOutlined,
  MenuUnfoldOutlined,
  SearchOutlined,
  FolderOpenOutlined,
  CheckOutlined,
  LoadingOutlined,
} from '@ant-design/icons'
import { useTranslation } from 'react-i18next'
import { useNotes } from '../hooks/useNotes'
import NotesTree from '../components/notes/NotesTree'
import VditorEditor from '../components/notes/VditorEditor'
import NoteOutline from '../components/notes/NoteOutline'
import NotesSearchPanel from '../components/notes/NotesSearchPanel'
import type { NoteEditorMode } from '../types/notes'

const NotesPage: React.FC = () => {
  const { t } = useTranslation()
  const { token } = theme.useToken()
  const { message } = App.useApp()
  const notes = useNotes()

  const [activeTab, setActiveTab] = useState<'tree' | 'search'>('tree')

  // 初始化
  useEffect(() => {
    notes.init()
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const handleCreateNoteAtRoot = useCallback(async () => {
    const node = await notes.createNote('', '')
    if (node) {
      await notes.openNote(node.relPath)
      message.success(t('notes.noteCreated'))
    }
  }, [notes, message, t])

  const handleOpenVault = useCallback(async () => {
    try {
      const dataDir = await window.electronAPI.app.getDataDir?.()
      if (dataDir) {
        await window.electronAPI.workspace.openInExplorer({ path: `${dataDir}/notes` })
      }
    } catch { /* ignore */ }
  }, [])

  const handleModeChange = useCallback((mode: NoteEditorMode) => {
    notes.updateSettings({ editor_mode: mode })
  }, [notes])

  const handleToggleSidebar = useCallback(() => {
    notes.updateSettings({ sidebar_collapsed: !notes.settings.sidebar_collapsed })
  }, [notes.settings.sidebar_collapsed, notes])

  const handleToggleOutline = useCallback(() => {
    notes.updateSettings({ outline_collapsed: !notes.settings.outline_collapsed })
  }, [notes.settings.outline_collapsed, notes])

  const handleJumpToText = useCallback((text: string) => {
    notes.setLocateText(text)
  }, [notes])

  const sidebarCollapsed = notes.settings.sidebar_collapsed
  const outlineCollapsed = notes.settings.outline_collapsed
  const editorMode = notes.settings.editor_mode

  const fileName = useMemo(() => {
    if (!notes.currentRelPath) return ''
    return notes.currentRelPath.split('/').pop() || notes.currentRelPath
  }, [notes.currentRelPath])

  const wordCount = useMemo(() => {
    if (!notes.currentContent) return 0
    const cjk = (notes.currentContent.match(/[\u4e00-\u9fa5\u3040-\u30ff]/g) || []).length
    const en = (notes.currentContent.replace(/[\u4e00-\u9fa5\u3040-\u30ff]/g, ' ').match(/\b\w+\b/g) || []).length
    return cjk + en
  }, [notes.currentContent])

  const saveStatusNode = useMemo(() => {
    switch (notes.saveStatus) {
      case 'saving':
        return (
          <span style={{ color: token.colorTextTertiary, fontSize: 12 }}>
            <LoadingOutlined style={{ marginRight: 4 }} />{t('notes.saving')}
          </span>
        )
      case 'dirty':
        return (
          <span style={{ color: token.colorWarning, fontSize: 12 }}>
            {t('notes.unsaved')}
          </span>
        )
      default:
        return (
          <span style={{ color: token.colorTextTertiary, fontSize: 12 }}>
            <CheckOutlined style={{ marginRight: 4, color: token.colorSuccess }} />{t('notes.saved')}
          </span>
        )
    }
  }, [notes.saveStatus, token, t])

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', background: token.colorBgLayout }}>
      {/* 顶部工具栏 */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          padding: '6px 12px',
          borderBottom: `1px solid ${token.colorBorderSecondary}`,
          background: token.colorBgContainer,
          flexShrink: 0,
        }}
      >
        <Tooltip title={sidebarCollapsed ? t('notes.showSidebar') : t('notes.hideSidebar')}>
          <Button
            type="text"
            size="small"
            icon={sidebarCollapsed ? <MenuUnfoldOutlined /> : <MenuFoldOutlined />}
            onClick={handleToggleSidebar}
          />
        </Tooltip>

        <Tooltip title={t('notes.newNote')}>
          <Button type="primary" size="small" icon={<PlusOutlined />} onClick={handleCreateNoteAtRoot}>
            {t('notes.newNote')}
          </Button>
        </Tooltip>

        <div style={{ width: 1, height: 18, background: token.colorBorderSecondary, margin: '0 4px' }} />

        <Segmented
          size="small"
          value={editorMode}
          onChange={(v) => handleModeChange(v as NoteEditorMode)}
          options={[
            { value: 'edit', icon: <EditOutlined />, label: t('notes.modeLive') },
            { value: 'split', icon: <ColumnHeightOutlined />, label: t('notes.modeSplit') },
            { value: 'preview', icon: <EyeOutlined />, label: t('notes.modeRead') },
          ]}
        />

        <Tooltip title={t('notes.openVault')}>
          <Button type="text" size="small" icon={<FolderOpenOutlined />} onClick={handleOpenVault} />
        </Tooltip>

        <div style={{ flex: 1 }} />

        {/* 当前文件名 + 保存状态 + 字数 */}
        {notes.currentRelPath ? (
          <>
            <Tooltip title={notes.currentRelPath}>
              <span style={{ fontSize: 12, color: token.colorTextSecondary, maxWidth: 280, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {fileName}
              </span>
            </Tooltip>
            {saveStatusNode}
            <span style={{ fontSize: 11, color: token.colorTextQuaternary }}>
              {t('notes.wordCount', { count: wordCount })}
            </span>
          </>
        ) : null}
      </div>

      {/* 主体三栏 */}
      <div style={{ flex: 1, display: 'flex', minHeight: 0, position: 'relative' }}>
        {/* 左：侧栏（树 / 搜索 切换） */}
        {!sidebarCollapsed && (
          <div
            style={{
              width: 260,
              borderRight: `1px solid ${token.colorBorderSecondary}`,
              display: 'flex',
              flexDirection: 'column',
              minHeight: 0,
              flexShrink: 0,
              background: token.colorBgContainer,
            }}
          >
            <div style={{ display: 'flex', padding: '6px 6px 0', gap: 4 }}>
              <Button
                size="small"
                type={activeTab === 'tree' ? 'primary' : 'text'}
                icon={<FileTextOutlined />}
                onClick={() => setActiveTab('tree')}
                style={{ flex: 1 }}
              >
                {t('notes.tabTree')}
              </Button>
              <Button
                size="small"
                type={activeTab === 'search' ? 'primary' : 'text'}
                icon={<SearchOutlined />}
                onClick={() => setActiveTab('search')}
                style={{ flex: 1 }}
              >
                {t('notes.tabSearch')}
              </Button>
            </div>
            <div style={{ flex: 1, minHeight: 0, overflow: 'hidden' }}>
              {notes.treeLoading && notes.tree.length === 0 ? (
                <div style={{ padding: 24, textAlign: 'center' }}>
                  <Spin size="small" />
                </div>
              ) : activeTab === 'tree' ? (
                <NotesTree
                  tree={notes.tree}
                  loading={notes.treeLoading}
                  currentRelPath={notes.currentRelPath}
                  onOpen={notes.openNote}
                  onRefresh={notes.refreshTree}
                  onCreateNote={notes.createNote}
                  onCreateFolder={notes.createFolder}
                  onRename={notes.renameItem}
                  onDelete={notes.deleteItem}
                  onMove={notes.moveItem}
                />
              ) : (
                <NotesSearchPanel
                  query={notes.searchQuery}
                  results={notes.searchResults}
                  searching={notes.searching}
                  onQueryChange={notes.runSearch}
                  onOpenHit={notes.openSearchHit}
                />
              )}
            </div>
          </div>
        )}

        {/* 中：编辑器 */}
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0, minHeight: 0 }}>
          {notes.currentRelPath ? (
            <VditorEditor
              content={notes.currentContent}
              mode={editorMode}
              saveStatus={notes.saveStatus}
              locateText={notes.locateText}
              onContentChange={notes.setContent}
              onSave={notes.saveCurrent}
              onLocateHandled={() => notes.setLocateText(null)}
            />
          ) : (
            <div
              style={{
                flex: 1,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                background: token.colorBgLayout,
              }}
            >
              <Empty
                image={Empty.PRESENTED_IMAGE_SIMPLE}
                description={
                  <span style={{ color: token.colorTextSecondary }}>
                    {notes.tree.length === 0
                      ? t('notes.emptyVaultDesc')
                      : t('notes.emptyEditorDesc')}
                  </span>
                }
              >
                {notes.tree.length === 0 ? (
                  <Button type="primary" icon={<PlusOutlined />} onClick={handleCreateNoteAtRoot}>
                    {t('notes.createFirstNote')}
                  </Button>
                ) : null}
              </Empty>
            </div>
          )}
        </div>

        {/* 右：大纲 */}
        {!outlineCollapsed && notes.currentRelPath && (
          <div
            style={{
              width: 240,
              borderLeft: `1px solid ${token.colorBorderSecondary}`,
              display: 'flex',
              flexDirection: 'column',
              minHeight: 0,
              flexShrink: 0,
              background: token.colorBgContainer,
            }}
          >
            <div
              style={{
                padding: '8px 12px',
                fontSize: 12,
                fontWeight: 500,
                color: token.colorTextSecondary,
                borderBottom: `1px solid ${token.colorBorderSecondary}`,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
              }}
            >
              <span>{t('notes.outline')}</span>
              <Tooltip title={t('notes.hideOutline')}>
                <Button type="text" size="small" icon={<MenuFoldOutlined />} onClick={handleToggleOutline} />
              </Tooltip>
            </div>
            <div style={{ flex: 1, overflow: 'auto' }}>
              <NoteOutline content={notes.currentContent} onJump={handleJumpToText} />
            </div>
          </div>
        )}

        {/* 大纲收起时显示展开按钮 */}
        {outlineCollapsed && notes.currentRelPath && (
          <Tooltip title={t('notes.showOutline')} placement="left">
            <Button
              type="text"
              size="small"
              icon={<MenuUnfoldOutlined />}
              onClick={handleToggleOutline}
              style={{
                position: 'absolute',
                right: 8,
                top: 8,
                color: token.colorTextTertiary,
              }}
            />
          </Tooltip>
        )}
      </div>
    </div>
  )
}

export default NotesPage
