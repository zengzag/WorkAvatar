import { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import { useNavigate, useLocation } from 'react-router-dom'
import { Input, Button, Empty, Spin, App, theme, Typography, Tooltip, Segmented, Dropdown, Avatar } from 'antd'
import type { MenuProps } from 'antd'
import {
  PlusOutlined, RobotOutlined, DeleteOutlined, MessageOutlined, ClockCircleOutlined,
  FolderOpenOutlined, SettingOutlined, SearchOutlined, EllipsisOutlined,
  AppstoreOutlined, BarsOutlined, CopyOutlined, DatabaseOutlined,
} from '@ant-design/icons'
import { useTranslation } from 'react-i18next'
import EmployeeSettingsDrawer from '../components/employee-settings/EmployeeSettingsDrawer'
import DeleteConversationOptions from '../components/employee-settings/DeleteConversationOptions'
import type { DeleteConversationState } from '../components/employee-settings/DeleteConversationOptions'
import type { Employee } from '../types'

const { Text, Paragraph } = Typography

const AVATAR_COLORS = ['#1677ff', '#52c41a', '#fa8c16', '#722ed1', '#eb2f96', '#13c2c2', '#faad14', '#f5222d']

function getAvatarColor(id: string): string {
  let hash = 0
  for (let i = 0; i < id.length; i++) {
    hash = ((hash << 5) - hash) + id.charCodeAt(i)
    hash |= 0
  }
  return AVATAR_COLORS[Math.abs(hash) % AVATAR_COLORS.length]
}

function toMs(ts: number): number {
  return ts > 1e12 ? ts : ts * 1000
}

type ViewMode = 'grid' | 'list'

interface EmployeeStats {
  conversationCount: number
  lastActiveAt: number | null
}

/** 员工库分组：内置（官方）/ 我的（用户创建)/ 按插件 */
interface EmployeeGroup {
  key: string
  title: string
  employees: Employee[]
}

/** 注册员工（内置/插件）只读：无设置与删除入口，仅可快速任务与另存副本 */
function isRegistered(e: Employee): boolean {
  return e.source === 'builtin' || e.source === 'plugin'
}

const Employees: React.FC = () => {
  const { t } = useTranslation()
  const { message, modal } = App.useApp()
  const { token } = theme.useToken()
  const navigate = useNavigate()
  const location = useLocation()

  const [employees, setEmployees] = useState<Employee[]>([])
  const [loading, setLoading] = useState(true)
  const [stats, setStats] = useState<Record<string, EmployeeStats>>({})
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [selectedEmployeeId, setSelectedEmployeeId] = useState<string | undefined>()
  const [searchQuery, setSearchQuery] = useState('')
  const [viewMode, setViewMode] = useState<ViewMode>('list')
  /** 删除员工确认弹窗中的对话处理选择（供 onOk 读取最新值） */
  const deleteStateRef = useRef<DeleteConversationState>({ conversationAction: 'keep', transferToEmployeeId: undefined, deleteWorkspace: true })

  const loadStats = useCallback(async (list: Employee[]) => {
    const statsMap: Record<string, EmployeeStats> = {}
    await Promise.all(list.map(async (emp) => {
      try {
        const result = await window.electronAPI.conversation.list({ employee_id: emp.id })
        const conversations = Array.isArray(result) ? result : []
        let lastActiveAt: number | null = null
        for (const conv of conversations) {
          const ts = (conv as any).last_message_at || (conv as any).updated_at
          if (ts && (lastActiveAt === null || ts > lastActiveAt)) {
            lastActiveAt = ts
          }
        }
        statsMap[emp.id] = {
          conversationCount: conversations.length,
          lastActiveAt,
        }
      } catch {
        statsMap[emp.id] = { conversationCount: 0, lastActiveAt: null }
      }
    }))
    setStats(statsMap)
  }, [])

  const loadEmployees = useCallback(async () => {
    try {
      const result = await window.electronAPI.employee.list()
      const list = Array.isArray(result) ? result : []
      setEmployees(list)
      loadStats(list)
    } catch {
      message.error(t('digitalEmployees.loadEmployeesFailed'))
    } finally {
      setLoading(false)
    }
  }, [message, t, loadStats])

  useEffect(() => {
    loadEmployees()
  }, [loadEmployees, location.pathname])

  // 员工变更事件：刷新列表（含增/改/删及其他页面触发的删除、插件员工上下线）
  useEffect(() => {
    const unsub = window.electronAPI.employee.onChanged(() => {
      loadEmployees()
    })
    return () => { unsub?.() }
  }, [loadEmployees])

  const formatLastActive = useCallback((timestamp: number | null | undefined): string => {
    if (!timestamp) {
      return t('digitalEmployees.noActivity', { defaultValue: '暂无活动' })
    }
    const ts = toMs(timestamp)
    const diff = Date.now() - ts
    if (diff < 60_000) {
      return t('digitalEmployees.justNow', { defaultValue: '刚刚' })
    }
    if (diff < 3_600_000) {
      return t('digitalEmployees.minutesAgo', { count: Math.floor(diff / 60_000), defaultValue: '{{count}} 分钟前' })
    }
    if (diff < 86_400_000) {
      return t('digitalEmployees.hoursAgo', { count: Math.floor(diff / 3_600_000), defaultValue: '{{count}} 小时前' })
    }
    return t('digitalEmployees.daysAgo', { count: Math.floor(diff / 86_400_000), defaultValue: '{{count}} 天前' })
  }, [t])

  const handleCardClick = useCallback((emp: Employee) => {
    // 注册员工打开设置抽屉：与正常员工一致的展示，实操入口（保存/删除/工具切换等）在抽屉内只读
    setSelectedEmployeeId(emp.id)
    setSettingsOpen(true)
  }, [])

  const handleStartTask = useCallback((emp: Employee) => {
    // 清除该员工的恢复对话缓存，确保任务页以全新状态打开
    localStorage.removeItem(`employeeWorkbench:activeConvId:${emp.id}`)
    navigate(`/tasks?new=1&employee=${encodeURIComponent(emp.id)}`)
  }, [navigate])

  const handleDuplicate = useCallback(async (emp: Employee) => {
    try {
      const created = await window.electronAPI.employee.duplicate({ id: emp.id })
      if (created) {
        message.success(t('digitalEmployees.duplicateSuccess', { defaultValue: '已另存为我的员工' }))
        await loadEmployees()
      } else {
        message.error(t('digitalEmployees.duplicateFailed', { defaultValue: '另存副本失败' }))
      }
    } catch {
      message.error(t('digitalEmployees.duplicateFailed', { defaultValue: '另存副本失败' }))
    }
  }, [message, t, loadEmployees])

  const handleDeleteEmployee = useCallback((emp: Employee) => {
    const workspacePath = emp.workspace_path
    const transferTargets = employees.filter(e => e.id !== emp.id)
    deleteStateRef.current = { conversationAction: 'keep', transferToEmployeeId: undefined, deleteWorkspace: true }

    modal.confirm({
      title: t('employeeSettings.confirmDeleteEmployee'),
      icon: null,
      width: 560,
      content: (
        <div>
          <Text>{t('employeeSettings.deleteEmployeeDesc')}</Text>
          {workspacePath && (
            <div style={{
              marginTop: 8,
              padding: '6px 10px',
              background: token.colorFillTertiary,
              borderRadius: 6,
              display: 'flex',
              alignItems: 'center',
              gap: 8,
            }}>
              <FolderOpenOutlined style={{ color: token.colorPrimary, flexShrink: 0 }} />
              <Tooltip title={workspacePath}>
                <Text style={{
                  fontSize: 13,
                  color: token.colorTextSecondary,
                  flex: 1,
                  minWidth: 0,
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                }}>
                  {t('employeeSettings.workspacePath')}: {workspacePath}
                </Text>
              </Tooltip>
              <Button
                type="link"
                size="small"
                icon={<FolderOpenOutlined />}
                onClick={() => window.electronAPI.workspace.openInExplorer({ path: workspacePath }).catch(() => {})}
                style={{ flexShrink: 0, padding: 0 }}
              />
            </div>
          )}
          <div style={{ height: 1, background: token.colorSplit, margin: '12px 0' }} />
          <DeleteConversationOptions
            targets={transferTargets}
            showWorkspace={!!workspacePath}
            onStateChange={(s) => { deleteStateRef.current = s }}
          />
        </div>
      ),
      okText: t('common.delete'),
      cancelText: t('common.cancel'),
      okButtonProps: { danger: true },
      onOk: async () => {
        const state = deleteStateRef.current
        if (state.conversationAction === 'transfer' && !state.transferToEmployeeId) {
          message.error(t('employeeSettings.transferRequireTarget'))
          // 返回 rejected Promise，阻止关闭弹窗
          return Promise.reject(new Error('transfer target required'))
        }
        try {
          const result = await window.electronAPI.employee.delete({
            id: emp.id,
            delete_workspace: state.deleteWorkspace,
            conversation_action: state.conversationAction,
            transfer_to_employee_id: state.transferToEmployeeId,
          })
          if (state.conversationAction === 'transfer' && Number(result?.transferred) > 0) {
            const target = transferTargets.find(e2 => e2.id === state.transferToEmployeeId)
            message.success(t('employeeSettings.transferSuccess', {
              count: result.transferred,
              name: target?.name || '',
            }))
          } else {
            message.success(t('common.deleted'))
          }
          // 乐观更新：立即从列表移除，再后台刷新确保数据一致
          setEmployees(prev => prev.filter(e => e.id !== emp.id))
          await loadEmployees()
        } catch {
          message.error(t('common.deleteFailed'))
        }
      },
    })
  }, [modal, message, t, token, loadEmployees, employees])

  const handleCreate = useCallback(() => {
    navigate('/wizard')
  }, [navigate])

  const handleCloseSettings = useCallback(() => {
    setSettingsOpen(false)
    setSelectedEmployeeId(undefined)
  }, [])

  /** 按来源分组：我的 → 内置 → 按插件逐一分组；每组内应用搜索过滤 */
  const groups = useMemo<EmployeeGroup[]>(() => {
    const q = searchQuery.trim().toLowerCase()
    const match = (e: Employee) =>
      !q || e.name.toLowerCase().includes(q) || (e.description || '').toLowerCase().includes(q)

    const result: EmployeeGroup[] = []
    const mine = employees.filter(e => e.source !== 'builtin' && e.source !== 'plugin' && match(e))
    if (mine.length > 0) {
      result.push({ key: 'mine', title: t('digitalEmployees.groupMine', { defaultValue: '我的员工' }), employees: mine })
    }
    const builtin = employees.filter(e => e.source === 'builtin' && match(e))
    if (builtin.length > 0) {
      result.push({ key: 'builtin', title: t('digitalEmployees.groupBuiltin', { defaultValue: '内置员工' }), employees: builtin })
    }
    const pluginMap = new Map<string, Employee[]>()
    for (const e of employees) {
      if (e.source !== 'plugin' || !match(e)) continue
      const pid = e.plugin_id || 'plugin'
      if (!pluginMap.has(pid)) pluginMap.set(pid, [])
      pluginMap.get(pid)!.push(e)
    }
    for (const [pid, list] of pluginMap) {
      result.push({ key: pid, title: list[0].plugin_name || pid, employees: list })
    }
    return result
  }, [employees, searchQuery, t])

  const totalCount = employees.length

  const getCardMenuItems = useCallback((emp: Employee): MenuProps['items'] => {
    if (isRegistered(emp)) {
      // 只读员工：快速任务 + 另存副本（无设置/删除）；禁用时快速任务不可用
      return [
        {
          key: 'task',
          label: t('digitalEmployees.quickChat', { defaultValue: '快速任务' }),
          icon: <MessageOutlined />,
          disabled: emp.is_enabled === false,
        },
        { key: 'duplicate', label: t('digitalEmployees.duplicateCopy', { defaultValue: '另存为我的员工' }), icon: <CopyOutlined /> },
      ]
    }
    return [
      {
        key: 'task',
        label: t('digitalEmployees.quickChat', { defaultValue: '快速任务' }),
        icon: <MessageOutlined />,
        disabled: emp.is_enabled === false,
      },
      { key: 'settings', label: t('common.settings', { defaultValue: '设置' }), icon: <SettingOutlined /> },
      { type: 'divider' },
      { key: 'delete', label: t('common.delete', { defaultValue: '删除' }), icon: <DeleteOutlined />, danger: true },
    ]
  }, [t])

  const handleCardMenuClick = useCallback((emp: Employee, key: string) => {
    if (key === 'task') handleStartTask(emp)
    else if (key === 'settings') handleCardClick(emp)
    else if (key === 'delete') handleDeleteEmployee(emp)
    else if (key === 'duplicate') handleDuplicate(emp)
  }, [handleStartTask, handleCardClick, handleDeleteEmployee, handleDuplicate])

  /** 来源角标文案：内置=官方，插件=插件名 */
  const getSourceBadge = useCallback((emp: Employee): { label: string; color?: string } | null => {
    if (emp.source === 'builtin') {
      return { label: t('digitalEmployees.sourceOfficial', { defaultValue: '官方' }) }
    }
    if (emp.source === 'plugin') {
      return { label: emp.plugin_name || emp.plugin_id || 'Plugin' }
    }
    return null
  }, [t])

  const pageStyle = useMemo(() => `
    .emp-grid .emp-card {
      transition: box-shadow 0.2s ease, border-color 0.2s ease;
      cursor: pointer;
      position: relative;
    }
    .emp-grid .emp-card:hover {
      box-shadow: ${token.boxShadowTertiary};
      border-color: ${token.colorPrimaryBorder};
    }
    .emp-grid .emp-card .emp-card-actions {
      opacity: 0;
      transition: opacity 0.15s ease;
    }
    .emp-grid .emp-card:hover .emp-card-actions {
      opacity: 1;
    }
    .emp-list-row {
      transition: background 0.15s ease;
      cursor: pointer;
    }
    .emp-list-row:hover {
      background: ${token.colorBgTextHover} !important;
    }
  `, [token])

  if (loading) {
    return (
      <div style={{ height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <Spin size="large" />
      </div>
    )
  }

  /** 分组标题 + 组内员工卡片（grid/list 两视图） */
  const renderGroup = (group: EmployeeGroup) => (
    <div key={group.key} style={{ marginBottom: 24 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8, paddingLeft: 2 }}>
        <Text strong style={{ fontSize: 13 }}>
          {group.title}
        </Text>
        <Text type="secondary" style={{ fontSize: 12 }}>
          {group.employees.length}
        </Text>
        {group.key === 'builtin' && (
          <Tooltip title={t('digitalEmployees.builtinHint', { defaultValue: '随应用发布的官方员工，只读；可另存副本后个性化' })}>
            <DatabaseOutlined style={{ fontSize: 12, color: token.colorPrimary }} />
          </Tooltip>
        )}
      </div>

      {viewMode === 'grid' ? (
        <div className="emp-grid" style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))',
          gap: 12,
        }}>
          {group.employees.map((emp) => {
            const color = getAvatarColor(emp.id)
            const empStats = stats[emp.id]
            const convCount = empStats?.conversationCount ?? 0
            const lastActive = formatLastActive(empStats?.lastActiveAt)
            const badge = getSourceBadge(emp)
            return (
              <div
                key={emp.id}
                className="emp-card"
                onClick={() => handleCardClick(emp)}
                style={{
                  border: `1px solid ${token.colorBorderSecondary}`,
                  borderRadius: 8,
                  background: token.colorBgContainer,
                  padding: 16,
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 10,
                }}
              >
                {/* 头部：头像 + 名称 + 来源角标 */}
                <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12 }}>
                  <Avatar
                    size={44}
                    style={{ backgroundColor: color, borderRadius: 8, flexShrink: 0 }}
                    icon={emp.source === 'builtin' ? <DatabaseOutlined style={{ fontSize: 22 }} /> : <RobotOutlined style={{ fontSize: 22 }} />}
                  />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <Text strong ellipsis style={{ fontSize: 14, display: 'block' }}>
                      {emp.name}
                    </Text>
                    {badge && (
                      <Text type="secondary" style={{ fontSize: 11 }}>
                        {badge.label}
                      </Text>
                    )}
                  </div>
                  <div className="emp-card-actions" style={{ flexShrink: 0 }}>
                    <Dropdown
                      menu={{
                        items: getCardMenuItems(emp),
                        onClick: ({ key }) => {
                          handleCardMenuClick(emp, key)
                        },
                      }}
                      trigger={['click']}
                    >
                      <Button
                        type="text"
                        size="small"
                        icon={<EllipsisOutlined />}
                        onClick={(e) => e.stopPropagation()}
                      />
                    </Dropdown>
                  </div>
                </div>

                {/* 描述 */}
                <Paragraph
                  type="secondary"
                  ellipsis={{ rows: 2 }}
                  style={{ fontSize: 12, margin: 0, minHeight: 34, color: token.colorTextTertiary }}
                >
                  {emp.description || t('common.noDescription', { defaultValue: '暂无描述' })}
                </Paragraph>

                {/* 底部统计 */}
                <div style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 12,
                  paddingTop: 8,
                  borderTop: `1px solid ${token.colorBorderSecondary}`,
                  fontSize: 12,
                  color: token.colorTextTertiary,
                }}>
                  <Tooltip title={t('digitalEmployees.conversationCount', { count: convCount, defaultValue: '{{count}} 个对话' })}>
                    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                      <MessageOutlined style={{ fontSize: 12 }} />
                      {convCount}
                    </span>
                  </Tooltip>
                  <Tooltip title={t('digitalEmployees.lastActive', { time: lastActive, defaultValue: '最近活跃：{{time}}' })}>
                    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, minWidth: 0 }}>
                      <ClockCircleOutlined style={{ fontSize: 12, flexShrink: 0 }} />
                      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {lastActive}
                      </span>
                    </span>
                  </Tooltip>
                  {(emp.is_enabled === false || isRegistered(emp)) && (
                    <span style={{ marginLeft: 'auto', color: emp.is_enabled === false ? token.colorError : undefined }}>
                      {emp.is_enabled === false
                        ? t('digitalEmployees.disabledLabel', { defaultValue: '已禁用' })
                        : t('digitalEmployees.readonly', { defaultValue: '只读' })}
                    </span>
                  )}
                </div>
              </div>
            )
          })}
        </div>
      ) : (
        /* 列表视图 */
        <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
          {group.employees.map((emp) => {
            const color = getAvatarColor(emp.id)
            const empStats = stats[emp.id]
            const convCount = empStats?.conversationCount ?? 0
            const lastActive = formatLastActive(empStats?.lastActiveAt)
            const badge = getSourceBadge(emp)
            return (
              <div
                key={emp.id}
                className="emp-list-row"
                onClick={() => handleCardClick(emp)}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 12,
                  padding: '10px 12px',
                  borderRadius: 6,
                  borderBottom: `1px solid ${token.colorBorderSecondary}`,
                }}
              >
                <Avatar
                  size={36}
                  style={{ backgroundColor: color, borderRadius: 6, flexShrink: 0 }}
                  icon={emp.source === 'builtin' ? <DatabaseOutlined style={{ fontSize: 18 }} /> : <RobotOutlined style={{ fontSize: 18 }} />}
                />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <Text strong ellipsis style={{ fontSize: 13 }}>
                      {emp.name}
                    </Text>
                    {badge && (
                      <Text type="secondary" style={{ fontSize: 11, flexShrink: 0 }}>
                        {badge.label}
                      </Text>
                    )}
                  </div>
                  <Text type="secondary" ellipsis style={{ fontSize: 12, display: 'block' }}>
                    {emp.description || t('common.noDescription', { defaultValue: '暂无描述' })}
                  </Text>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 16, fontSize: 12, color: token.colorTextTertiary, flexShrink: 0 }}>
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                    <MessageOutlined style={{ fontSize: 12 }} />
                    {convCount}
                  </span>
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, minWidth: 80 }}>
                    <ClockCircleOutlined style={{ fontSize: 12 }} />
                    {lastActive}
                  </span>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 4, flexShrink: 0 }}>
                  <Tooltip title={t('digitalEmployees.quickChat', { defaultValue: '快速任务' })}>
                    <Button
                      type="text"
                      size="small"
                      icon={<MessageOutlined />}
                      disabled={emp.is_enabled === false}
                      onClick={(e) => { e.stopPropagation(); handleStartTask(emp) }}
                    />
                  </Tooltip>
                  <Dropdown
                    menu={{
                      items: getCardMenuItems(emp),
                      onClick: ({ key }) => handleCardMenuClick(emp, key),
                    }}
                    trigger={['click']}
                  >
                    <Button
                      type="text"
                      size="small"
                      icon={<EllipsisOutlined />}
                      onClick={(e) => e.stopPropagation()}
                    />
                  </Dropdown>
                </div>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
      {/* 工具栏 */}
      <div style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        padding: '10px 16px',
        borderBottom: `1px solid ${token.colorBorderSecondary}`,
        flexShrink: 0,
        gap: 12,
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, minWidth: 0 }}>
          <Text strong style={{ fontSize: 15, flexShrink: 0 }}>
            {t('digitalEmployees.title')}
          </Text>
          <Text type="secondary" style={{ fontSize: 12, flexShrink: 0 }}>
            {totalCount}
          </Text>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
          <Input
            placeholder={t('digitalEmployees.searchPlaceholder')}
            prefix={<SearchOutlined style={{ color: token.colorTextQuaternary }} />}
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            allowClear
            size="small"
            style={{ width: 180 }}
          />
          <Segmented
            size="small"
            value={viewMode}
            onChange={(v) => setViewMode(v as ViewMode)}
            options={[
              { label: '', value: 'grid', icon: <AppstoreOutlined /> },
              { label: '', value: 'list', icon: <BarsOutlined /> },
            ]}
          />
          <Button type="primary" size="small" icon={<PlusOutlined />} onClick={handleCreate}>
            {t('digitalEmployees.createEmployee', { defaultValue: '新建员工' })}
          </Button>
        </div>
      </div>

      {/* 主内容区 */}
      <div style={{ flex: 1, minHeight: 0, overflow: 'auto', padding: 16 }}>
        {employees.length === 0 ? (
          <div style={{ height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <Empty
              image={Empty.PRESENTED_IMAGE_SIMPLE}
              description={
                <span style={{ color: token.colorTextSecondary }}>
                  {t('digitalEmployees.emptyHint', { defaultValue: '还没有数字员工，创建一个开始吧' })}
                </span>
              }
            >
              <Button type="primary" icon={<PlusOutlined />} onClick={handleCreate}>
                {t('digitalEmployees.createFirstEmployee', { defaultValue: '创建第一个员工' })}
              </Button>
            </Empty>
          </div>
        ) : groups.length === 0 ? (
          <div style={{ height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <Empty
              image={Empty.PRESENTED_IMAGE_SIMPLE}
              description={
                <span style={{ color: token.colorTextSecondary }}>
                  {t('tasks.noMatchingTasks', { defaultValue: '没有匹配的结果' })}
                </span>
              }
            />
          </div>
        ) : (
          groups.map(renderGroup)
        )}
      </div>

      <style>{pageStyle}</style>

      <EmployeeSettingsDrawer
        open={settingsOpen}
        employeeId={selectedEmployeeId}
        onClose={handleCloseSettings}
        onDeleted={(deletedId) => {
          setEmployees(prev => prev.filter(e => e.id !== deletedId))
          loadEmployees()
        }}
      />
    </div>
  )
}

export default Employees