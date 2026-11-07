import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Button, theme, Tooltip, Typography } from 'antd'
import type { GlobalToken } from 'antd'
import {
  CloseOutlined,
  CodeOutlined,
  DownOutlined,
  FolderOutlined,
  FullscreenExitOutlined,
  FullscreenOutlined,
  PlusOutlined,
} from '@ant-design/icons'
import { useTranslation } from 'react-i18next'
import type { WorkspaceFileEntry } from '../../../electron/shared/ipc-channels'
import type { GeneratedFileInfo } from '../../types'
import { useTaskPanelStore, type TaskPanelTab } from '../../stores/task-panel.store'
import WorkspaceFileTree from './WorkspaceFileTree'
import WorkspaceEntryMenu from './WorkspaceEntryMenu'
import TaskTerminal from './TaskTerminal'
import FilePreview, { getFileColor, getFileIcon } from '../workbench/FilePreview'
import { pathToAppFileUrl } from '../../utils/file-url'

const { Text } = Typography

const WIDTH_KEY = 'tasks:workspacePanelWidth'
const MIN_WIDTH = 360
const MAX_WIDTH = 860
const DEFAULT_WIDTH = 420

interface TaskWorkspacePanelProps {
  /** 当前任务的工作区根目录；为空表示尚不可用 */
  rootPath: string | null
  /** 终端会话标识（随任务切换变化） */
  terminalId: string
  /** 任务产物列表（按最新调用倒序、同路径已去重） */
  artifacts?: GeneratedFileInfo[]
  onClose: () => void
}

/** 开始页卡片（参考会话开始页的引导样式） */
const StartCard: React.FC<{
  icon: React.ReactNode
  iconBg: string
  iconColor: string
  title: string
  description: string
  disabled?: boolean
  testId?: string
  onClick: () => void
}> = ({ icon, iconBg, iconColor, title, description, disabled, testId, onClick }) => {
  const { token } = theme.useToken()
  const [hovered, setHovered] = useState(false)
  return (
    <div
      data-testid={testId}
      onClick={disabled ? undefined : onClick}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 12,
        padding: '14px 16px',
        borderRadius: 12,
        background: hovered && !disabled ? token.colorFillTertiary : token.colorFillQuaternary,
        cursor: disabled ? 'not-allowed' : 'pointer',
        opacity: disabled ? 0.55 : 1,
        transform: hovered && !disabled ? 'translateY(-1px)' : 'none',
        boxShadow: hovered && !disabled ? token.boxShadowTertiary : 'none',
        transition: 'all 0.2s',
      }}
    >
      <span style={{
        width: 34,
        height: 34,
        borderRadius: 9,
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        fontSize: 17,
        background: iconBg,
        color: iconColor,
        flexShrink: 0,
      }}>
        {icon}
      </span>
      <div style={{ minWidth: 0 }}>
        <div style={{ fontSize: 13.5, fontWeight: 500, color: token.colorText }}>{title}</div>
        <div style={{ fontSize: 12, color: token.colorTextTertiary, marginTop: 2 }}>{description}</div>
      </div>
    </div>
  )
}

function tabIcon(tab: TaskPanelTab): React.ReactNode {
  if (tab.kind === 'files') return <FolderOutlined />
  if (tab.kind === 'terminal') return <CodeOutlined />
  const file = tab.file
  if (!file) return null
  const IconComp = getFileIcon(file.ext)
  return <IconComp style={{ color: getFileColor(file.ext) }} />
}

