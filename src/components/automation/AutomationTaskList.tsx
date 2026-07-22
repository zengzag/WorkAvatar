import { useCallback, useState } from 'react'
import {
  Tag, Button, Space, Tooltip, Popconfirm, Switch, Empty, Spin, Typography, theme, Popover,
} from 'antd'
import {
  PlusOutlined, EditOutlined, DeleteOutlined, PlayCircleOutlined, ClockCircleOutlined,
  FieldTimeOutlined, ThunderboltOutlined, WarningOutlined, UserOutlined, HistoryOutlined,
} from '@ant-design/icons'
import dayjs from 'dayjs'
import { useTranslation } from 'react-i18next'
import type { AutomationTask } from '../../types/automation'

const MS = 1000

interface AutomationTaskListProps {
  tasks: AutomationTask[]
  loading: boolean
  employees: Array<{ id: string; name: string }>
  onCreate: () => void
  onEdit: (task: AutomationTask) => void
  onDelete: (id: string) => void
  onToggle: (id: string, enabled: boolean) => void
  onRunNow: (id: string) => void
  onPreviewRuns: (taskId: string) => Promise<number[]>
}

const STATUS_COLOR: Record<string, string> = {
  idle: 'default',
  running: 'processing',
  success: 'success',
  failed: 'error',
}

