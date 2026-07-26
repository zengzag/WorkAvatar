import { useEffect, useMemo, useState, useCallback } from 'react'
import { Button, Segmented, Tooltip, Empty, Spin, theme, Modal, InputNumber, Form } from 'antd'
import {
  PlusOutlined,
  EditOutlined,
  ColumnHeightOutlined,
  EyeOutlined,
  MenuFoldOutlined,
  MenuUnfoldOutlined,
  FolderOpenOutlined,
  CheckOutlined,
  LoadingOutlined,
  SettingOutlined,
  CloseOutlined,
} from '@ant-design/icons'
import { useTranslation } from 'react-i18next'
import { useNotes } from '../hooks/useNotes'
import NotesTree from '../components/notes/NotesTree'
import VditorEditor from '../components/notes/VditorEditor'
import NoteOutline from '../components/notes/NoteOutline'
import type { NoteEditorMode } from '../types/notes'

const SIDEBAR_MIN = 180
const SIDEBAR_MAX = 480
const OUTLINE_MIN = 160
const OUTLINE_MAX = 480

const SidebarResizer: React.FC<{ onResize: (deltaX: number) => void; onResizeEnd?: () => void }> = ({ onResize, onResizeEnd }) => {
  const { token } = theme.useToken()
  const draggingRef = { current: false }
  const startXRef = { current: 0 }
  const onResizeEndRef = { current: onResizeEnd }
  onResizeEndRef.current = onResizeEnd

  const onMove = useCallback((e: MouseEvent) => {
    if (!draggingRef.current) return
    onResize(e.clientX - startXRef.current)
    startXRef.current = e.clientX
  }, [onResize])

  const onUp = useCallback(() => {
    draggingRef.current = false
    document.body.style.cursor = ''
    document.body.style.userSelect = ''
    window.removeEventListener('mousemove', onMove)
    window.removeEventListener('mouseup', onUp)
    onResizeEndRef.current?.()
  }, [onMove])

  const onDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    draggingRef.current = true
    startXRef.current = e.clientX
    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }, [onMove, onUp])

  return (
    <div
      onMouseDown={onDown}
      style={{
        width: 4,
        cursor: 'col-resize',
        flexShrink: 0,
        alignSelf: 'stretch',
        background: 'transparent',
        borderLeft: `1px solid ${token.colorBorderSecondary}`,
        transition: 'background 0.15s',
        zIndex: 5,
      }}
      onMouseEnter={(e) => { e.currentTarget.style.background = token.colorPrimaryBorder }}
      onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent' }}
    />
  )
}

