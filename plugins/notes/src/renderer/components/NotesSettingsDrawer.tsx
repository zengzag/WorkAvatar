import { useEffect, useMemo, useState, useRef } from 'react'
import {
  Drawer, Tabs, Card, Divider, theme,
  InputNumber, Switch, Button, Input, Modal, Tree,
} from 'antd'
import type { TreeDataNode } from 'antd'
import {
  EditOutlined, BookOutlined, FolderOpenOutlined,
} from '@ant-design/icons'
import { hostT } from '../store'
import SettingsItem from './SettingsItem'
import type { NotesSettings, NoteNode } from '../types'

interface NotesSettingsDrawerProps {
  open: boolean
  onClose: () => void
  settings: NotesSettings
  tree: NoteNode[]
  onSave: (patch: Partial<NotesSettings>) => Promise<void>
}

// 收集所有文件夹（扁平 {label,value} 列表，含嵌套路径）
function collectFolders(nodes: NoteNode[], acc: { label: string; value: string }[] = [], prefix = ''): { label: string; value: string }[] {
  for (const n of nodes) {
    if (n.type === 'folder') {
      const label = prefix ? `${prefix}/${n.name}` : n.name
      acc.push({ label, value: n.relPath })
      if (n.children) collectFolders(n.children, acc, label)
    }
  }
  return acc
}

function foldersToTreeData(folders: { label: string; value: string }[]): TreeDataNode[] {
  const root: NoteNode[] = []
  const map = new Map<string, NoteNode>()
  for (const f of folders) {
    const parts = f.value.split('/')
    const name = parts[parts.length - 1]
    map.set(f.value, { name, relPath: f.value, type: 'folder', mtime: 0, size: 0, children: [] })
  }
  for (const f of folders) {
    const parts = f.value.split('/')
    const node = map.get(f.value)!
    if (parts.length === 1) {
      root.push(node)
    } else {
      const parent = map.get(parts.slice(0, -1).join('/'))
      if (parent) parent.children!.push(node)
      else root.push(node)
    }
  }
  const toData = (nodes: NoteNode[]): TreeDataNode[] => nodes.map((n) => ({
    key: n.relPath,
    title: n.name,
    icon: <FolderOpenOutlined />,
    children: n.children ? toData(n.children) : undefined,
    isLeaf: false,
  }))
  return toData(root)
}

const FolderPickerModal: React.FC<{
  open: boolean
  tree: NoteNode[]
  selected: string
  onCancel: () => void
  onOk: (relPath: string) => void
}> = ({ open, tree, selected, onCancel, onOk }) => {
  const t = hostT
  const [inner, setInner] = useState('')
  useEffect(() => { if (open) setInner(selected) }, [open, selected])
  const folders = useMemo(() => collectFolders(tree), [tree])
  const treeData = useMemo(() => foldersToTreeData(folders), [folders])
  const selectedKey = inner === '' ? '__root__' : inner
  return (
    <Modal
      title={t('settingsDiaryRootPickerTitle')}
      open={open}
      onOk={() => onOk(inner)}
      onCancel={onCancel}
      okText={t('common.confirm')}
      cancelText={t('common.cancel')}
      destroyOnClose
      width={420}
    >
      <div style={{ maxHeight: '60vh', overflow: 'auto', marginTop: 8 }}>
        <Tree
          showIcon
          blockNode
          defaultExpandAll
          selectedKeys={[selectedKey]}
          onSelect={(keys) => {
            const k = String(keys[0] === '__root__' ? '' : keys[0] || '')
            setInner(k)
          }}
          treeData={[{
            key: '__root__',
            title: t('vaultRoot'),
            icon: <FolderOpenOutlined />,
            children: treeData,
          }]}
        />
      </div>
    </Modal>
  )
}