/** 均分宽度的标签芯片（参考浏览器式标签：无滚动条，随数量收窄，文本截断） */
const TabChip: React.FC<{
  tab: TaskPanelTab
  title: string
  active: boolean
  token: GlobalToken
  onSelect: () => void
  onClose: () => void
}> = ({ tab, title, active, token, onSelect, onClose }) => {
  const [hovered, setHovered] = useState(false)
  return (
    <div
      onClick={onSelect}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        flex: '1 1 60px',
        minWidth: 0,
        maxWidth: 220,
        height: 28,
        display: 'flex',
        alignItems: 'center',
        gap: 6,
        padding: '0 4px 0 10px',
        borderRadius: 7,
        cursor: 'pointer',
        background: active ? token.colorFillSecondary : hovered ? token.colorFillQuaternary : 'transparent',
        border: `1px solid ${active ? token.colorBorderSecondary : 'transparent'}`,
        transition: 'background 0.15s, border-color 0.15s',
      }}
    >
      <span style={{ fontSize: 12, display: 'inline-flex', flexShrink: 0 }}>{tabIcon(tab)}</span>
      <span
        title={title}
        style={{
          flex: 1,
          minWidth: 0,
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
          fontSize: 12,
          color: active ? token.colorText : token.colorTextSecondary,
        }}
      >
        {title}
      </span>
      <CloseOutlined
        onClick={(event) => { event.stopPropagation(); onClose() }}
        style={{
          fontSize: 9,
          padding: 2,
          flexShrink: 0,
          color: active || hovered ? token.colorTextTertiary : token.colorTextQuaternary,
        }}
      />
    </div>
  )
}

/**
 * 任务右侧工作区面板：多标签（文件树 / 终端 / 多个文件预览）+ 开始页。
 * 标签常驻挂载（仅隐藏），切走再切回不丢终端输出与展开状态。
 */