const NotesPage: React.FC = () => {
  const { t } = useTranslation()
  const { token } = theme.useToken()
  const notes = useNotes()

  const [settingsOpen, setSettingsOpen] = useState(false)
  const [sidebarWidth, setSidebarWidth] = useState<number>(notes.settings.sidebar_width || 260)
  const [outlineWidth, setOutlineWidth] = useState<number>(notes.settings.outline_width || 260)
  const [selectedCount, setSelectedCount] = useState(0)

  useEffect(() => {
    notes.init()
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (notes.settings.sidebar_width) setSidebarWidth(notes.settings.sidebar_width)
  }, [notes.settings.sidebar_width])

  useEffect(() => {
    if (notes.settings.outline_width) setOutlineWidth(notes.settings.outline_width)
  }, [notes.settings.outline_width])

  const handleExpandedFoldersChange = useCallback((keys: string[]) => {
    notes.updateSettings({ expanded_folders: keys })
  }, [notes.updateSettings])

  const handleCreateNoteAtRoot = useCallback(async () => {
    if (!notes.activeTabId) {
      await notes.newTab()
    }
    const defaultName = t('notes.untitledNote')
    const node = await notes.createNote('', defaultName)
    if (node) {
      await notes.openNote((node as any).relPath, notes.activeTabId || undefined)
    }
  }, [notes, t])

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

  const handleCloseTab = useCallback(async (tabId: string) => {
    await notes.closeTab(tabId)
  }, [notes])

  const handleNewTab = useCallback(async () => {
    await notes.newTab()
  }, [notes])

  const handleSidebarResize = useCallback((deltaX: number) => {
    setSidebarWidth((prev) => Math.min(SIDEBAR_MAX, Math.max(SIDEBAR_MIN, prev + deltaX)))
  }, [])

  const handleSidebarResizeEnd = useCallback(() => {
    notes.updateSettings({ sidebar_width: sidebarWidth })
  }, [notes, sidebarWidth])

  const handleOutlineResize = useCallback((deltaX: number) => {
    setOutlineWidth((prev) => Math.min(OUTLINE_MAX, Math.max(OUTLINE_MIN, prev - deltaX)))
  }, [])

  const handleOutlineResizeEnd = useCallback(() => {
    notes.updateSettings({ outline_width: outlineWidth })
  }, [notes, outlineWidth])

  const editorMaxWidth = notes.settings.editor_max_width ?? 820
  const editorFontSize = notes.settings.editor_font_size ?? 15
  const editorLineHeight = notes.settings.editor_line_height ?? 1.7
  const editorContainerStyle = useMemo(() => ({
    '--notes-editor-max-width': editorMaxWidth > 0 ? `${editorMaxWidth}px` : '100%',
    '--notes-editor-font-size': `${editorFontSize}px`,
    '--notes-editor-line-height': String(editorLineHeight),
  } as React.CSSProperties), [editorMaxWidth, editorFontSize, editorLineHeight])

  const sidebarCollapsed = notes.settings.sidebar_collapsed
  const outlineCollapsed = notes.settings.outline_collapsed
  const editorMode = notes.settings.editor_mode

  useEffect(() => {
    if (notes.currentRelPath) {
      requestAnimationFrame(() => window.dispatchEvent(new Event('resize')))
    }
  }, [notes.activeTabId, notes.currentRelPath])

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

  const hasOpenFile = !!notes.currentRelPath
  const emptyEditor = notes.tabs.length === 0 || !hasOpenFile

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', background: token.colorBgLayout }}>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          padding: '4px 8px',
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

        <Tooltip title={t('notes.openVault')}>
          <Button type="text" size="small" icon={<FolderOpenOutlined />} onClick={handleOpenVault} />
        </Tooltip>

        <div style={{ flex: 1 }} />

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

        <div style={{ flex: 1 }} />

        <Tooltip title={t('notes.settings')}>
          <Button type="text" size="small" icon={<SettingOutlined />} onClick={() => setSettingsOpen(true)} />
        </Tooltip>
      </div>

      <div style={{ flex: 1, display: 'flex', minHeight: 0, position: 'relative' }}>
        {!sidebarCollapsed && (
          <>
            <div
              style={{
                width: sidebarWidth,
                minWidth: 0,
                borderRight: `1px solid ${token.colorBorderSecondary}`,
                display: 'flex',
                flexDirection: 'column',
                minHeight: 0,
                flexShrink: 0,
                overflow: 'hidden',
                background: token.colorBgContainer,
              }}
            >
              <div style={{ flex: 1, minHeight: 0, overflow: 'hidden' }}>
                {notes.treeLoading && notes.tree.length === 0 ? (
                  <div style={{ padding: 24, textAlign: 'center' }}>
                    <Spin size="small" />
                  </div>
                ) : (
                  <NotesTree
                    tree={notes.tree}
                    loading={notes.treeLoading}
                    currentRelPath={notes.currentRelPath}
                    expandedFolders={notes.settings.expanded_folders || []}
                    settingsLoading={notes.settingsLoading}
                    onExpandedFoldersChange={handleExpandedFoldersChange}
                    onOpen={(relPath) => notes.openNote(relPath)}
                    onRefresh={notes.refreshTree}
                    onCreateNote={notes.createNote}
                    onCreateFolder={notes.createFolder}
                    onRename={notes.renameItem}
                    onDelete={notes.deleteItem}
                    onMove={notes.moveItem}
                  />
                )}
              </div>
            </div>
            <SidebarResizer onResize={handleSidebarResize} onResizeEnd={handleSidebarResizeEnd} />
          </>
        )}

        <div
          style={{
            flex: 1,
            display: 'flex',
            flexDirection: 'column',
            minWidth: 0,
            minHeight: 0,
            ...editorContainerStyle,
          }}
        >
          {notes.tabs.length > 0 && (
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                borderBottom: `1px solid ${token.colorBorderSecondary}`,
                background: token.colorBgLayout,
                flexShrink: 0,
                overflowX: 'auto',
                overflowY: 'hidden',
                height: 36,
                minHeight: 36,
              }}
            >
              {notes.tabs.map((tab) => {
                const isActive = tab.id === notes.activeTabId
                const tabFileName = tab.relPath ? (tab.relPath.split('/').pop() || tab.relPath) : t('notes.newTab')
                const isDirty = tab.saveStatus === 'dirty'
                return (
                  <div
                    key={tab.id}
                    title={tab.relPath || t('notes.newTab')}
                    onClick={() => notes.switchTab(tab.id)}
                    onAuxClick={(e) => { if (e.button === 1) handleCloseTab(tab.id) }}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 5,
                      padding: '0 10px 0 14px',
                      height: '100%',
                      cursor: 'pointer',
                      borderBottom: isActive ? `2px solid ${token.colorPrimary}` : '2px solid transparent',
                      color: isActive ? token.colorText : token.colorTextSecondary,
                      fontWeight: isActive ? 500 : 400,
                      fontSize: 13,
                      whiteSpace: 'nowrap',
                      flexShrink: 0,
                      background: isActive ? token.colorBgContainer : 'transparent',
                      maxWidth: 220,
                    }}
                  >
                    <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{tabFileName}</span>
                    {isDirty && (
                      <span style={{ width: 6, height: 6, borderRadius: '50%', background: token.colorWarning, flexShrink: 0 }} />
                    )}
                    <CloseOutlined
                      style={{ fontSize: 11, opacity: 0.45, flexShrink: 0 }}
                      onClick={(e) => { e.stopPropagation(); handleCloseTab(tab.id) }}
                    />
                  </div>
                )
              })}
              <Tooltip title={t('notes.newTab')}>
                <Button
                  type="text"
                  size="small"
                  icon={<PlusOutlined />}
                  onClick={handleNewTab}
                  style={{ marginLeft: 4, flexShrink: 0 }}
                />
              </Tooltip>
            </div>
          )}

          {notes.tabs.map((tab) => {
            const isActive = tab.id === notes.activeTabId
            const isEditable = !!tab.relPath
            return (
              <div
                key={tab.id}
                style={{
                  display: isActive ? 'flex' : 'none',
                  flex: 1,
                  flexDirection: 'column',
                  minHeight: 0,
                }}
              >
                {isEditable ? (
                  <VditorEditor
                    tabId={tab.id}
                    content={tab.content}
                    mode={editorMode}
                    saveStatus={tab.saveStatus}
                    locateText={tab.locateText}
                    onContentChange={(content) => notes.updateTabContent(tab.id, content)}
                    onSave={() => notes.saveTabContent(tab.id)}
                    onLocateHandled={() => notes.clearTabLocateText(tab.id)}
                    onSelectionChange={isActive ? setSelectedCount : undefined}
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
                          {t('notes.selectNoteToEdit')}
                        </span>
                      }
                    >
                      <Button type="primary" icon={<PlusOutlined />} onClick={handleCreateNoteAtRoot}>
                        {t('notes.createNewNote')}
                      </Button>
                    </Empty>
                  </div>
                )}
              </div>
            )
          })}

          {emptyEditor && notes.tabs.length === 0 && (
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

        {!outlineCollapsed && notes.currentRelPath && (
          <>
            <SidebarResizer onResize={handleOutlineResize} onResizeEnd={handleOutlineResizeEnd} />
            <div
              style={{
                width: outlineWidth,
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
          </>
        )}

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
                zIndex: 10,
              }}
            />
          </Tooltip>
        )}
      </div>

      {notes.currentRelPath && (
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 12,
            padding: '2px 12px',
            borderTop: `1px solid ${token.colorBorderSecondary}`,
            background: token.colorBgContainer,
            flexShrink: 0,
            fontSize: 12,
          }}
        >
          <Tooltip title={notes.currentRelPath}>
            <span style={{ color: token.colorTextSecondary, maxWidth: 280, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {fileName}
            </span>
          </Tooltip>
          {saveStatusNode}
          <span style={{ color: token.colorTextQuaternary }}>
            {t('notes.wordCount', { count: wordCount })}
          </span>
          {selectedCount > 0 && (
            <span style={{ color: token.colorTextQuaternary }}>
              {t('notes.selectedCount', { count: selectedCount })}
            </span>
          )}
        </div>
      )}

      <NotesSettingsModal
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        settings={notes.settings}
        onSave={async (patch) => {
          await notes.updateSettings(patch)
        }}
      />
    </div>
  )
}