const AutomationTaskList: React.FC<AutomationTaskListProps> = ({
  tasks, loading, employees,
  onCreate, onEdit, onDelete, onToggle, onRunNow, onPreviewRuns,
}) => {
  const { t } = useTranslation()
  const { token } = theme.useToken()
  const [previewOpenId, setPreviewOpenId] = useState<string | null>(null)
  const [previewTimes, setPreviewTimes] = useState<number[]>([])

  const employeeName = useCallback((id: string) => employees.find((e) => e.id === id)?.name || id, [employees])

  const handlePreview = useCallback(async (taskId: string) => {
    setPreviewOpenId(taskId)
    const times = await onPreviewRuns(taskId)
    setPreviewTimes(times)
  }, [onPreviewRuns])

  const formatTime = (unixSec: number | null) => {
    if (!unixSec) return '-'
    return dayjs(unixSec * MS).format('YYYY-MM-DD HH:mm')
  }

  if (loading && tasks.length === 0) {
    return (
      <div style={{ padding: 40, textAlign: 'center' }}>
        <Spin />
      </div>
    )
  }

  if (tasks.length === 0) {
    return (
      <div style={{ padding: 40, height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <Empty
          description={t('automation.noTasks')}
          image={Empty.PRESENTED_IMAGE_SIMPLE}
        >
          <Button type="primary" icon={<PlusOutlined />} onClick={onCreate}>
            {t('automation.createTask')}
          </Button>
        </Empty>
      </div>
    )
  }

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
      <div>
        {tasks.map((task) => (
          <div
            key={task.id}
            style={{
              display: 'flex',
              padding: '14px 20px',
              borderBottom: `1px solid ${token.colorBorderSecondary}`,
              flexDirection: 'column',
              alignItems: 'stretch',
              gap: 8,
              transition: 'background 0.2s',
            }}
          >
            {/* 第一行：标题 + 状态徽标 + 操作按钮 */}
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', width: '100%', gap: 12 }}>
              <div style={{ flex: 1, minWidth: 0, display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                <Tooltip title={task.title} mouseEnterDelay={0.4}>
                  <Typography.Text strong style={{ fontSize: 14, maxWidth: 360 }} ellipsis>
                    {task.title}
                  </Typography.Text>
                </Tooltip>
                <Tag color={STATUS_COLOR[task.last_status]} style={{ marginInlineEnd: 0 }}>
                  {t(`automation.status.${task.last_status}`)}
                </Tag>
                {!task.is_enabled && (
                  <Tag style={{ marginInlineEnd: 0 }}>{t('automation.disabled')}</Tag>
                )}
                {task.high_permission && (
                  <Tooltip title={t('automation.highPermissionHint')}>
                    <Tag color="orange" icon={<ThunderboltOutlined />} style={{ marginInlineEnd: 0 }}>
                      {t('automation.highPermissionShort')}
                    </Tag>
                  </Tooltip>
                )}
                {task.notify_on_complete && (
                  <Tag style={{ marginInlineEnd: 0 }}>{t('automation.notifyOn')}</Tag>
                )}
                {task.tags?.map((tag: string) => (
                  <Tag key={tag} color="blue" style={{ marginInlineEnd: 0 }}>{tag}</Tag>
                ))}
              </div>
              <Space size={6} style={{ flexShrink: 0 }}>
                <Tooltip title={t('automation.runNow')}>
                  <Button
                    size="small"
                    type="text"
                    icon={<PlayCircleOutlined />}
                    onClick={() => onRunNow(task.id)}
                    loading={task.last_status === 'running'}
                  />
                </Tooltip>
                <Tooltip title={t('automation.editTask')}>
                  <Button size="small" type="text" icon={<EditOutlined />} onClick={() => onEdit(task)} />
                </Tooltip>
                <Popover
                  open={previewOpenId === task.id}
                  onOpenChange={(open) => {
                    if (open) handlePreview(task.id)
                    else setPreviewOpenId(null)
                  }}
                  trigger="click"
                  placement="left"
                  content={
                    <div style={{ maxWidth: 240 }}>
                      <Typography.Text strong style={{ display: 'block', marginBottom: 8 }}>
                        <HistoryOutlined style={{ marginRight: 6 }} />
                        {t('automation.previewRuns')}
                      </Typography.Text>
                      {previewTimes.length === 0 ? (
                        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                          {t('automation.noPreviewRuns')}
                        </Typography.Text>
                      ) : (
                        previewTimes.map((ts, i) => (
                          <div key={i} style={{ fontSize: 12, padding: '3px 0', color: token.colorTextSecondary }}>
                            {dayjs(ts * MS).format('YYYY-MM-DD HH:mm')}
                          </div>
                        ))
                      )}
                    </div>
                  }
                >
                  <Tooltip title={t('automation.previewRuns')}>
                    <Button size="small" type="text" icon={<ClockCircleOutlined />} />
                  </Tooltip>
                </Popover>
                <Popconfirm
                  title={t('automation.confirmDeleteTask')}
                  onConfirm={() => onDelete(task.id)}
                  okText={t('common.delete')}
                  cancelText={t('common.cancel')}
                  okButtonProps={{ danger: true }}
                >
                  <Tooltip title={t('common.delete')}>
                    <Button size="small" type="text" icon={<DeleteOutlined />} danger />
                  </Tooltip>
                </Popconfirm>
                <Tooltip title={task.is_enabled ? t('automation.disable') : t('automation.enable')}>
                  <Switch
                    size="small"
                    checked={task.is_enabled}
                    onChange={(checked) => onToggle(task.id, checked)}
                  />
                </Tooltip>
              </Space>
            </div>

            {/* 第二行：描述（如有） */}
            {task.description && (
              <Typography.Paragraph
                type="secondary"
                style={{ margin: 0, fontSize: 12, lineHeight: 1.5 }}
                ellipsis={{ rows: 1 }}
              >
                {task.description}
              </Typography.Paragraph>
            )}

            {/* 第三行：元信息（员工、下次运行、上次运行、重复规则） */}
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px 16px', fontSize: 12, color: token.colorTextTertiary }}>
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                <UserOutlined />
                <span style={{ color: token.colorTextSecondary }}>{t('automation.fieldEmployee')}:</span>
                <span>{employeeName(task.employee_id)}</span>
              </span>
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                <FieldTimeOutlined />
                <span style={{ color: token.colorTextSecondary }}>{t('automation.nextRun')}:</span>
                <span>{formatTime(task.next_run_at)}</span>
              </span>
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                <ClockCircleOutlined />
                <span style={{ color: token.colorTextSecondary }}>{t('automation.lastRun')}:</span>
                <span>{formatTime(task.last_run_at)}</span>
              </span>
              {task.recurrence_rule && (
                <Tag style={{ marginInlineEnd: 0, fontSize: 11 }}>
                  {t(`automation.freq.${task.recurrence_rule.freq}`)} × {task.recurrence_rule.interval}
                </Tag>
              )}
            </div>

            {/* 第四行：错误信息（如有） */}
            {task.last_status === 'failed' && task.last_error && (
              <div
                style={{
                  fontSize: 12,
                  color: token.colorError,
                  background: token.colorErrorBg,
                  padding: '4px 8px',
                  borderRadius: 4,
                  display: 'flex',
                  alignItems: 'center',
                  gap: 6,
                }}
              >
                <WarningOutlined />
                <Typography.Text type="danger" style={{ fontSize: 12 }} ellipsis>
                  {task.last_error}
                </Typography.Text>
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  )
}

export default AutomationTaskList
