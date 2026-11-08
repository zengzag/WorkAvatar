import { memo, useState, useMemo, useCallback, useRef, useEffect, startTransition } from 'react'
import { Input, Button, Typography, Empty, theme, Dropdown, Tooltip, Checkbox, Spin } from 'antd'
import type { MenuProps, InputRef } from 'antd'
import {
  PlusOutlined,
  SearchOutlined,
  DeleteOutlined,
  EditOutlined,
  ExportOutlined,
  RobotOutlined,
  ThunderboltOutlined,
  BulbOutlined,
  CheckSquareOutlined,
  CloseOutlined,
  MenuFoldOutlined,
  UnorderedListOutlined,
  TeamOutlined,
  CaretRightOutlined,
  DownOutlined,
  FolderOutlined,
  WarningFilled,
} from '@ant-design/icons'
import { useTranslation } from 'react-i18next'
import dayjs from 'dayjs'
import type { Conversation } from '../../types'
import { getDirName } from '../../utils/format'
import { useLiquidGlass } from '../../hooks/useLiquidGlass'

const { Text } = Typography

const SIDEBAR_WIDTH_KEY = 'tasks:sidebarWidth'

/** 任务列表视图：列表（按时间分组）/ 员工分组 / 工作区分组 */
export type TaskViewMode = 'list' | 'employee' | 'workspace'

type TaskGroupKey = 'today' | 'yesterday' | 'week' | 'earlier'

/** 任务按最后活跃时间分组：今日 / 昨天 / 本周（周一起算）/ 更早 */
function getTaskTimeGroup(ts: string | number | null | undefined): TaskGroupKey {
  if (!ts) return 'earlier'
  // 时间戳统一按秒存储，转换为毫秒后再交给 dayjs
  const d = typeof ts === 'number' ? dayjs(ts < 1e12 ? ts * 1000 : ts) : dayjs(ts)
  if (!d.isValid()) return 'earlier'
  const now = dayjs()
  if (!d.isBefore(now.startOf('day'))) return 'today'
  if (!d.isBefore(now.subtract(1, 'day').startOf('day'))) return 'yesterday'
  const weekday = (now.day() + 6) % 7
  const weekStart = now.startOf('day').subtract(weekday, 'day')
  return d.isBefore(weekStart) ? 'earlier' : 'week'
}

const SIDEBAR_MIN_WIDTH = 200
const SIDEBAR_MAX_WIDTH = 560
const SIDEBAR_DEFAULT_WIDTH = 260

/** 员工分组视图下每组默认展示的任务数，超出部分点击「显示更多」分批展开 */
const GROUP_PAGE_SIZE = 5
/** 每次点击「显示更多」追加展示的任务数 */
const GROUP_PAGE_STEP = 20

export interface TaskWithEmployee extends Conversation {
  employee_name: string
}

interface TaskSidebarProps {
  tasks: TaskWithEmployee[]
  activeTaskId: string | null
  searchQuery: string
  onSearchChange: (query: string) => void
  /** 回车提交：触发全文内容检索 */
  onSearchSubmit?: (query: string) => void
  /** 是否已提交过全文检索（用于提示"当前仅匹配标题"） */
  contentSearched?: boolean
  viewMode: TaskViewMode
  onViewModeChange: (mode: TaskViewMode) => void
  onSelect: (taskId: string) => void
  onDelete: (taskId: string) => void
  onDeleteMany?: (taskIds: string[]) => void
  onNewTask: () => void
  onCollapse?: () => void
  onExport?: (taskId: string) => void
  onGenerateTitle?: (taskId: string) => void
  onRename?: (taskId: string, newTitle: string) => Promise<boolean> | boolean
  onExtractMemory?: (taskId: string) => void
  isTaskStreaming?: (taskId: string) => boolean
  /** 每个任务待处理的确认请求数，用于列表内的「待确认」角标 */
  pendingRequestCounts?: Record<string, number>
  // 增量加载
  hasMore?: boolean
  loadingMore?: boolean
  onLoadMore?: () => void
}

export const formatTaskTime = (timestamp: number | null, t: (key: string, options?: Record<string, any>) => string): string => {
  if (!timestamp) return ''
  const now = dayjs()
  const time = dayjs(timestamp * 1000)
  const diffMin = now.diff(time, 'minute')
  if (diffMin < 1) return t('workbench.justNow')
  if (diffMin < 60) return t('workbench.minutesAgo', { count: diffMin })
  if (now.isSame(time, 'day')) return time.format('HH:mm')
  if (now.subtract(1, 'day').isSame(time, 'day')) return t('workbench.yesterday')
  if (now.isSame(time, 'year')) return t('workbench.monthDay', { month: time.month() + 1, day: time.date() })
  return time.format('YYYY/M/D')
}