const NotesSettingsModal: React.FC<{
  open: boolean
  onClose: () => void
  settings: import('../types/notes').NotesSettings
  onSave: (patch: Partial<import('../types/notes').NotesSettings>) => Promise<void>
}> = ({ open, onClose, settings, onSave }) => {
  const { t } = useTranslation()
  const [form] = Form.useForm()
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (open) {
      form.setFieldsValue({
        editor_max_width: settings.editor_max_width ?? 820,
        editor_font_size: settings.editor_font_size ?? 15,
        editor_line_height: settings.editor_line_height ?? 1.7,
        sidebar_width: settings.sidebar_width ?? 260,
        outline_width: settings.outline_width ?? 260,
      })
    }
  }, [open, settings, form])

  const handleOk = useCallback(async () => {
    try {
      const values = await form.validateFields()
      setSaving(true)
      await onSave({
        editor_max_width: Number(values.editor_max_width) || 0,
        editor_font_size: Number(values.editor_font_size) || 15,
        editor_line_height: Number(values.editor_line_height) || 1.7,
        sidebar_width: Number(values.sidebar_width) || 260,
        outline_width: Number(values.outline_width) || 260,
      })
      onClose()
    } catch { /* 校验失败 */ } finally {
      setSaving(false)
    }
  }, [form, onSave, onClose])

  return (
    <Modal
      title={t('notes.settings')}
      open={open}
      onOk={handleOk}
      onCancel={onClose}
      okText={t('common.save')}
      cancelText={t('common.cancel')}
      confirmLoading={saving}
      destroyOnClose
      width={420}
    >
      <Form form={form} layout="vertical" style={{ marginTop: 12 }}>
        <Form.Item
          name="editor_max_width"
          label={t('notes.settingsEditorMaxWidth')}
          tooltip={t('notes.settingsEditorMaxWidthTip')}
        >
          <InputNumber min={0} max={2000} step={20} style={{ width: '100%' }} addonAfter="px" />
        </Form.Item>
        <Form.Item
          name="editor_font_size"
          label={t('notes.settingsEditorFontSize')}
        >
          <InputNumber min={12} max={24} step={1} style={{ width: '100%' }} addonAfter="px" />
        </Form.Item>
        <Form.Item
          name="editor_line_height"
          label={t('notes.settingsEditorLineHeight')}
        >
          <InputNumber min={1} max={2.5} step={0.1} style={{ width: '100%' }} />
        </Form.Item>
        <Form.Item
          name="sidebar_width"
          label={t('notes.settingsSidebarWidth')}
        >
          <InputNumber min={180} max={480} step={10} style={{ width: '100%' }} addonAfter="px" />
        </Form.Item>
        <Form.Item
          name="outline_width"
          label={t('notes.settingsOutlineWidth')}
        >
          <InputNumber min={160} max={480} step={10} style={{ width: '100%' }} addonAfter="px" />
        </Form.Item>
      </Form>
    </Modal>
  )
}

export default NotesPage
