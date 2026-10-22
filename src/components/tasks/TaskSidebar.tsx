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
  FilterOutlined,
} from '@ant-design/icons'
import { useTranslation } from 'react-i18next'
import dayjs from 'dayjs'
import type { Conversation, Employee } from '../../types'

const { Text } = Typography

const SIDEBAR_WIDTH_KEY = 'tasks:sidebarWidth'
const SIDEBAR_MIN_WIDTH = 200
const SIDEBAR_MAX_WIDTH = 560
const SIDEBAR_DEFAULT_WIDTH = 260

export interface TaskWithEmployee extends Conversation {
  employee_name: string
}

interface TaskSidebarProps {
  tasks: TaskWithEmployee[]
  activeTaskId: string | null
  employees: Employee[]
  searchQuery: string
  onSearchChange: (query: string) => void
  filterEmployeeId: string | null
  onFilterChange: (employeeId: string | null) => void
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

/** 搜索提交防抖时长：停止输入后再触发检索与列表过滤 */
const SEARCH_DEBOUNCE_MS = 250

/**
 * 搜索输入框：本地维护输入值并防抖提交。
 * 输入过程只重渲染这个小组件，不触发整页（含对话区）重渲染与后端检索；
 * 提交时用 startTransition 标记为低优先级，避免长列表/流式输出阻塞按键。
 */
const DebouncedSearchInput = memo(({
  value,
  onChange,
  placeholder,
  token,
}: {
  value: string
  onChange: (query: string) => void
  placeholder: string
  token: any
}) => {
  const [local, setLocal] = useState(value)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const onChangeRef = useRef(onChange)

  useEffect(() => { onChangeRef.current = onChange }, [onChange])
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

  const handleChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const next = e.target.value
    setLocal(next)
    commit(next)
  }, [commit])

  const handleClear = useCallback(() => {
    setLocal('')
    commit('', true)
  }, [commit])

  return (
    <>
      <SearchOutlined style={{ color: token.colorTextQuaternary, fontSize: 12, flexShrink: 0 }} />
      <input
        placeholder={placeholder}
        value={local}
        onChange={handleChange}
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
          padding: '5px 10px',
          borderRadius: 6,
          cursor: isEditing ? 'text' : 'pointer',
          background: selectionMode
            ? (selected ? token.colorPrimaryBg : (hovered ? token.colorBgTextHover : 'transparent'))
            : (active ? token.colorPrimaryBg : (hovered ? token.colorBgTextHover : 'transparent')),
          border: active && !selectionMode ? `1px solid ${token.colorPrimaryBorder}` : (selected ? `1px solid ${token.colorPrimaryBorder}` : '1px solid transparent'),
          transition: 'all 0.15s',
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
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, height: 24 }}>
            {streaming && (
              <span style={{
                width: 6, height: 6, borderRadius: '50%',
                background: token.colorPrimary, flexShrink: 0,
                animation: 'pulse 1.5s infinite',
              }} />
            )}
            {isEditing ? (
              <Input
                ref={editInputRef}
                value={editValue}
                onChange={(e) => setEditValue(e.target.value)}
                onKeyDown={handleEditKeyDown}
                onBlur={saveEdit}
                size="small"
                variant="filled"
                onClick={(e) => e.stopPropagation()}
                style={{ flex: 1, minWidth: 0, fontSize: 14, padding: '0 8px', height: 24 }}
              />
            ) : (
              <>
                <Text
                  strong={active}
                  ellipsis
                  style={{ fontSize: 14, flex: 1, minWidth: 0 }}
                >
                  {task.title || t('workbench.untitledConv')}
                </Text>
                {/* 固定宽度时间槽：悬停时时间淡出、操作按钮原位淡入，标题不位移 */}
                <span style={{ position: 'relative', width: 56, height: '100%', flexShrink: 0 }}>
                  <span style={{
                    position: 'absolute',
                    right: 0,
                    top: '50%',
                    transform: 'translateY(-50%)',
                    fontSize: 12,
                    color: token.colorTextTertiary,
                    whiteSpace: 'nowrap',
                    opacity: hovered && !isEditing && !selectionMode ? 0 : 1,
                    transition: 'opacity 0.15s',
                  }}>
                    {formatTaskTime(task.last_message_at ?? task.created_at, t)}
                  </span>
                </span>
              </>
            )}
          </div>
        </div>
        <div
          style={{
            position: 'absolute',
            top: '50%',
            transform: 'translateY(-50%)',
            right: 10,
            opacity: hovered && !isEditing && !selectionMode ? 1 : 0,
            pointerEvents: hovered && !isEditing && !selectionMode ? 'auto' : 'none',
            transition: 'opacity 0.15s',
            display: 'flex',
            alignItems: 'center',
            gap: 2,
          }}
        >
          {!deleteConfirm && (
            <Button
              type="text"
              size="small"
              icon={<EditOutlined style={{ fontSize: 12 }} />}
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
              onClick={(e) => handleDeleteClick(e)}
              title={t('common.delete')}
              style={{ color: token.colorTextTertiary, padding: 0, width: 20, height: 20, minWidth: 20 }}
            />
          )}
        </div>
      </div>
    </Dropdown>
  )
})