const NotesSettingsDrawer: React.FC<NotesSettingsDrawerProps> = ({
  open, onClose, settings, tree, onSave,
}) => {
  const t = hostT
  const { token } = theme.useToken()

  const [editorMaxWidth, setEditorMaxWidth] = useState<number>(settings.editor_max_width ?? 820)
  const [editorFontSize, setEditorFontSize] = useState<number>(settings.editor_font_size ?? 15)
  const [editorLineHeight, setEditorLineHeight] = useState<number>(settings.editor_line_height ?? 1.7)
  const [sidebarWidth, setSidebarWidth] = useState<number>(settings.sidebar_width ?? 260)
  const [outlineWidth, setOutlineWidth] = useState<number>(settings.outline_width ?? 260)
  const [diaryEnabled, setDiaryEnabled] = useState<boolean>(settings.diary_enabled ?? false)
  const [diaryRoot, setDiaryRoot] = useState<string>(settings.diary_root ?? 'diary')
  const [pickerOpen, setPickerOpen] = useState(false)

  const skipSaveRef = useRef(true)

  useEffect(() => {
    if (open) {
      setEditorMaxWidth(settings.editor_max_width ?? 820)
      setEditorFontSize(settings.editor_font_size ?? 15)
      setEditorLineHeight(settings.editor_line_height ?? 1.7)
      setSidebarWidth(settings.sidebar_width ?? 260)
      setOutlineWidth(settings.outline_width ?? 260)
      setDiaryEnabled(settings.diary_enabled ?? false)
      setDiaryRoot(settings.diary_root ?? 'diary')
      skipSaveRef.current = true
    }
  }, [open, settings])

  // 自动保存：任一字段变化后延迟 500ms 保存
  useEffect(() => {
    if (skipSaveRef.current) {
      skipSaveRef.current = false
      return
    }
    if (!open) return
    const timer = setTimeout(() => {
      onSave({
        editor_max_width: Number(editorMaxWidth) || 0,
        editor_font_size: Number(editorFontSize) || 15,
        editor_line_height: Number(editorLineHeight) || 1.7,
        sidebar_width: Number(sidebarWidth) || 260,
        outline_width: Number(outlineWidth) || 260,
        diary_enabled: !!diaryEnabled,
        diary_root: (diaryRoot || '').trim() || 'diary',
      })
    }, 500)
    return () => clearTimeout(timer)
  }, [
    open, editorMaxWidth, editorFontSize, editorLineHeight,
    sidebarWidth, outlineWidth, diaryEnabled, diaryRoot, onSave,
  ])

  const cardStyle: React.CSSProperties = { borderColor: token.colorBorderSecondary }

  const diaryRootDisplay = diaryRoot && diaryRoot.trim() ? diaryRoot.trim() : t('vaultRoot')

  const renderEditorTab = () => (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <Card size="small" style={cardStyle}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <SettingsItem
            title={t('settingsEditorMaxWidth')}
            description={t('settingsEditorMaxWidthTip')}
            extra={
              <InputNumber
                min={0} max={2000} step={20}
                value={editorMaxWidth}
                onChange={(v) => setEditorMaxWidth(v || 0)}
                style={{ width: 120 }}
                addonAfter="px"
              />
            }
          />
          <Divider style={{ margin: '4px 0' }} />
          <SettingsItem
            title={t('settingsEditorFontSize')}
            extra={
              <InputNumber
                min={12} max={24} step={1}
                value={editorFontSize}
                onChange={(v) => setEditorFontSize(v || 15)}
                style={{ width: 120 }}
                addonAfter="px"
              />
            }
          />
          <Divider style={{ margin: '4px 0' }} />
          <SettingsItem
            title={t('settingsEditorLineHeight')}
            extra={
              <InputNumber
                min={1} max={2.5} step={0.1}
                value={editorLineHeight}
                onChange={(v) => setEditorLineHeight(v || 1.7)}
                style={{ width: 120 }}
              />
            }
          />
        </div>
      </Card>

      <Card size="small" style={cardStyle}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <SettingsItem
            title={t('settingsSidebarWidth')}
            extra={
              <InputNumber
                min={180} max={480} step={10}
                value={sidebarWidth}
                onChange={(v) => setSidebarWidth(v || 260)}
                style={{ width: 120 }}
                addonAfter="px"
              />
            }
          />
          <Divider style={{ margin: '4px 0' }} />
          <SettingsItem
            title={t('settingsOutlineWidth')}
            extra={
              <InputNumber
                min={160} max={480} step={10}
                value={outlineWidth}
                onChange={(v) => setOutlineWidth(v || 260)}
                style={{ width: 120 }}
                addonAfter="px"
              />
            }
          />
        </div>
      </Card>
    </div>
  )

  const renderDiaryTab = () => (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <Card size="small" style={cardStyle}>
        <SettingsItem
          title={t('settingsDiaryEnabled')}
          description={t('settingsDiaryEnabledTip')}
          extra={
            <Switch
              checked={diaryEnabled}
              onChange={setDiaryEnabled}
            />
          }
        />
      </Card>

      {diaryEnabled && (
        <Card size="small" style={cardStyle}>
          <SettingsItem
            title={t('settingsDiaryRoot')}
            description={t('settingsDiaryRootTip')}
            extra={
              <Button
                type="text"
                size="small"
                icon={<FolderOpenOutlined />}
                onClick={() => setPickerOpen(true)}
              >
                {t('common.select')}
              </Button>
            }
          />
          <div style={{ marginTop: 8 }}>
            <Input
              readOnly
              placeholder="diary"
              value={diaryRoot ?? ''}
              onClick={() => setPickerOpen(true)}
              style={{ cursor: 'pointer' }}
              suffix={<FolderOpenOutlined style={{ color: token.colorTextTertiary }} />}
            />
            <div style={{ fontSize: 12, color: token.colorTextTertiary, marginTop: 6 }}>
              {t('settingsDiaryRootCurrent', { path: diaryRootDisplay })}
            </div>
          </div>
        </Card>
      )}
    </div>
  )

  const tabItems = [
    {
      key: 'editor',
      label: <span><EditOutlined style={{ marginRight: 4 }} />{t('settingsTabEditor')}</span>,
      children: renderEditorTab(),
    },
    {
      key: 'diary',
      label: <span><BookOutlined style={{ marginRight: 4 }} />{t('settingsTabDiary')}</span>,
      children: renderDiaryTab(),
    },
  ]

  return (
    <Drawer
      title={t('settings')}
      open={open}
      onClose={onClose}
      size={640}
      styles={{ body: { padding: 16, overflow: 'auto' } }}
      destroyOnHidden
    >
      <Tabs
        defaultActiveKey="editor"
        items={tabItems}
        size="small"
        style={{ height: '100%' }}
        tabBarStyle={{ marginBottom: 16 }}
      />

      <FolderPickerModal
        open={pickerOpen}
        tree={tree}
        selected={(diaryRoot || '').trim()}
        onCancel={() => setPickerOpen(false)}
        onOk={(relPath) => {
          setDiaryRoot(relPath)
          setPickerOpen(false)
        }}
      />
    </Drawer>
  )
}

export default NotesSettingsDrawer