/** 搜索提交防抖时长：停止输入后再触发标题检索与列表过滤 */
const SEARCH_DEBOUNCE_MS = 250

const noop = () => {}

/**
 * 搜索输入框：本地维护输入值并防抖提交标题检索。
 * 输入过程只重渲染这个小组件，不触发整页（含对话区）重渲染；
 * 提交时用 startTransition 标记为低优先级，避免长列表/流式输出阻塞按键。
 * 全文内容检索成本高（主进程同步 FTS + LIKE 兜底），只在回车或点击搜索图标时触发。
 */
const DebouncedSearchInput = memo(({
  value,
  onChange,
  onSubmit,
  placeholder,
  submitHint,
  token,
}: {
  value: string
  onChange: (query: string) => void
  onSubmit: (query: string) => void
  placeholder: string
  submitHint: string
  token: any
}) => {
  const [local, setLocal] = useState(value)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const onChangeRef = useRef(onChange)
  const onSubmitRef = useRef(onSubmit)

  useEffect(() => { onChangeRef.current = onChange }, [onChange])
  useEffect(() => { onSubmitRef.current = onSubmit }, [onSubmit])
  // 外部重置（如清空筛选）时同步本地值
  useEffect(() => { setLocal(value) }, [value])
  useEffect(() => () => { if (timerRef.current) clearTimeout(timerRef.current) }, [])

  const commit = useCallback((next: string, immediate = false) => {
    if (timerRef.current) clearTimeout(timerRef.current)
    const run = () => startTransition(() => onChangeRef.current(next))
    if (immediate) {
      run()
    } else {
      timerRef.current = setTimeout(run, SEARCH_DEBOUNCE_MS)
    }
  }, [])

  const submit = useCallback((next: string) => {
    if (timerRef.current) clearTimeout(timerRef.current)
    startTransition(() => {
      onChangeRef.current(next)
      onSubmitRef.current(next)
    })
  }, [])

  const handleChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const next = e.target.value
    setLocal(next)
    commit(next)
  }, [commit])

  const handleKeyDown = useCallback((e: React.KeyboardEvent<HTMLInputElement>) => {
    // 输入法组词中的回车只用于选词，不触发检索
    if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
      e.preventDefault()
      submit(local)
    }
  }, [local, submit])

  const handleClear = useCallback(() => {
    setLocal('')
    commit('', true)
  }, [commit])

  return (
    <>
      <Tooltip title={submitHint}>
        <SearchOutlined
          onClick={() => submit(local)}
          style={{ color: token.colorTextQuaternary, fontSize: 12, flexShrink: 0, cursor: 'pointer' }}
        />
      </Tooltip>
      <input
        placeholder={placeholder}
        value={local}
        onChange={handleChange}
        onKeyDown={handleKeyDown}
        style={{
          flex: 1,
          height: '100%',
          border: 'none',
          outline: 'none',
          background: 'transparent',
          fontSize: 12,
          padding: '0 6px',
          color: token.colorText,
          minWidth: 0,
        }}
      />
      {local && (
        <Button
          type="text"
          size="small"
          icon={<CloseOutlined style={{ fontSize: 10 }} />}
          onClick={handleClear}
          style={{
            flexShrink: 0,
            width: 18,
            height: 18,
            minWidth: 18,
            padding: 0,
            color: token.colorTextQuaternary,
          }}
        />
      )}
    </>
  )
})

