import { useCallback } from 'react'
import {
  List, Tag, Button, Space, Tooltip, Popconfirm, Empty, Spin, Typography, theme,
} from 'antd'
import {
  DeleteOutlined, ArrowRightOutlined, ClockCircleOutlined, WarningOutlined,
  CalendarOutlined, ClearOutlined, UserOutlined, FieldTimeOutlined, HourglassOutlined,
} from '@ant-design/icons'
import dayjs from 'dayjs'
import { useTranslation } from 'react-i18next'
import type { AutomationRun } from '../../types/automation'

const MS = 1000

interface AutomationHistoryListProps {
  runs: AutomationRun[]
  loading: boolean
  employees: Array<{ id: string; name: string }>
  tasks: Array<{ id: string; title: string }>
  onDelete: (id: string) => void
  onClearAll: () => void
  onJump: (run: AutomationRun) => void
}

const STATUS_COLOR: Record<string, string> = {
  running: 'processing',
  success: 'success',
  failed: 'error',
}

const TRIGGER_ICON: Record<string, React.ReactNode> = {
  scheduler: <ClockCircleOutlined />,
  manual: <FieldTimeOutlined />,
}

const AutomationHistoryList: React.FC<AutomationHistoryListProps> = ({
  runs, loading, employees, tasks,
  onDelete, onClearAll, onJump,
}) => {
  const { t } = useTranslation()
  const { token } = theme.useToken()

  const employeeName = useCallback((id: string) => employees.find((e) => e.id === id)?.name || id, [employees])
  const taskTitle = useCallback((id: string) => tasks.find((tk) => tk.id === id)?.title || id, [tasks])

  const formatTime = (unixSec: number | null) => {
    if (!unixSec) return '-'
    return dayjs(unixSec * MS).format('YYYY-MM-DD HH:mm:ss')
  }

  const formatDuration = (ms: number | null) => {
    if (ms == null) return '-'
    if (ms < 1000) return `${ms}ms`
    if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`
    const m = Math.floor(ms / 60000)
    const s = Math.floor((ms % 60000) / 1000)
    return `${m}m ${s}s`
  }

  if (loading && runs.length === 0) {
    return (
      <div style={{ padding: 40, textAlign: 'center' }}>
        <Spin />
      </div>
    )
  }

  if (runs.length === 0) {
    return (
      <div style={{ padding: 40, height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <Empty
          description={t('automation.noRuns')}
          image={Empty.PRESENTED_IMAGE_SIMPLE}
        />
      </div>
    )
  }

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
      <div
        style={{
          padding: '8px 20px',
          borderBottom: `1px solid ${token.colorBorderSecondary}`,
          display: 'flex',
          justifyContent: 'flex-end',
          background: token.colorFillQuaternary,
        }}
      >
        <Popconfirm
          title={t('automation.confirmClearRuns')}
          onConfirm={onClearAll}
          okText={t('common.clear')}
          cancelText={t('common.cancel')}
          okButtonProps={{ danger: true }}
        >
          <Button size="small" icon={<ClearOutlined />} danger>
            {t('automation.clearAll')}
          </Button>
        </Popconfirm>
      </div>
      <List
        dataSource={runs}
        renderItem={(run) => (
          <List.Item
            style={{
              padding: '14px 20px',
              borderBottom: `1px solid ${token.colorBorderSecondary}`,
              flexDirection: 'column',
              alignItems: 'stretch',
              gap: 8,
              transition: 'background 0.2s',
            }}
          >
            {/* 第一行：任务标题 + 状态 + 触发方式 + 操作 */}
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', width: '100%', gap: 12 }}>
              <div style={{ flex: 1, minWidth: 0, display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                <Typography.Text strong style={{ fontSize: 14 }} ellipsis>
                  {taskTitle(run.task_id)}
                </Typography.Text>
                <Tag color={STATUS_COLOR[run.status]} style={{ marginInlineEnd: 0 }}>
                  {t(`automation.runStatus.${run.status}`)}
                </Tag>
                <Tag style={{ marginInlineEnd: 0 }}>
                  {TRIGGER_ICON[run.triggered_by]}
                  <span style={{ marginLeft: 4 }}>{t(`automation.triggeredBy.${run.triggered_by}`)}</span>
                </Tag>
              </div>
              <Space size={6} style={{ flexShrink: 0 }}>
                {run.conversation_id && (
                  <Button
                    size="small"
                    type="link"
                    icon={<ArrowRightOutlined />}
                    onClick={() => onJump(run)}
                  >
                    {t('automation.viewConversation')}
                  </Button>
                )}
                <Popconfirm
                  title={t('automation.confirmDeleteRun')}
                  onConfirm={() => onDelete(run.id)}
                  okText={t('common.delete')}
                  cancelText={t('common.cancel')}
                  okButtonProps={{ danger: true }}
                >
                  <Tooltip title={t('common.delete')}>
                    <Button size="small" type="text" icon={<DeleteOutlined />} danger />
                  </Tooltip>
                </Popconfirm>
              </Space>
            </div>

            {/* 第二行：元信息 */}
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px 16px', fontSize: 12, color: token.colorTextTertiary }}>
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                <UserOutlined />
                <span style={{ color: token.colorTextSecondary }}>{t('automation.fieldEmployee')}:</span>
                <span>{employeeName(run.employee_id)}</span>
              </span>
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                <CalendarOutlined />
                <span style={{ color: token.colorTextSecondary }}>{t('automation.startedAt')}:</span>
                <span>{formatTime(run.started_at)}</span>
              </span>
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                <HourglassOutlined />
                <span style={{ color: token.colorTextSecondary }}>{t('automation.duration')}:</span>
                <span>{formatDuration(run.duration_ms)}</span>
              </span>
            </div>

            {/* 第三行：错误信息（如有） */}
            {run.status === 'failed' && run.error_message && (
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
                  {run.error_message}
                </Typography.Text>
              </div>
            )}
          </List.Item>
        )}
      />
    </div>
  )
}

export default AutomationHistoryList
