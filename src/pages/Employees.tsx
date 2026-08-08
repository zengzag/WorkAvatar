import { useState, useEffect, useCallback, useMemo } from 'react'
import { useNavigate, useLocation } from 'react-router-dom'
import { Input, Button, Empty, Spin, App, theme, Typography, Checkbox, Tooltip, Segmented, Dropdown, Avatar } from 'antd'
import type { MenuProps } from 'antd'
import {
  PlusOutlined, RobotOutlined, DeleteOutlined, MessageOutlined, ClockCircleOutlined,
  FolderOpenOutlined, SettingOutlined, SearchOutlined, EllipsisOutlined,
  AppstoreOutlined, BarsOutlined,
} from '@ant-design/icons'
import { useTranslation } from 'react-i18next'
import EmployeeSettingsDrawer from '../components/employee-settings/EmployeeSettingsDrawer'
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

  // 员工变更事件：刷新列表（含增/改/删及其他页面触发的删除）
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
    setSelectedEmployeeId(emp.id)
    setSettingsOpen(true)
  }, [])

  const handleStartTask = useCallback((emp: Employee) => {
    // 清除该员工的恢复对话缓存，确保任务页以全新状态打开
    localStorage.removeItem(`employeeWorkbench:activeConvId:${emp.id}`)
    navigate(`/tasks?new=1&employee=${encodeURIComponent(emp.id)}`)
  }, [navigate])

  const handleDeleteEmployee = useCallback((emp: Employee) => {
    let deleteWorkspace = true
    const workspacePath = emp.workspace_path

    modal.confirm({
      title: t('employeeSettings.confirmDeleteEmployee'),
      icon: null,
      width: 520,
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
          {workspacePath && (
            <Checkbox
              defaultChecked
              onChange={(e) => { deleteWorkspace = e.target.checked }}
              style={{ marginTop: 12 }}
            >
              {t('employeeSettings.alsoDeleteWorkspace')}
            </Checkbox>
          )}
        </div>
      ),
      okText: t('common.delete'),
      cancelText: t('common.cancel'),
      okButtonProps: { danger: true },
      onOk: async () => {
        try {
          await window.electronAPI.employee.delete({
            id: emp.id,
            delete_workspace: deleteWorkspace,
          })
          message.success(t('common.deleted'))
          // 乐观更新：立即从列表移除，再后台刷新确保数据一致
          setEmployees(prev => prev.filter(e => e.id !== emp.id))
          await loadEmployees()
        } catch {
          message.error(t('common.deleteFailed'))
        }
      },
    })
  }, [modal, message, t, token, loadEmployees])

  const handleCreate = useCallback(() => {
    navigate('/wizard')
  }, [navigate])

  const handleCloseSettings = useCallback(() => {
    setSettingsOpen(false)
    setSelectedEmployeeId(undefined)
  }, [])

  const filteredEmployees = useMemo(() => {
    let result = employees
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase()
      result = result.filter(e =>
        e.name.toLowerCase().includes(q) ||
        (e.description || '').toLowerCase().includes(q)
      )
    }
    return result
  }, [employees, searchQuery])

  const totalCount = employees.length

  const getCardMenuItems = useCallback((): MenuProps['items'] => [
    { key: 'task', label: t('digitalEmployees.quickChat', { defaultValue: '快速任务' }), icon: <MessageOutlined /> },
    { key: 'settings', label: t('common.settings', { defaultValue: '设置' }), icon: <SettingOutlined /> },
    { type: 'divider' },
    { key: 'delete', label: t('common.delete', { defaultValue: '删除' }), icon: <DeleteOutlined />, danger: true },
  ], [t])

  const handleCardMenuClick = useCallback((emp: Employee, key: string) => {
    if (key === 'task') handleStartTask(emp)
    else if (key === 'settings') handleCardClick(emp)
    else if (key === 'delete') handleDeleteEmployee(emp)
  }, [handleStartTask, handleCardClick, handleDeleteEmployee])

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
        ) : filteredEmployees.length === 0 ? (
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
        ) : viewMode === 'grid' ? (
          <div className="emp-grid" style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))',
            gap: 12,
          }}>
            {filteredEmployees.map((emp) => {
              const color = getAvatarColor(emp.id)
              const empStats = stats[emp.id]
              const convCount = empStats?.conversationCount ?? 0
              const lastActive = formatLastActive(empStats?.lastActiveAt)
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
                  {/* 头部：头像 + 名称 */}
                  <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12 }}>
                    <Avatar
                      size={44}
                      style={{ backgroundColor: color, borderRadius: 8, flexShrink: 0 }}
                      icon={<RobotOutlined style={{ fontSize: 22 }} />}
                    />
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <Text strong ellipsis style={{ fontSize: 14, display: 'block' }}>
                        {emp.name}
                      </Text>
                    </div>
                    <div className="emp-card-actions" style={{ flexShrink: 0 }}>
                      <Dropdown
                        menu={{
                          items: getCardMenuItems(),
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
                  </div>
                </div>
              )
            })}
          </div>
        ) : (
          /* 列表视图 */
          <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
            {filteredEmployees.map((emp) => {
              const color = getAvatarColor(emp.id)
              const empStats = stats[emp.id]
              const convCount = empStats?.conversationCount ?? 0
              const lastActive = formatLastActive(empStats?.lastActiveAt)
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
                    icon={<RobotOutlined style={{ fontSize: 18 }} />}
                  />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <Text strong ellipsis style={{ fontSize: 13, display: 'block' }}>
                      {emp.name}
                    </Text>
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
                        onClick={(e) => { e.stopPropagation(); handleStartTask(emp) }}
                      />
                    </Tooltip>
                    <Dropdown
                      menu={{
                        items: getCardMenuItems(),
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
