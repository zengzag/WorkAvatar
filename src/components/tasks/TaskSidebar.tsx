import { memo, useState, useMemo, useCallback, useRef, useEffect } from 'react'
import { Input, Button, Typography, Popconfirm, Empty, theme, Dropdown, Tooltip, Checkbox } from 'antd'
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
}

const formatTime = (timestamp: number | null): string => {
  if (!timestamp) return ''
  const now = dayjs()
  const time = dayjs(timestamp * 1000)
  const diffMin = now.diff(time, 'minute')
  if (diffMin < 1) return '刚刚'
  if (diffMin < 60) return `${diffMin}分钟前`
  if (now.isSame(time, 'day')) return time.format('HH:mm')
  if (now.subtract(1, 'day').isSame(time, 'day')) return '昨天'
  if (now.isSame(time, 'year')) return time.format('M月D日')
  return time.format('YYYY/M/D')
}

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

  const handleDeleteClick = useCallback(() => {
    onDelete(task.id)
  }, [onDelete, task.id])

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
          if (!isEditing) onSelect(task.id)
        }}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
        onDoubleClick={(e) => { if (!selectionMode) startEdit(e) }}
        style={{
          padding: '8px 10px',
          borderRadius: 6,
          cursor: isEditing ? 'text' : 'pointer',
          background: selectionMode
            ? (selected ? token.colorPrimaryBg : (hovered ? token.colorBgTextHover : 'transparent'))
            : (active ? token.colorPrimaryBg : (hovered ? token.colorBgTextHover : 'transparent')),
          border: active && !selectionMode ? `1px solid ${token.colorPrimaryBorder}` : (selected ? `1px solid ${token.colorPrimaryBorder}` : '1px solid transparent'),
          transition: 'all 0.15s',
          display: 'flex',
          alignItems: 'flex-start',
          gap: 8,
        }}
      >
        {selectionMode && (
          <div style={{ flexShrink: 0, paddingTop: 1 }} onClick={(e) => e.stopPropagation()}>
            <Checkbox
              checked={!!selected}
              onChange={() => onToggleSelect?.(task.id)}
              style={{ pointerEvents: 'auto' }}
            />
          </div>
        )}
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 2 }}>
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
                style={{ flex: 1, minWidth: 0, fontSize: 13, padding: '0 8px', height: 22 }}
              />
            ) : (
              <Text
                strong={active}
                ellipsis
                style={{ fontSize: 13, flex: 1, minWidth: 0 }}
              >
                {task.title || t('workbench.untitledConv')}
              </Text>
            )}
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, color: token.colorTextTertiary }}>
            <RobotOutlined style={{ fontSize: 10 }} />
            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{task.employee_name}</span>
            <span>·</span>
            <span style={{ flexShrink: 0 }}>{formatTime(task.last_message_at ?? task.created_at)}</span>
          </div>
        </div>
        <div
          style={{
            flexShrink: 0,
            opacity: hovered && !isEditing && !selectionMode ? 1 : 0,
            pointerEvents: hovered && !isEditing && !selectionMode ? 'auto' : 'none',
            transition: 'opacity 0.15s',
            display: 'flex',
            alignItems: 'center',
            gap: 2,
          }}
        >
          <Button
            type="text"
            size="small"
            icon={<EditOutlined style={{ fontSize: 12 }} />}
            onClick={(e) => startEdit(e)}
            title={t('common.rename')}
            style={{ color: token.colorTextTertiary, padding: 0, width: 20, height: 20, minWidth: 20 }}
          />
          <Popconfirm
            title={t('workbench.confirmDelete')}
            okText={t('common.confirm')}
            cancelText={t('common.cancel')}
            okButtonProps={{ danger: true }}
            trigger="click"
            onConfirm={(e) => { e?.stopPropagation(); onDelete(task.id) }}
            onCancel={(e) => e?.stopPropagation()}
          >
            <Button
              type="text"
              size="small"
              icon={<DeleteOutlined style={{ fontSize: 12 }} />}
              onClick={(e) => e.stopPropagation()}
              style={{ color: token.colorTextTertiary, padding: 0, width: 20, height: 20, minWidth: 20 }}
            />
          </Popconfirm>
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
}) => {
  const { t } = useTranslation()
  const { token } = theme.useToken()
  const [filterVisible, setFilterVisible] = useState(false)
  const [filterEmployeeSearch, setFilterEmployeeSearch] = useState('')
  const [selectionMode, setSelectionMode] = useState(false)
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())

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

  return (
    <div style={{
      width: 280,
      flexShrink: 0,
      display: 'flex',
      flexDirection: 'column',
      borderRight: `1px solid ${token.colorBorderSecondary}`,
      background: token.colorBgContainer,
      height: '100%',
    }}>
      {/* 顶部操作区：新建任务 + 搜索 + 筛选 */}
      <div style={{
        padding: '10px 10px 8px',
        display: 'flex',
        flexDirection: 'column',
        gap: 8,
        borderBottom: `1px solid ${token.colorBorderSecondary}`,
        flexShrink: 0,
      }}>
        {selectionMode ? (
          // 多选模式批量操作条
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <Checkbox checked={allSelected} indeterminate={selectedIds.size > 0 && !allSelected} onChange={handleToggleSelectAll} />
            <span style={{ flex: 1, fontSize: 12, color: token.colorTextSecondary }}>
              {t('tasks.selectedCount', { count: selectedIds.size })}
            </span>
            <Button
              type="text"
              size="small"
              disabled={selectedIds.size === 0 || !onDeleteMany}
              danger
              icon={<DeleteOutlined />}
              onClick={handleBatchDelete}
              style={{ fontSize: 12, color: selectedIds.size > 0 ? token.colorError : token.colorTextQuaternary }}
            >
              {t('tasks.batchDelete')}
            </Button>
            <Tooltip title={t('common.cancel')}>
              <Button
                type="text"
                size="small"
                icon={<CloseOutlined style={{ fontSize: 12 }} />}
                onClick={exitSelectionMode}
                style={{ color: token.colorTextTertiary }}
              />
            </Tooltip>
          </div>
        ) : (
          <>
            <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
              <Button
                type="primary"
                icon={<PlusOutlined />}
                onClick={onNewTask}
                style={{ flex: 1, height: 28, borderRadius: 6, fontSize: 13 }}
              >
                {t('tasks.newTask')}
              </Button>
              {onCollapse && (
                <Tooltip title={t('workbench.closePanel')}>
                  <Button
                    type="text"
                    size="small"
                    icon={<MenuFoldOutlined style={{ fontSize: 14 }} />}
                    onClick={onCollapse}
                    style={{ flexShrink: 0, width: 28, height: 28, minWidth: 28, borderRadius: 6, color: token.colorTextTertiary }}
                  />
                </Tooltip>
              )}
            </div>
            <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
              <Input
                placeholder={t('tasks.searchPlaceholder')}
                prefix={<SearchOutlined style={{ color: token.colorTextQuaternary, fontSize: 12 }} />}
                value={searchQuery}
                onChange={(e) => onSearchChange(e.target.value)}
                allowClear
                size="small"
                variant="filled"
                style={{ flex: 1, borderRadius: 6 }}
              />
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
                    icon={<FilterOutlined style={{ fontSize: 14 }} />}
                    style={{
                      flexShrink: 0,
                      width: 28, height: 28, minWidth: 28,
                      borderRadius: 6,
                      background: filterEmployeeId ? token.colorPrimaryBg : token.colorFillQuaternary,
                      color: filterEmployeeId ? token.colorPrimary : token.colorTextTertiary,
                    }}
                  />
                </Tooltip>
              </Dropdown>
              <Tooltip title={t('tasks.multiSelect')}>
                <Button
                  type="text"
                  size="small"
                  icon={<CheckSquareOutlined style={{ fontSize: 14 }} />}
                  onClick={() => { setSelectionMode(true); setSelectedIds(new Set()) }}
                  style={{
                    flexShrink: 0,
                    width: 28, height: 28, minWidth: 28,
                    borderRadius: 6,
                    background: token.colorFillQuaternary,
                    color: token.colorTextTertiary,
                  }}
                />
              </Tooltip>
            </div>
          </>
        )}
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
          tasks.map(task => (
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
          ))
        )}
      </div>

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