const TaskItem = memo(({
  task,
  active,
  streaming,
  pendingRequests = 0,
  onSelect,
  onDelete,
  onExport,
  onGenerateTitle,
  onRename,
  onExtractMemory,
  selectionMode,
  selected,
  onToggleSelect,
  t,
  token,
}: {
  task: TaskWithEmployee
  active: boolean
  streaming: boolean
  /** 待处理确认请求数（0 时不展示角标） */
  pendingRequests?: number
  onSelect: (id: string) => void
  onDelete: (id: string) => void
  onExport?: (id: string) => void
  onGenerateTitle?: (id: string) => void
  onRename?: (id: string, newTitle: string) => Promise<boolean> | boolean
  onExtractMemory?: (id: string) => void
  selectionMode?: boolean
  selected?: boolean
  onToggleSelect?: (id: string) => void
  t: (key: string, options?: any) => string
  token: any
}) => {
  const [hovered, setHovered] = useState(false)
  const [isEditing, setIsEditing] = useState(false)
  const [editValue, setEditValue] = useState('')
  const [deleteConfirm, setDeleteConfirm] = useState(false)
  const editInputRef = useRef<InputRef>(null)

  useEffect(() => {
    if (isEditing && editInputRef.current) {
      editInputRef.current.focus()
      editInputRef.current.select()
    }
  }, [isEditing])

  const startEdit = useCallback((e?: React.MouseEvent) => {
    e?.stopPropagation()
    setEditValue(task.title || '')
    setIsEditing(true)
  }, [task.title])

  const saveEdit = useCallback(async () => {
    const newTitle = editValue.trim()
    if (!newTitle) {
      setIsEditing(false)
      return
    }
    if (onRename) {
      const success = await onRename(task.id, newTitle)
      if (success !== false) {
        setIsEditing(false)
      }
    } else {
      setIsEditing(false)
    }
  }, [editValue, onRename, task.id])

  const cancelEdit = useCallback(() => {
    setIsEditing(false)
  }, [])

  const handleEditKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      saveEdit()
    } else if (e.key === 'Escape') {
      e.preventDefault()
      cancelEdit()
    }
    e.stopPropagation()
  }, [saveEdit, cancelEdit])

  const handleDeleteClick = useCallback((e?: React.MouseEvent) => {
    e?.stopPropagation()
    setDeleteConfirm(true)
  }, [])

  const confirmDelete = useCallback((e?: React.MouseEvent) => {
    e?.stopPropagation()
    onDelete(task.id)
    setDeleteConfirm(false)
  }, [onDelete, task.id])

  const cancelDeleteConfirm = useCallback(() => {
    setDeleteConfirm(false)
  }, [])

  const contextMenuItems = useMemo<MenuProps['items']>(() => {
    const items: NonNullable<MenuProps['items']>[number][] = [
      { key: 'generateTitle', label: t('common.generateTitle'), icon: <ThunderboltOutlined /> },
      { key: 'rename', label: t('common.rename'), icon: <EditOutlined /> },
    ]
    if (onExtractMemory) {
      items.push({ key: 'extractMemory', label: t('common.extractMemory'), icon: <BulbOutlined /> })
    }
    if (onExport) {
      items.push({ key: 'export', label: t('workbench.exportConversation'), icon: <ExportOutlined /> })
    }
    items.push({ type: 'divider' })
    items.push({ key: 'delete', label: t('common.delete'), icon: <DeleteOutlined />, danger: true })
    return items
  }, [t, onExport, onExtractMemory])

  const handleMenuClick = useCallback((info: { key: string }) => {
    if (info.key === 'delete') {
      handleDeleteClick()
      return
    }
    if (info.key === 'generateTitle' && onGenerateTitle) onGenerateTitle(task.id)
    if (info.key === 'rename') startEdit()
    if (info.key === 'extractMemory' && onExtractMemory) onExtractMemory(task.id)
    if (info.key === 'export' && onExport) onExport(task.id)
  }, [task.id, onGenerateTitle, startEdit, onExtractMemory, onExport, handleDeleteClick])

  return (
    <Dropdown
      menu={{
        items: contextMenuItems,
        onClick: handleMenuClick,
      }}
      trigger={['contextMenu']}
      open={selectionMode ? false : undefined}
    >
      <div
        data-testid="task-item"
        data-task-id={task.id}
        data-task-title={task.title || ''}
        className={`wa-task-item${active && !selectionMode ? ' is-active' : ''}${selected ? ' is-selected' : ''}`}
        onClick={(e) => {
          e.stopPropagation()
          if (selectionMode) {
            onToggleSelect?.(task.id)
            return
          }
          if (!isEditing && !active) onSelect(task.id)
        }}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => { setHovered(false); setDeleteConfirm(false) }}
        onDoubleClick={(e) => { if (!selectionMode) startEdit(e) }}
        style={{
          padding: '7px 9px',
          cursor: isEditing ? 'text' : 'pointer',
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          position: 'relative',
        }}
      >
        {selectionMode && (
          <div style={{ flexShrink: 0 }} onClick={(e) => e.stopPropagation()}>
            <Checkbox
              checked={!!selected}
              onChange={() => onToggleSelect?.(task.id)}
              style={{ pointerEvents: 'auto' }}
            />
          </div>
        )}
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, height: 21 }}>
            {streaming && (
              <span style={{
                width: 6, height: 6, borderRadius: '50%',
                background: token.colorPrimary, flexShrink: 0,
                boxShadow: `0 0 0 3px ${token.colorPrimaryBg}`,
                animation: 'pulse 1.5s infinite',
              }} />
            )}
            {isEditing ? (
              <Input
                ref={editInputRef}
                value={editValue}
                data-testid="task-rename-input"
                onChange={(e) => setEditValue(e.target.value)}
                onKeyDown={handleEditKeyDown}
                onBlur={saveEdit}
                size="small"
                variant="filled"
                onClick={(e) => e.stopPropagation()}
                style={{ flex: 1, minWidth: 0, fontSize: 13, padding: '0 8px', height: 24, borderRadius: 7 }}
              />
            ) : (
              <Text
                strong={active}
                ellipsis
                style={{
                  fontSize: 13,
                  flex: 1,
                  minWidth: 0,
                  color: token.colorText,
                  letterSpacing: active ? '-0.005em' : undefined,
                }}
              >
                {task.title || t('workbench.untitledConv')}
              </Text>
            )}
          </div>
          {!isEditing && (
            <div style={{
              display: 'flex',
              alignItems: 'center',
              gap: 5,
              marginTop: 1,
              paddingLeft: streaming ? 12 : 0,
              fontSize: 11,
              color: token.colorTextTertiary,
              minWidth: 0,
            }}>
              {task.employee_name && (
                <>
                  <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0 }}>
                    {task.employee_name}
                  </span>
                  <span style={{ flexShrink: 0 }}>·</span>
                </>
              )}
              <span style={{ flexShrink: 0, fontVariantNumeric: 'tabular-nums' }}>
                {formatTaskTime(task.last_message_at ?? task.created_at, t)}
              </span>
              {pendingRequests > 0 && (
                <span style={{
                  flexShrink: 0,
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 3,
                  padding: '0 5px',
                  borderRadius: 999,
                  fontSize: 10,
                  lineHeight: '16px',
                  color: token.colorWarning,
                  background: token.colorWarningBg,
                }}>
                  <WarningFilled style={{ fontSize: 9 }} />
                  {t('interaction.pendingBadge')}
                </span>
              )}
            </div>
          )}
        </div>
        {hovered && !isEditing && !selectionMode && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 1, flexShrink: 0 }}>
            {!deleteConfirm && (
              <Button
                type="text"
                size="small"
                icon={<EditOutlined style={{ fontSize: 12 }} />}
                data-testid="task-rename"
                onClick={(e) => startEdit(e)}
                title={t('common.rename')}
                style={{ color: token.colorTextTertiary, padding: 0, width: 20, height: 20, minWidth: 20 }}
              />
            )}
            {deleteConfirm ? (
              <>
                <Button
                  type="text"
                  size="small"
                  onClick={(e) => confirmDelete(e)}
                  data-testid="task-delete-confirm"
                  title={t('common.confirm')}
                  danger
                  style={{ padding: '0 4px', width: 'auto', height: 20, minWidth: 20, fontSize: 12 }}
                >
                  {t('common.confirm')}
                </Button>
                <Button
                  type="text"
                  size="small"
                  onClick={() => cancelDeleteConfirm()}
                  data-testid="task-delete-cancel"
                  title={t('common.cancel')}
                  style={{ color: token.colorTextTertiary, padding: 0, width: 20, height: 20, minWidth: 20 }}
                >
                  <CloseOutlined style={{ fontSize: 12 }} />
                </Button>
              </>
            ) : (
              <Button
                type="text"
                size="small"
                icon={<DeleteOutlined style={{ fontSize: 12 }} />}
                data-testid="task-delete"
                onClick={(e) => handleDeleteClick(e)}
                title={t('common.delete')}
                style={{ color: token.colorTextTertiary, padding: 0, width: 20, height: 20, minWidth: 20 }}
              />
            )}
          </div>
        )}
      </div>
    </Dropdown>
  )
})