const TaskSidebar: React.FC<TaskSidebarProps> = ({
  tasks,
  activeTaskId,
  employees,
  searchQuery,
  onSearchChange,
  filterEmployeeId,
  onFilterChange,
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
  hasMore,
  loadingMore,
  onLoadMore,
}) => {
  const { t } = useTranslation()
  const { token } = theme.useToken()
  const [filterVisible, setFilterVisible] = useState(false)
  const [filterEmployeeSearch, setFilterEmployeeSearch] = useState('')
  const [selectionMode, setSelectionMode] = useState(false)
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  const scrollContainerRef = useRef<HTMLDivElement>(null)

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

  const filteredEmployeesForFilter = useMemo(() => {
    if (!filterEmployeeSearch.trim()) return employees
    const search = filterEmployeeSearch.toLowerCase()
    return employees.filter(e => e.name.toLowerCase().includes(search))
  }, [employees, filterEmployeeSearch])

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

  return (
    <div ref={sidebarRef} style={{
      width,
      flexShrink: 0,
      display: 'flex',
      flexDirection: 'column',
      borderRight: `1px solid ${token.colorBorderSecondary}`,
      background: token.colorBgContainer,
      height: '100%',
      position: 'relative',
      userSelect: resizing ? 'none' : undefined,
    }}>
      {/* 顶部操作区：单行整合 - 关闭面板 | 搜索框(内嵌筛选/多选) | 新建任务 */}
      <div style={{
        padding: '8px 10px',
        display: 'flex',
        flexDirection: 'column',
        gap: 6,
        borderBottom: `1px solid ${token.colorBorderSecondary}`,
        flexShrink: 0,
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          {/* 最左侧：面板隐藏按钮（弱样式，框架控件） */}
          {onCollapse && (
            <Tooltip title={t('workbench.closePanel')}>
              <Button
                type="text"
                size="small"
                icon={<MenuFoldOutlined style={{ fontSize: 14 }} />}
                onClick={onCollapse}
                style={{
                  flexShrink: 0,
                  width: 28,
                  height: 28,
                  minWidth: 28,
                  borderRadius: 6,
                  color: token.colorTextQuaternary,
                  opacity: 0.5,
                  transition: 'opacity 0.15s',
                }}
                onMouseEnter={(e) => { e.currentTarget.style.opacity = '1' }}
                onMouseLeave={(e) => { e.currentTarget.style.opacity = '0.5' }}
              />
            </Tooltip>
          )}

          {/* 中间：搜索框（内嵌筛选和多选图标按钮） */}
          {/* 搜索框和批量操作条都常驻DOM，通过display切换，避免条件渲染导致的闪烁 */}
          <div style={{ flex: 1, minWidth: 0, position: 'relative' }}>
            {/* 多选模式批量操作条 */}
            <div style={{
              height: 28,
              display: selectionMode ? 'flex' : 'none',
              alignItems: 'center',
              gap: 6,
              padding: '0 8px',
              borderRadius: 6,
              background: token.colorFillQuaternary,
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
                icon={<DeleteOutlined style={{ fontSize: 12 }} />}
                onClick={handleBatchDelete}
                style={{ fontSize: 12, color: selectedIds.size > 0 ? token.colorError : token.colorTextQuaternary, padding: 0, width: 22, height: 22, minWidth: 22 }}
              />
            </div>
            {/* 搜索框 */}
            <div style={{
              height: 28,
              display: selectionMode ? 'none' : 'flex',
              borderRadius: 6,
              border: `1px solid ${token.colorBorderSecondary}`,
              background: token.colorBgElevated,
              alignItems: 'center',
              padding: '0 4px 0 8px',
              transition: 'border-color 0.15s',
              minWidth: 0,
            }}
              onMouseEnter={(e) => { e.currentTarget.style.borderColor = token.colorPrimaryBorder }}
              onMouseLeave={(e) => { e.currentTarget.style.borderColor = token.colorBorderSecondary }}
            >
              <DebouncedSearchInput
                value={searchQuery}
                onChange={onSearchChange}
                placeholder={t('tasks.searchPlaceholder')}
                token={token}
              />
              {/* 筛选按钮 - 内嵌搜索框右侧 */}
              <Dropdown
                open={filterVisible}
                onOpenChange={(o) => {
                  setFilterVisible(o)
                  if (!o) setFilterEmployeeSearch('')
                }}
                trigger={['click']}
                dropdownRender={() => (
                  <div style={{
                    width: 160,
                    padding: 8,
                    background: token.colorBgContainer,
                    borderRadius: 8,
                    border: `1px solid ${token.colorBorderSecondary}`,
                    boxShadow: token.boxShadowSecondary,
                    display: 'flex',
                    flexDirection: 'column',
                    gap: 4,
                  }}>
                    <div style={{ fontSize: 11, color: token.colorTextTertiary, marginBottom: 2, padding: '0 4px' }}>
                      {t('tasks.filterByEmployee')}
                    </div>
                    <Input
                      placeholder={t('workbench.searchEmployee')}
                      prefix={<SearchOutlined style={{ color: token.colorTextQuaternary, fontSize: 12 }} />}
                      value={filterEmployeeSearch}
                      onChange={(e) => setFilterEmployeeSearch(e.target.value)}
                      allowClear
                      size="small"
                      variant="borderless"
                      style={{ padding: '2px 4px', marginBottom: 2 }}
                    />
                    <div style={{ maxHeight: 210, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 2 }}>
                      {filteredEmployeesForFilter.length === 0 && (
                        <div style={{ padding: '20px 0', textAlign: 'center', color: token.colorTextQuaternary, fontSize: 12 }}>
                          {filterEmployeeSearch ? t('workbench.noMatchingEmployee') : t('digitalEmployees.noEmployees')}
                        </div>
                      )}
                      {filteredEmployeesForFilter.map(emp => {
                        const selected = filterEmployeeId === emp.id
                        return (
                          <div
                            key={emp.id}
                            onClick={() => {
                              onFilterChange(selected ? null : emp.id)
                              setFilterVisible(false)
                              setFilterEmployeeSearch('')
                            }}
                            style={{
                              display: 'flex', alignItems: 'center', gap: 8,
                              padding: '6px 8px',
                              borderRadius: 6,
                              cursor: 'pointer',
                              background: selected ? token.colorPrimaryBg : 'transparent',
                              transition: 'all 0.15s',
                            }}
                            onMouseEnter={(e) => { if (!selected) e.currentTarget.style.background = token.colorBgTextHover }}
                            onMouseLeave={(e) => { if (!selected) e.currentTarget.style.background = 'transparent' }}
                          >
                            <RobotOutlined style={{ fontSize: 12, color: token.colorPrimary, flexShrink: 0 }} />
                            <span style={{ flex: 1, fontSize: 12, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{emp.name}</span>
                            {selected && <span style={{ color: token.colorPrimary, fontSize: 11 }}>✓</span>}
                          </div>
                        )
                      })}
                    </div>
                    {filterEmployeeId && (
                      <Button
                        type="text"
                        size="small"
                        block
                        style={{ marginTop: 6, fontSize: 11 }}
                        onClick={() => { onFilterChange(null); setFilterVisible(false); setFilterEmployeeSearch('') }}
                      >
                        {t('common.clearAll')}
                      </Button>
                    )}
                  </div>
                )}
              >
                <Tooltip title={t('tasks.filterByEmployee')}>
                  <Button
                    type="text"
                    size="small"
                    icon={<FilterOutlined style={{ fontSize: 12 }} />}
                    style={{
                      flexShrink: 0,
                      width: 22,
                      height: 22,
                      minWidth: 22,
                      padding: 0,
                      borderRadius: 4,
                      color: filterEmployeeId ? token.colorPrimary : token.colorTextTertiary,
                      background: filterEmployeeId ? token.colorPrimaryBg : 'transparent',
                    }}
                  />
                </Tooltip>
              </Dropdown>
              {/* 多选按钮 - 内嵌搜索框右侧 */}
              <Tooltip title={t('tasks.multiSelect')}>
                <Button
                  type="text"
                  size="small"
                  icon={<CheckSquareOutlined style={{ fontSize: 12 }} />}
                  onClick={() => { setSelectionMode(true); setSelectedIds(new Set()) }}
                  style={{
                    flexShrink: 0,
                    width: 22,
                    height: 22,
                    minWidth: 22,
                    padding: 0,
                    borderRadius: 4,
                    color: token.colorTextTertiary,
                  }}
                />
              </Tooltip>
            </div>
          </div>

          {/* 最右侧：新建任务 / 取消多选 按钮（独立，主题色加号） */}
          {selectionMode ? (
            <Tooltip title={t('common.cancel')}>
              <Button
                type="text"
                size="small"
                icon={<CloseOutlined style={{ fontSize: 14 }} />}
                onClick={exitSelectionMode}
                style={{
                  flexShrink: 0,
                  width: 28,
                  height: 28,
                  minWidth: 28,
                  borderRadius: 6,
                  color: token.colorTextTertiary,
                }}
              />
            </Tooltip>
          ) : (
            <Tooltip title={t('tasks.newTask')}>
              <Button
                type="primary"
                size="small"
                icon={<PlusOutlined style={{ fontSize: 14 }} />}
                onClick={onNewTask}
                style={{
                  flexShrink: 0,
                  width: 28,
                  height: 28,
                  minWidth: 28,
                  borderRadius: 6,
                  padding: 0,
                }}
              />
            </Tooltip>
          )}
        </div>
        {filterEmployeeId && !selectionMode && (
          <div style={{
            display: 'inline-flex', alignItems: 'center', gap: 4, alignSelf: 'flex-start',
            padding: '2px 8px', borderRadius: 10,
            background: token.colorPrimaryBg, border: `1px solid ${token.colorPrimaryBorder}`,
            fontSize: 11, color: token.colorPrimary,
          }}>
            <RobotOutlined style={{ fontSize: 10 }} />
            <span>{employees.find(e => e.id === filterEmployeeId)?.name}</span>
            <DeleteOutlined style={{ fontSize: 10, cursor: 'pointer' }} onClick={() => onFilterChange(null)} />
          </div>
        )}
      </div>

      <div
        ref={scrollContainerRef}
        style={{
          flex: 1,
          overflowY: 'auto',
          padding: '6px 8px',
          display: 'flex',
          flexDirection: 'column',
          gap: 2,
        }}
      >
        {tasks.length === 0 ? (
          <div style={{ padding: '32px 16px', textAlign: 'center' }}>
            <Empty
              image={Empty.PRESENTED_IMAGE_SIMPLE}
              description={searchQuery || filterEmployeeId ? t('tasks.noMatchingTasks') : t('tasks.noTasks')}
            />
          </div>
        ) : (
          <>
            {tasks.map(task => (
              <TaskItem
                key={task.id}
                task={task}
                active={task.id === activeTaskId}
                streaming={isTaskStreaming?.(task.id) ?? false}
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
            ))}
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
          top: 0,
          right: -2,
          width: 5,
          height: '100%',
          cursor: 'col-resize',
          zIndex: 10,
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
