import { useEffect, useState } from 'react'
import { Spin, theme, Typography } from 'antd'
import { DownOutlined, FolderOutlined, RightOutlined } from '@ant-design/icons'
import { useTranslation } from 'react-i18next'
import type { WorkspaceFileEntry } from '../../../electron/shared/ipc-channels'
import { useTaskPanelStore } from '../../stores/task-panel.store'
import { getFileColor, getFileIcon } from '../workbench/FilePreview'
import WorkspaceEntryMenu from './WorkspaceEntryMenu'

const { Text } = Typography

const INDENT = 14

const rowStyle = (hovered: boolean, token: { colorFillTertiary: string }): React.CSSProperties => ({
  display: 'flex',
  alignItems: 'center',
  gap: 7,
  height: 28,
  paddingLeft: 10,
  paddingRight: 8,
  margin: '0 4px',
  borderRadius: 6,
  cursor: 'pointer',
  background: hovered ? token.colorFillTertiary : 'transparent',
  transition: 'background 0.15s',
})

const FileRow: React.FC<{
  entry: WorkspaceFileEntry
  depth: number
  onOpenFile: (entry: WorkspaceFileEntry) => void
}> = ({ entry, depth, onOpenFile }) => {
  const { token } = theme.useToken()
  const [hovered, setHovered] = useState(false)
  const IconComp = getFileIcon(entry.ext)
  return (
    <WorkspaceEntryMenu path={entry.path} onPreview={() => onOpenFile(entry)}>
      <div
        onClick={() => onOpenFile(entry)}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
        style={{ ...rowStyle(hovered, token), paddingLeft: 10 + depth * INDENT }}
      >
        <IconComp style={{ fontSize: 13, color: getFileColor(entry.ext), flexShrink: 0 }} />
        <Text style={{ fontSize: 12.5, minWidth: 0, flex: 1 }} ellipsis={{ tooltip: entry.path }}>
          {entry.name}
        </Text>
      </div>
    </WorkspaceEntryMenu>
  )
}

const DirectoryNode: React.FC<{
  entry: WorkspaceFileEntry
  depth: number
  refreshKey: number
  onOpenFile: (entry: WorkspaceFileEntry) => void
}> = ({ entry, depth, refreshKey, onOpenFile }) => {
  const { token } = theme.useToken()
  const expanded = useTaskPanelStore((s) => !!s.expandedDirs[entry.path])
  const toggleDirExpanded = useTaskPanelStore((s) => s.toggleDirExpanded)
  const [hovered, setHovered] = useState(false)
  return (
    <>
      <WorkspaceEntryMenu path={entry.path} isDirectory>
        <div
          onClick={() => toggleDirExpanded(entry.path)}
          onMouseEnter={() => setHovered(true)}
          onMouseLeave={() => setHovered(false)}
          style={{ ...rowStyle(hovered, token), paddingLeft: 6 + depth * INDENT }}
        >
          {expanded
            ? <DownOutlined style={{ fontSize: 9, color: token.colorTextTertiary, flexShrink: 0 }} />
            : <RightOutlined style={{ fontSize: 9, color: token.colorTextTertiary, flexShrink: 0 }} />}
          <FolderOutlined style={{ fontSize: 13, color: token.colorWarning, flexShrink: 0 }} />
          <Text style={{ fontSize: 12.5, minWidth: 0, flex: 1 }} ellipsis={{ tooltip: entry.path }}>
            {entry.name}
          </Text>
        </div>
      </WorkspaceEntryMenu>
      {expanded && (
        <DirectoryLevel
          dirPath={entry.path}
          depth={depth + 1}
          refreshKey={refreshKey}
          onOpenFile={onOpenFile}
        />
      )}
    </>
  )
}

/** 单层目录：挂载时读取，refreshKey 变化时重新读取（展开状态由父级保持） */
const DirectoryLevel: React.FC<{
  dirPath: string
  depth: number
  refreshKey: number
  onOpenFile: (entry: WorkspaceFileEntry) => void
  emptyHint?: string
}> = ({ dirPath, depth, refreshKey, onOpenFile, emptyHint }) => {
  const [loading, setLoading] = useState(true)
  const [entries, setEntries] = useState<WorkspaceFileEntry[]>([])
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    window.electronAPI.workspace.listFiles({ dirPath })
      .then((result) => {
        if (cancelled) return
        setEntries(result.success ? result.entries : [])
        setError(result.success ? null : (result.error || 'load-failed'))
      })
      .catch((err) => {
        if (cancelled) return
        setEntries([])
        setError(String(err?.message || err))
      })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [dirPath, refreshKey])

  if (loading) {
    return (
      <div style={{ paddingLeft: 8 + depth * INDENT, paddingTop: 4, paddingBottom: 4 }}>
        <Spin size="small" />
      </div>
    )
  }
  if (error) {
    return (
      <div style={{ paddingLeft: 8 + depth * INDENT, paddingTop: 2, paddingBottom: 2 }}>
        <Text type="danger" style={{ fontSize: 12 }}>{error}</Text>
      </div>
    )
  }
  if (entries.length === 0) {
    return emptyHint
      ? <Text type="secondary" style={{ fontSize: 12, padding: '8px 10px', display: 'block' }}>{emptyHint}</Text>
      : null
  }

  return (
    <>
      {entries.map((entry) => entry.isDirectory ? (
        <DirectoryNode
          key={entry.path}
          entry={entry}
          depth={depth}
          refreshKey={refreshKey}
          onOpenFile={onOpenFile}
        />
      ) : (
        <FileRow key={entry.path} entry={entry} depth={depth} onOpenFile={onOpenFile} />
      ))}
    </>
  )
}

interface WorkspaceFileTreeProps {
  rootPath: string
  /** 变化时重新读取各层目录（刷新按钮 / 命令执行结束） */
  refreshKey: number
  onOpenFile: (entry: WorkspaceFileEntry) => void
}

/** 任务工作区文件树：逐层懒加载，目录优先排序由主进程保证 */
const WorkspaceFileTree: React.FC<WorkspaceFileTreeProps> = ({ rootPath, refreshKey, onOpenFile }) => {
  const { t } = useTranslation()
  return (
    <div style={{ flex: 1, minHeight: 0, overflow: 'auto', padding: '2px 4px 12px' }}>
      <DirectoryLevel
        dirPath={rootPath}
        depth={0}
        refreshKey={refreshKey}
        onOpenFile={onOpenFile}
        emptyHint={t('workbench.panelNoFiles')}
      />
    </div>
  )
}

export default WorkspaceFileTree