const TaskSidebar: React.FC<TaskSidebarProps> = ({
  tasks,
  activeTaskId,
  searchQuery,
  onSearchChange,
  onSearchSubmit,
  contentSearched,
  viewMode,
  onViewModeChange,
  onSelect,
  onDelete,
  onDeleteMany,
  onNewTask,
  onCollapse,
  onExport,
  onGenerateTitle,
  onRename,
  onExtractMemory,
  isTaskStreaming,
  pendingRequestCounts,
  hasMore,
  loadingMore,
  onLoadMore,
}) => {
  const { t } = useTranslation()
  const { token } = theme.useToken()
  const [viewMenuVisible, setViewMenuVisible] = useState(false)
  /** 员工分组视图下已折叠的员工分组 */
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set())
  /** 员工分组视图下各分组当前展示条数（默认 5，每次「显示更多」+20） */
  const [groupLimits, setGroupLimits] = useState<Record<string, number>>({})
  const [selectionMode, setSelectionMode] = useState(false)
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  const scrollContainerRef = useRef<HTMLDivElement>(null)
  const glassRef = useLiquidGlass<HTMLDivElement>()

  // 侧栏宽度：支持拖拽调整并持久化
  const [width, setWidth] = useState<number>(() => {
    try {
      const saved = Number(localStorage.getItem(SIDEBAR_WIDTH_KEY))
      if (Number.isFinite(saved) && saved >= SIDEBAR_MIN_WIDTH && saved <= SIDEBAR_MAX_WIDTH) return saved
    } catch {}
    return SIDEBAR_DEFAULT_WIDTH
  })
  const [resizing, setResizing] = useState(false)
  const sidebarRef = useRef<HTMLDivElement>(null)
  const widthRef = useRef(width)
  useEffect(() => { widthRef.current = width }, [width])

  // 同一个根节点既服务于拖宽计算，也作为玻璃折射的宿主
  const setSidebarNode = useCallback((node: HTMLDivElement | null) => {
    sidebarRef.current = node
    glassRef.current = node
  }, [glassRef])

  const handleResizeStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    setResizing(true)
  }, [])

  useEffect(() => {
    if (!resizing) return
    const onMouseMove = (e: MouseEvent) => {
      const left = sidebarRef.current?.getBoundingClientRect().left ?? 0
      setWidth(Math.min(SIDEBAR_MAX_WIDTH, Math.max(SIDEBAR_MIN_WIDTH, Math.round(e.clientX - left))))
    }
    const onMouseUp = () => {
      setResizing(false)
      try { localStorage.setItem(SIDEBAR_WIDTH_KEY, String(widthRef.current)) } catch {}
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

  // 退出多选时清空选中
  const exitSelectionMode = useCallback(() => {
    setSelectionMode(false)
    setSelectedIds(new Set())
  }, [])

  const toggleSelect = useCallback((taskId: string) => {
    setSelectedIds(prev => {
      const next = new Set(prev)
      if (next.has(taskId)) {
        next.delete(taskId)
      } else {
        next.add(taskId)
      }
      return next
    })
  }, [])

  const handleToggleSelectAll = useCallback(() => {
    setSelectedIds(prev => {
      if (prev.size === tasks.length && tasks.length > 0) {
        return new Set()
      }
      return new Set(tasks.map(task => task.id))
    })
  }, [tasks])

  const handleBatchDelete = useCallback(() => {
    if (selectedIds.size === 0 || !onDeleteMany) return
    onDeleteMany(Array.from(selectedIds))
    exitSelectionMode()
  }, [selectedIds, onDeleteMany, exitSelectionMode])

  const allSelected = tasks.length > 0 && selectedIds.size === tasks.length

  const changeViewMode = useCallback((mode: TaskViewMode) => {
    setViewMenuVisible(false)
    onViewModeChange(mode)
  }, [onViewModeChange])

  const toggleGroupCollapsed = useCallback((key: string) => {
    setCollapsedGroups(prev => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }, [])

  const showMoreInGroup = useCallback((key: string) => {
    setGroupLimits(prev => ({ ...prev, [key]: (prev[key] ?? GROUP_PAGE_SIZE) + GROUP_PAGE_STEP }))
  }, [])

  // 滚动监听：接近底部时自动加载更多
  const handleScroll = useCallback(() => {
    if (!onLoadMore || !hasMore || loadingMore) return
    const el = scrollContainerRef.current
    if (!el) return
    const distanceToBottom = el.scrollHeight - el.scrollTop - el.clientHeight
    if (distanceToBottom < 80) {
      onLoadMore()
    }
  }, [onLoadMore, hasMore, loadingMore])

  useEffect(() => {
    const el = scrollContainerRef.current
    if (!el) return
    el.addEventListener('scroll', handleScroll, { passive: true })
    return () => el.removeEventListener('scroll', handleScroll)
  }, [handleScroll])

  // 按时间分组展示：今日 / 昨天 / 本周 / 更早（保持 tasks 原有顺序）
  const groupedTasks = useMemo(() => {
    const buckets: Record<TaskGroupKey, TaskWithEmployee[]> = { today: [], yesterday: [], week: [], earlier: [] }
    for (const task of tasks) {
      buckets[getTaskTimeGroup(task.last_message_at ?? task.created_at)].push(task)
    }
    return ([
      { key: 'today' as const, label: t('tasks.groupToday') },
      { key: 'yesterday' as const, label: t('tasks.groupYesterday') },
      { key: 'week' as const, label: t('tasks.groupWeek') },
      { key: 'earlier' as const, label: t('tasks.groupEarlier') },
    ]).filter((g) => buckets[g.key].length > 0).map((g) => ({ ...g, tasks: buckets[g.key] }))
  }, [tasks, t])

  // 按员工分组：分组顺序取任务首次出现的顺序，组内保持原顺序
  const employeeGroups = useMemo(() => {
    const map = new Map<string, { key: string; label: string; hint?: string; icon: React.ReactNode; tasks: TaskWithEmployee[] }>()
    for (const task of tasks) {
      const key = task.employee_id || '__unknown__'
      let group = map.get(key)
      if (!group) {
        group = {
          key,
          label: task.employee_name || t('tasks.unknownEmployee'),
          icon: <RobotOutlined style={{ fontSize: 11 }} />,
          tasks: [],
        }
        map.set(key, group)
      }
      group.tasks.push(task)
    }
    return Array.from(map.values())
  }, [tasks, t])

  // 按工作区目录分组：用户指定目录按目录名分组，自动创建的任务目录统一归入"默认工作区"
  const workspaceGroups = useMemo(() => {
    const map = new Map<string, { key: string; label: string; hint?: string; icon: React.ReactNode; tasks: TaskWithEmployee[] }>()
    for (const task of tasks) {
      const isCustom = task.workspace_mode === 'custom' && !!task.workspace_path
      const workspacePath = isCustom ? (task.workspace_path as string) : ''
      // 路径大小写不敏感（Windows），统一小写作为分组键
      const key = isCustom ? workspacePath.replace(/[\\/]+$/, '').toLowerCase() : '__default__'
      let group = map.get(key)
      if (!group) {
        group = {
          key,
          label: isCustom ? getDirName(workspacePath) : t('tasks.defaultWorkspace'),
          hint: isCustom ? workspacePath : undefined,
          icon: <FolderOutlined style={{ fontSize: 11 }} />,
          tasks: [],
        }
        map.set(key, group)
      }
      group.tasks.push(task)
    }
    return Array.from(map.values())
  }, [tasks, t])

  const viewOptions = useMemo(() => ([
    { key: 'list' as TaskViewMode, icon: <UnorderedListOutlined style={{ fontSize: 12 }} />, label: t('tasks.viewList') },
    { key: 'employee' as TaskViewMode, icon: <TeamOutlined style={{ fontSize: 12 }} />, label: t('tasks.viewByEmployee') },
    { key: 'workspace' as TaskViewMode, icon: <FolderOutlined style={{ fontSize: 12 }} />, label: t('tasks.viewByWorkspace') },
  ]), [t])

  const categorizedGroups = viewMode === 'workspace' ? workspaceGroups : employeeGroups

  const renderTask = (task: TaskWithEmployee) => (
    <TaskItem
      key={task.id}
      task={task}
      active={task.id === activeTaskId}
      streaming={isTaskStreaming?.(task.id) ?? false}
      pendingRequests={pendingRequestCounts?.[task.id] ?? 0}
      selectionMode={selectionMode}
      selected={selectedIds.has(task.id)}
      onToggleSelect={toggleSelect}
      onSelect={onSelect}
      onDelete={onDelete}
      onExport={onExport}
      onGenerateTitle={onGenerateTitle}
      onRename={onRename}
      onExtractMemory={onExtractMemory}
      t={t}
      token={token}
    />
  )

  return (
    <div ref={setSidebarNode} className="wa-task-sidebar" data-testid="task-sidebar" style={{
      width,
      flexShrink: 0,
      display: 'flex',
      flexDirection: 'column',
      height: '100%',
      position: 'relative',
      userSelect: resizing ? 'none' : undefined,
    }}>
      {/* 顶部操作区：单行整合 - 关闭面板 | 搜索框(内嵌视图菜单) | 新建任务 */}
      <div style={{
        padding: '10px 10px 9px',
        display: 'flex',
        flexDirection: 'column',
        gap: 7,
        borderBottom: '1px solid var(--wa-line-2)',
        flexShrink: 0,
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          {/* 最左侧：面板隐藏按钮（弱样式，框架控件） */}
          {onCollapse && (
            <Tooltip title={t('workbench.closePanel')}>
              <Button
                type="text"
                size="small"
                className="wa-icon-btn"
                icon={<MenuFoldOutlined style={{ fontSize: 14 }} />}
                onClick={onCollapse}
                style={{ opacity: 0.55 }}
                onMouseEnter={(e) => { e.currentTarget.style.opacity = '1' }}
                onMouseLeave={(e) => { e.currentTarget.style.opacity = '0.55' }}
              />
            </Tooltip>
          )}

          {/* 中间：搜索框（内嵌筛选和多选图标按钮） */}
          {/* 搜索框和批量操作条都常驻DOM，通过display切换，避免条件渲染导致的闪烁 */}
          <div style={{ flex: 1, minWidth: 0, position: 'relative' }}>
            {/* 多选模式批量操作条 */}
            <div className="wa-field" style={{
              height: 30,
              display: selectionMode ? 'flex' : 'none',
              alignItems: 'center',
              gap: 6,
              padding: '0 8px',
            }}>
              <Checkbox checked={allSelected} indeterminate={selectedIds.size > 0 && !allSelected} onChange={handleToggleSelectAll} />
              <span style={{ flex: 1, fontSize: 12, color: token.colorTextSecondary, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {t('tasks.selectedCount', { count: selectedIds.size })}
              </span>
              <Button
                type="text"
                size="small"
                disabled={selectedIds.size === 0 || !onDeleteMany}
                danger
                data-testid="task-batch-delete"
                icon={<DeleteOutlined style={{ fontSize: 12 }} />}
                onClick={handleBatchDelete}
                style={{ fontSize: 12, color: selectedIds.size > 0 ? token.colorError : token.colorTextQuaternary, padding: 0, width: 22, height: 22, minWidth: 22 }}
              />
            </div>
            {/* 搜索框 */}
            <div data-testid="task-sidebar-search" className="wa-field" style={{
              height: 30,
              display: selectionMode ? 'none' : 'flex',
              alignItems: 'center',
              padding: '0 3px 0 9px',
              minWidth: 0,
            }}>
              <DebouncedSearchInput
                value={searchQuery}
                onChange={onSearchChange}
                onSubmit={onSearchSubmit ?? noop}
                placeholder={t('tasks.searchPlaceholder')}
                submitHint={t('tasks.searchContentHint')}
                token={token}
              />
              {/* 视图与多选合并为一个下拉按钮，避免搜索框内堆叠过多图标 */}
              <Dropdown
                open={viewMenuVisible}
                onOpenChange={setViewMenuVisible}
                trigger={['click']}
                dropdownRender={() => (
                  <div className="wa-glass-menu" style={{
                    width: 168,
                    padding: 6,
                    display: 'flex',
                    flexDirection: 'column',
                    gap: 2,
                  }}>
                    <div style={{ fontSize: 11, color: token.colorTextTertiary, padding: '2px 6px' }}>
                      {t('tasks.view')}
                    </div>
                    {viewOptions.map(option => {
                      const active = viewMode === option.key
                      return (
                        <div
                          key={option.key}
                          data-testid="task-view-option"
                          data-view={option.key}
                          onClick={() => changeViewMode(option.key)}
                          style={{
                            display: 'flex', alignItems: 'center', gap: 8,
                            padding: '6px 8px',
                            borderRadius: 6,
                            cursor: 'pointer',
                            fontSize: 12,
                            background: active ? token.colorPrimaryBg : 'transparent',
                            color: token.colorText,
                            transition: 'all 0.15s',
                          }}
                          onMouseEnter={(e) => { if (!active) e.currentTarget.style.background = token.colorBgTextHover }}
                          onMouseLeave={(e) => { if (!active) e.currentTarget.style.background = 'transparent' }}
                        >
                          {option.icon}
                          <span style={{ flex: 1 }}>{option.label}</span>
                          {active && <span style={{ fontSize: 11 }}>✓</span>}
                        </div>
                      )
                    })}
                    <div style={{ height: 1, background: token.colorBorderSecondary, margin: '4px 2px' }} />
                    <div
                      data-testid="task-multi-select"
                      onClick={() => {
                        setViewMenuVisible(false)
                        setSelectionMode(true)
                        setSelectedIds(new Set())
                      }}
                      style={{
                        display: 'flex', alignItems: 'center', gap: 8,
                        padding: '6px 8px',
                        borderRadius: 6,
                        cursor: 'pointer',
                        fontSize: 12,
                        color: token.colorText,
                        transition: 'all 0.15s',
                      }}
                      onMouseEnter={(e) => { e.currentTarget.style.background = token.colorBgTextHover }}
                      onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent' }}
                    >
                      <CheckSquareOutlined style={{ fontSize: 12 }} />
                      <span style={{ flex: 1 }}>{t('tasks.multiSelect')}</span>
                    </div>
                  </div>
                )}
              >
                <Tooltip title={t('tasks.view')}>
                  <Button
                    type="text"
                    size="small"
                    data-testid="task-sidebar-view"
                    icon={viewMode === 'workspace'
                      ? <FolderOutlined style={{ fontSize: 12 }} />
                      : viewMode === 'employee'
                        ? <TeamOutlined style={{ fontSize: 12 }} />
                        : <UnorderedListOutlined style={{ fontSize: 12 }} />}
                    style={{
                      flexShrink: 0,
                      width: 22,
                      height: 22,
                      minWidth: 22,
                      padding: 0,
                      borderRadius: 4,
                      color: viewMenuVisible ? token.colorPrimary : token.colorTextTertiary,
                      background: viewMenuVisible ? token.colorPrimaryBg : 'transparent',
                    }}
                  />
                </Tooltip>
              </Dropdown>
            </div>
          </div>

          {/* 最右侧：新建任务 / 取消多选 按钮（独立，主题色加号） */}
          {selectionMode ? (
            <Tooltip title={t('common.cancel')}>
              <Button
                type="text"
                size="small"
                className="wa-icon-btn"
                icon={<CloseOutlined style={{ fontSize: 14 }} />}
                onClick={exitSelectionMode}
              />
            </Tooltip>
          ) : (
            <Tooltip title={t('tasks.newTask')}>
              <Button
                type="primary"
                size="small"
                data-testid="task-sidebar-new"
                icon={<PlusOutlined style={{ fontSize: 14 }} />}
                onClick={onNewTask}
                style={{
                  flexShrink: 0,
                  width: 30,
                  height: 30,
                  minWidth: 30,
                  borderRadius: '50%',
                  padding: 0,
                  boxShadow: '0 8px 18px -10px var(--wa-accent), inset 0 1px 0 rgba(255,255,255,.35)',
                }}
              />
            </Tooltip>
          )}
        </div>
        {/* 仅标题匹配阶段提示：告知回车可搜全文，避免用户误以为搜不到 */}
        {searchQuery.trim() && !contentSearched && (
          <div style={{ fontSize: 11, color: token.colorTextQuaternary, padding: '0 2px', userSelect: 'none' }}>
            {t('tasks.searchHintTitleOnly')}
          </div>
        )}
      </div>

      <div
        ref={scrollContainerRef}
        style={{
          flex: 1,
          overflowY: 'auto',
          padding: '7px 8px 14px',
          display: 'flex',
          flexDirection: 'column',
          gap: 2,
        }}
      >
        {tasks.length === 0 ? (
          <div style={{ padding: '32px 16px', textAlign: 'center' }}>
            <Empty
              image={Empty.PRESENTED_IMAGE_SIMPLE}
              description={searchQuery ? t('tasks.noMatchingTasks') : t('tasks.noTasks')}
            />
          </div>
        ) : (
          <>
            {viewMode === 'list'
              ? groupedTasks.map((group, groupIdx) => (
                <div key={group.key} style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                  <div className="wa-task-group-label" style={{ paddingTop: groupIdx === 0 ? 4 : 12 }}>
                    {group.label}
                  </div>
                  {group.tasks.map(renderTask)}
                </div>
              ))
              : categorizedGroups.map((group, groupIdx) => {
                const collapsed = collapsedGroups.has(group.key)
                const limit = groupLimits[group.key] ?? GROUP_PAGE_SIZE
                const visibleTasks = group.tasks.slice(0, limit)
                const hiddenCount = group.tasks.length - visibleTasks.length
                return (
                  <div key={group.key} style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                    <div
                      className="wa-task-group-label is-clickable"
                      onClick={() => toggleGroupCollapsed(group.key)}
                      title={group.hint}
                      style={{ paddingTop: groupIdx === 0 ? 4 : 12 }}
                    >
                      <CaretRightOutlined
                        rotate={collapsed ? 0 : 90}
                        style={{ fontSize: 9, transition: 'transform 0.15s' }}
                      />
                      {group.icon}
                      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {group.label}
                      </span>
                      <span style={{ marginLeft: 'auto', fontWeight: 500, color: token.colorTextQuaternary }}>
                        {group.tasks.length}
                      </span>
                    </div>
                    {!collapsed && visibleTasks.map(renderTask)}
                    {!collapsed && hiddenCount > 0 && (
                      <Button
                        type="text"
                        size="small"
                        onClick={() => showMoreInGroup(group.key)}
                        style={{
                          alignSelf: 'flex-start',
                          marginLeft: 4,
                          padding: '0 8px',
                          height: 24,
                          fontSize: 12,
                          color: token.colorTextTertiary,
                        }}
                      >
                        <DownOutlined style={{ fontSize: 10, marginRight: 4 }} />
                        {t('tasks.showMore', { count: hiddenCount })}
                      </Button>
                    )}
                  </div>
                )
              })}
            {/* 加载更多区域 */}
            {(hasMore || loadingMore) && (
              <div style={{
                padding: '12px 8px',
                display: 'flex',
                justifyContent: 'center',
                alignItems: 'center',
                gap: 8,
              }}>
                {loadingMore ? (
                  <Spin size="small" />
                ) : hasMore && onLoadMore ? (
                  <Button
                    type="link"
                    size="small"
                    onClick={onLoadMore}
                    style={{ fontSize: 12, height: 'auto', padding: '2px 8px' }}
                  >
                    {t('tasks.loadMore')}
                  </Button>
                ) : null}
              </div>
            )}
          </>
        )}
      </div>

      {/* 宽度拖拽手柄 */}
      <div
        onMouseDown={handleResizeStart}
        onDoubleClick={() => {
          setWidth(SIDEBAR_DEFAULT_WIDTH)
          try { localStorage.setItem(SIDEBAR_WIDTH_KEY, String(SIDEBAR_DEFAULT_WIDTH)) } catch {}
        }}
        style={{
          position: 'absolute',
          top: 8,
          bottom: 8,
          right: 0,
          width: 6,
          height: 'auto',
          cursor: 'col-resize',
          zIndex: 10,
          borderRadius: 3,
          background: resizing ? token.colorPrimaryBorder : 'transparent',
          transition: resizing ? 'none' : 'background 0.15s',
        }}
        onMouseEnter={(e) => { e.currentTarget.style.background = token.colorPrimaryBorder }}
        onMouseLeave={(e) => { if (!resizing) e.currentTarget.style.background = 'transparent' }}
      />

      <style>{`
        @keyframes pulse {
          0%, 100% { opacity: 1; }
          50% { opacity: 0.3; }
        }
      `}</style>
    </div>
  )
}

export default memo(TaskSidebar)