const TaskWorkspacePanel: React.FC<TaskWorkspacePanelProps> = ({ rootPath, terminalId, artifacts = [], onClose }) => {
  const { token } = theme.useToken()
  const { t } = useTranslation()
  const tabs = useTaskPanelStore((s) => s.tabs)
  const activeTabId = useTaskPanelStore((s) => s.activeTabId)
  const expanded = useTaskPanelStore((s) => s.expanded)
  const openView = useTaskPanelStore((s) => s.openView)
  const openPreview = useTaskPanelStore((s) => s.openPreview)
  const goStart = useTaskPanelStore((s) => s.goStart)
  const setActiveTab = useTaskPanelStore((s) => s.setActiveTab)
  const closeTab = useTaskPanelStore((s) => s.closeTab)
  const toggleExpanded = useTaskPanelStore((s) => s.toggleExpanded)

  const [refreshKey, setRefreshKey] = useState(0)
  const refresh = useCallback(() => setRefreshKey((value) => value + 1), [])
  const [artifactsCollapsed, setArtifactsCollapsed] = useState(false)
  const [missingPaths, setMissingPaths] = useState<Set<string>>(new Set())

  // 产物可能已被 agent / 用户移除：探测后仍展示，但加删除线并禁止打开
  useEffect(() => {
    if (artifacts.length === 0) {
      setMissingPaths((prev) => (prev.size === 0 ? prev : new Set()))
      return
    }
    let cancelled = false
    Promise.all(artifacts.map(async (file): Promise<[string, boolean]> => {
      try {
        const res = await fetch(pathToAppFileUrl(file.path), { method: 'HEAD' })
        return [file.path, res.ok]
      } catch {
        return [file.path, false]
      }
    })).then((results) => {
      if (cancelled) return
      const missing = new Set<string>()
      for (const [path, ok] of results) if (!ok) missing.add(path)
      setMissingPaths(missing)
    })
    return () => { cancelled = true }
  }, [artifacts, refreshKey])

  // 每次切到文件标签时自动刷新，保证看到 agent / 终端刚写入的产物
  const prevActiveRef = useRef<string | null>(null)
  useEffect(() => {
    const wasFiles = tabs.some((tab) => tab.id === prevActiveRef.current && tab.kind === 'files')
    const isFiles = tabs.some((tab) => tab.id === activeTabId && tab.kind === 'files')
    if (!wasFiles && isFiles) refresh()
    prevActiveRef.current = activeTabId
  }, [activeTabId, tabs, refresh])

  useEffect(() => { refresh() }, [rootPath, refresh])

  const [width, setWidth] = useState<number>(() => {
    try {
      const saved = Number(localStorage.getItem(WIDTH_KEY))
      if (Number.isFinite(saved) && saved >= MIN_WIDTH && saved <= MAX_WIDTH) return saved
    } catch {}
    return DEFAULT_WIDTH
  })
  const [resizing, setResizing] = useState(false)
  const panelRef = useRef<HTMLDivElement>(null)
  const widthRef = useRef(width)
  useEffect(() => { widthRef.current = width }, [width])

  useEffect(() => {
    if (!resizing) return
    const onMouseMove = (event: MouseEvent) => {
      const right = panelRef.current?.getBoundingClientRect().right ?? window.innerWidth
      setWidth(Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, Math.round(right - event.clientX))))
    }
    const onMouseUp = () => {
      setResizing(false)
      try { localStorage.setItem(WIDTH_KEY, String(widthRef.current)) } catch {}
    }
    document.addEventListener('mousemove', onMouseMove)
    document.addEventListener('mouseup', onMouseUp)
    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'
    return () => {
      document.removeEventListener('mousemove', onMouseMove)
      document.removeEventListener('mouseup', onMouseUp)
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
    }
  }, [resizing])

  const handleOpenFile = useCallback((entry: WorkspaceFileEntry) => {
    openPreview({ path: entry.path, name: entry.name, ext: entry.ext, size: entry.size, mtime: entry.mtime })
  }, [openPreview])

  const tabTitle = useCallback((tab: TaskPanelTab) => {
    if (tab.kind === 'files') return t('workbench.startFilesTitle')
    if (tab.kind === 'terminal') return t('workbench.startTerminalTitle')
    return tab.file?.name || ''
  }, [t])

  const viewStyle = (active: boolean): React.CSSProperties => ({
    position: 'absolute',
    inset: 0,
    display: active ? 'flex' : 'none',
    flexDirection: 'column',
    minHeight: 0,
  })

  const startPage = (
    <div style={viewStyle(activeTabId === null)}>
      <div style={{
        flex: 1,
        display: 'flex',
        flexDirection: 'column',
        padding: 24,
        overflowY: 'auto',
      }}>
        <div style={{ width: '100%', maxWidth: 320, margin: 'auto', display: 'flex', flexDirection: 'column', gap: 10 }}>
          <StartCard
            icon={<FolderOutlined />}
            iconBg={token.colorWarningBg}
            iconColor={token.colorWarning}
            title={t('workbench.startFilesTitle')}
            description={t('workbench.startFilesDesc')}
            disabled={!rootPath}
            testId="workspace-start-files"
            onClick={() => openView('files')}
          />
          <StartCard
            icon={<CodeOutlined />}
            iconBg={token.colorPrimaryBg}
            iconColor={token.colorPrimary}
            title={t('workbench.startTerminalTitle')}
            description={t('workbench.startTerminalDesc')}
            disabled={!rootPath}
            testId="workspace-start-terminal"
            onClick={() => openView('terminal')}
          />
          {!rootPath && (
            <Text type="secondary" style={{ fontSize: 12, textAlign: 'center', marginTop: 4 }}>
              {t('workbench.panelNoWorkspace')}
            </Text>
          )}
          {artifacts.length > 0 && (
            <div style={{ marginTop: 10, paddingTop: 2 }}>
              <div
                onClick={() => setArtifactsCollapsed(value => !value)}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 6,
                  padding: '2px 4px',
                  cursor: 'pointer',
                  userSelect: 'none',
                  fontSize: 12.5,
                  fontWeight: 500,
                  color: token.colorTextSecondary,
                }}
              >
                <span>{t('workbench.artifacts')} ({artifacts.length})</span>
                <DownOutlined style={{
                  fontSize: 10,
                  color: token.colorTextTertiary,
                  transform: artifactsCollapsed ? 'rotate(-90deg)' : 'none',
                  transition: 'transform 0.15s',
                }} />
              </div>
              <div style={{
                display: artifactsCollapsed ? 'none' : 'flex',
                flexDirection: 'column',
                gap: 1,
                marginTop: 4,
                maxHeight: 260,
                overflowY: 'auto',
              }}>
                {artifacts.map(file => {
                  const IconComp = getFileIcon(file.ext)
                  const isMissing = missingPaths.has(file.path)
                  return (
                    <WorkspaceEntryMenu
                      key={file.path}
                      path={file.path}
                      missing={isMissing}
                      onPreview={() => openPreview(file)}
                    >
                      <div
                        title={file.path}
                        data-testid="workspace-artifact"
                        data-path={file.path}
                        onClick={isMissing ? undefined : () => openPreview(file)}
                        onMouseEnter={(event) => { event.currentTarget.style.background = token.colorBgTextHover }}
                        onMouseLeave={(event) => { event.currentTarget.style.background = 'transparent' }}
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          gap: 8,
                          padding: '5px 6px',
                          borderRadius: 6,
                          cursor: isMissing ? 'not-allowed' : 'pointer',
                          minWidth: 0,
                          opacity: isMissing ? 0.75 : 1,
                          transition: 'background 0.15s',
                        }}
                      >
                        <IconComp style={{
                          color: getFileColor(file.ext),
                          fontSize: 16,
                          flexShrink: 0,
                          opacity: isMissing ? 0.5 : 1,
                        }} />
                        <span style={{
                          flex: 1,
                          minWidth: 0,
                          fontSize: 13,
                          color: isMissing ? token.colorTextTertiary : token.colorText,
                          textDecoration: isMissing ? 'line-through' : undefined,
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                          whiteSpace: 'nowrap',
                        }}>
                          {file.name}
                        </span>
                        {isMissing && (
                          <span style={{
                            fontSize: 11,
                            fontWeight: 500,
                            color: token.colorError,
                            flexShrink: 0,
                            whiteSpace: 'nowrap',
                          }}>
                            {t('workbench.fileDeleted')}
                          </span>
                        )}
                      </div>
                    </WorkspaceEntryMenu>
                  )
                })}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  )

  const tabStrip = useMemo(() => (
    <div style={{ display: 'flex', alignItems: 'center', gap: 3, flex: 1, minWidth: 0, overflow: 'hidden' }}>
      {tabs.map((tab) => (
        <TabChip
          key={tab.id}
          tab={tab}
          title={tabTitle(tab)}
          active={tab.id === activeTabId}
          token={token}
          onSelect={() => setActiveTab(tab.id)}
          onClose={() => closeTab(tab.id)}
        />
      ))}
    </div>
  ), [tabs, activeTabId, setActiveTab, closeTab, tabTitle, token])

  return (
    <div
      ref={panelRef}
      className="wa-workspace-panel"
      data-testid="workspace-panel"
      style={{
        width: expanded ? undefined : width,
        flex: expanded ? 1 : undefined,
        flexShrink: expanded ? undefined : 0,
        display: 'flex',
        flexDirection: 'column',
        minHeight: 0,
        borderLeft: expanded ? 'none' : `1px solid ${token.colorBorderSecondary}`,
        background: 'transparent',
        position: 'relative',
      }}
    >
      {/* 左侧拖拽调宽（全屏模式下禁用） */}
      {!expanded && (
        <div
          onMouseDown={(event) => { event.preventDefault(); setResizing(true) }}
          style={{
            position: 'absolute',
            left: -3,
            top: 0,
            bottom: 0,
            width: 6,
            cursor: 'col-resize',
            zIndex: 10,
          }}
        />
      )}

      {/* 顶栏：标签条（空时显示面板标题）+ 新标签页 / 全屏 / 关闭 */}
      <div style={{
        display: 'flex',
        alignItems: 'center',
        gap: 4,
        padding: '6px 8px 6px 10px',
        borderBottom: `1px solid ${token.colorBorderSecondary}`,
        flexShrink: 0,
        minHeight: 40,
      }}>
        {tabs.length > 0
          ? tabStrip
          : (
            <Text
              type="secondary"
              style={{ flex: 1, minWidth: 0, fontSize: 12.5, fontWeight: 500, padding: '0 10px' }}
              ellipsis={{ tooltip: t('workbench.panelStartTitle') }}
            >
              {t('workbench.panelStartTitle')}
            </Text>
          )}
        <Tooltip title={t('workbench.panelHome')}>
          <Button
            type="text"
            size="small"
            icon={<PlusOutlined style={{ fontSize: 13 }} />}
            onClick={goStart}
            style={{ width: 24, height: 24, minWidth: 24, color: token.colorTextSecondary, flexShrink: 0 }}
          />
        </Tooltip>
        <Tooltip title={expanded ? t('workbench.panelRestore') : t('workbench.panelExpand')}>
          <Button
            type="text"
            size="small"
            icon={expanded
              ? <FullscreenExitOutlined style={{ fontSize: 13 }} />
              : <FullscreenOutlined style={{ fontSize: 13 }} />}
            onClick={toggleExpanded}
            style={{ width: 24, height: 24, minWidth: 24, color: token.colorTextSecondary, flexShrink: 0 }}
          />
        </Tooltip>
        <Tooltip title={t('workbench.closePanel')}>
          <Button
            type="text"
            size="small"
            icon={<CloseOutlined style={{ fontSize: 12 }} />}
            onClick={onClose}
            style={{ width: 24, height: 24, minWidth: 24, color: token.colorTextSecondary, flexShrink: 0 }}
          />
        </Tooltip>
      </div>

      <div style={{ flex: 1, minHeight: 0, position: 'relative' }}>
        {startPage}
        {tabs.map((tab) => {
          const active = tab.id === activeTabId
          return (
            <div key={tab.id} style={viewStyle(active)}>
              {tab.kind === 'files' && (
                <>
                  <div style={{ padding: '10px 12px 4px', flexShrink: 0, display: 'flex', alignItems: 'center', gap: 5 }}>
                    <FolderOutlined style={{ fontSize: 11, color: token.colorTextQuaternary, flexShrink: 0 }} />
                    <Text type="secondary" style={{ fontSize: 11 }} ellipsis={{ tooltip: rootPath || '' }}>
                      {rootPath || t('workbench.workspaceNotSet')}
                    </Text>
                  </div>
                  {rootPath
                    ? <WorkspaceFileTree rootPath={rootPath} refreshKey={refreshKey} onOpenFile={handleOpenFile} />
                    : (
                      <Text type="secondary" style={{ fontSize: 12, padding: '12px 10px' }}>
                        {t('workbench.panelNoWorkspace')}
                      </Text>
                    )}
                </>
              )}
              {tab.kind === 'terminal' && (rootPath
                ? (
                  <TaskTerminal
                    key={terminalId}
                    terminalId={terminalId}
                    rootPath={rootPath}
                    active={active}
                    onCommandFinished={refresh}
                  />
                )
                : (
                  <Text type="secondary" style={{ fontSize: 12, padding: '12px 10px' }}>
                    {t('workbench.panelNoWorkspace')}
                  </Text>
                ))}
              {tab.kind === 'preview' && tab.file && (
                <FilePreview file={tab.file} />
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}

/** 产物列表按内容比较：流式期间父组件每次刷新都会生成新数组，引用比较会失效 */
const sameArtifacts = (a?: GeneratedFileInfo[], b?: GeneratedFileInfo[]): boolean => {
  if (a === b) return true
  if (!a || !b || a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) {
    if (a[i].path !== b[i].path || a[i].name !== b[i].name) return false
  }
  return true
}

// 流式输出期间聊天区高频更新，面板与文件树/终端无需跟着重渲染
export default memo(TaskWorkspacePanel, (prev, next) =>
  prev.rootPath === next.rootPath &&
  prev.terminalId === next.terminalId &&
  prev.onClose === next.onClose &&
  sameArtifacts(prev.artifacts, next.artifacts)
)
