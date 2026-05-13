import { useState, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import {
  Card,
  Table,
  Tag,
  Button,
  Space,
  Typography,
  Tooltip,
  Badge,
  Popconfirm,
  Select,
  theme,
} from 'antd'
import {
  CheckCircleOutlined,
  CloseCircleOutlined,
  ExclamationCircleOutlined,
  LoadingOutlined,
  ReloadOutlined,
  AlertOutlined,
  DeleteOutlined,
  FieldTimeOutlined,
} from '@ant-design/icons'
import dayjs from 'dayjs'
import ExecutionDetailModal from '../employee-settings/ExecutionDetailModal'

const { Text } = Typography

interface ExecutionItem {
  id: string
  employee_id: string
  task_id: string
  schedule_id: string | null
  trigger_type: 'manual' | 'scheduled'
  status: 'running' | 'completed' | 'failed' | 'timeout'
  result_text: string | null
  error_message: string | null
  segments_json: string | null
  started_at: number
  completed_at: number | null
  duration_ms: number | null
}

interface EmployeeInfo {
  id: string
  name: string
}

interface TaskInfo {
  id: string
  name: string
}

const GlobalTaskCenter: React.FC = () => {
  const { t } = useTranslation()
  const { token } = theme.useToken()
  const [executions, setExecutions] = useState<ExecutionItem[]>([])
  const [failedExecs, setFailedExecs] = useState<ExecutionItem[]>([])
  const [loading, setLoading] = useState(false)
  const [employeeMap, setEmployeeMap] = useState<Record<string, EmployeeInfo>>({})
  const [taskMap, setTaskMap] = useState<Record<string, TaskInfo>>({})

  const [detailModalOpen, setDetailModalOpen] = useState(false)
  const [detailExecution, setDetailExecution] = useState<ExecutionItem | null>(null)

  const [filterStatus, setFilterStatus] = useState<string | undefined>(undefined)
  const [filterEmployee, setFilterEmployee] = useState<string | undefined>(undefined)
  const [filterTrigger, setFilterTrigger] = useState<string | undefined>(undefined)

  useEffect(() => {
    loadData()
    const interval = setInterval(loadData, 30000)
    return () => clearInterval(interval)
  }, [])

  const loadData = async () => {
    setLoading(true)
    try {
      const [execs, failed] = await Promise.all([
        window.electronAPI.employeeTask.allRecentExecutions(100),
        window.electronAPI.employeeTask.failedExecutions(30),
      ])
      setExecutions(execs || [])
      setFailedExecs(failed || [])

      const empIds = new Set<string>()
      const taskIds = new Set<string>()
      for (const e of (execs || [])) {
        if (e.employee_id) empIds.add(e.employee_id)
        if (e.task_id) taskIds.add(e.task_id)
      }

      const employees = await window.electronAPI.employee.list()
      const empMap: Record<string, EmployeeInfo> = {}
      for (const emp of (employees || [])) {
        empMap[emp.id] = { id: emp.id, name: emp.name }
      }
      setEmployeeMap(empMap)

      const tMap: Record<string, TaskInfo> = {}
      for (const tid of taskIds) {
        try {
          const task = await window.electronAPI.employeeTask.get(tid)
          if (task) tMap[tid] = { id: task.id, name: task.name }
        } catch {}
      }
      setTaskMap(tMap)
    } catch {
    } finally {
      setLoading(false)
    }
  }

  const handleViewDetail = (exec: ExecutionItem) => {
    setDetailExecution(exec)
    setDetailModalOpen(true)
  }

  const handleDeleteExecution = async (execId: string) => {
    try {
      await window.electronAPI.employeeTask.deleteExecution(execId)
      setExecutions(prev => prev.filter(e => e.id !== execId))
      setFailedExecs(prev => prev.filter(e => e.id !== execId))
    } catch {}
  }

  const statusTag = (status: string) => {
    const colorMap: Record<string, string> = { running: 'processing', completed: 'success', failed: 'error', timeout: 'warning' }
    const labelMap: Record<string, string> = {
      running: t('empTask.statusRunning'),
      completed: t('empTask.statusCompleted'),
      failed: t('empTask.statusFailed'),
      timeout: t('empTask.statusTimeout'),
    }
    const iconMap: Record<string, React.ReactNode> = {
      running: <LoadingOutlined style={{ color: token.colorPrimary }} />,
      completed: <CheckCircleOutlined style={{ color: token.colorSuccess }} />,
      failed: <CloseCircleOutlined style={{ color: token.colorError }} />,
      timeout: <ExclamationCircleOutlined style={{ color: token.colorWarning }} />,
    }
    return <Tag color={colorMap[status] || 'default'} icon={iconMap[status]}>{labelMap[status] || status}</Tag>
  }

  const filteredExecutions = executions.filter(e => {
    if (filterStatus && e.status !== filterStatus) return false
    if (filterEmployee && e.employee_id !== filterEmployee) return false
    if (filterTrigger && e.trigger_type !== filterTrigger) return false
    return true
  })

  const employeeOptions = Object.entries(employeeMap).map(([id, emp]) => ({ label: emp.name, value: id }))

  const columns = [
    {
      title: t('empTask.employee'),
      dataIndex: 'employee_id',
      key: 'employee_id',
      width: 110,
      render: (id: string) => employeeMap[id]?.name || id.slice(0, 8),
    },
    {
      title: t('empTask.taskName'),
      dataIndex: 'task_id',
      key: 'task_id',
      width: 110,
      render: (id: string) => taskMap[id]?.name || id.slice(0, 8),
    },
    {
      title: t('empTask.triggerType'),
      dataIndex: 'trigger_type',
      key: 'trigger_type',
      width: 80,
      render: (v: string) => (
        <Tag color={v === 'manual' ? 'blue' : 'purple'}>
          {v === 'manual' ? t('empTask.manual') : t('empTask.scheduled')}
        </Tag>
      ),
    },
    {
      title: t('common.status'),
      dataIndex: 'status',
      key: 'status',
      width: 100,
      render: (status: string) => statusTag(status),
    },
    {
      title: t('empTask.startedAt'),
      dataIndex: 'started_at',
      key: 'started_at',
      width: 130,
      render: (v: number) => dayjs(v * 1000).format('MM-DD HH:mm:ss'),
    },
    {
      title: t('empTask.duration'),
      dataIndex: 'duration_ms',
      key: 'duration_ms',
      width: 80,
      render: (v: number | null) => v != null ? `${(v / 1000).toFixed(1)}s` : '-',
    },
    {
      title: t('common.action'),
      key: 'action',
      width: 100,
      render: (_: any, record: ExecutionItem) => (
        <Space size="small">
          <Button type="link" size="small" onClick={() => handleViewDetail(record)}>
            {t('empTask.detail')}
          </Button>
          <Popconfirm
            title={t('common.confirmDelete')}
            onConfirm={() => handleDeleteExecution(record.id)}
            okText={t('common.confirm')}
            cancelText={t('common.cancel')}
          >
            <Button type="link" size="small" danger icon={<DeleteOutlined />} />
          </Popconfirm>
        </Space>
      ),
    },
    {
      title: t('empTask.error'),
      dataIndex: 'error_message',
      key: 'error_message',
      width: 160,
      render: (v: string | null) => v ? (
        <Tooltip title={v}>
          <Text type="danger" style={{ fontSize: 12, display: 'inline-block', maxWidth: 140, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {v}
          </Text>
        </Tooltip>
      ) : <Text type="secondary">-</Text>,
    },
  ]

  return (
    <Card
      title={
        <Space>
          <FieldTimeOutlined />
          <span>{t('empTask.globalTaskCenter')}</span>
          {failedExecs.length > 0 && (
            <Badge count={failedExecs.length} size="small">
              <AlertOutlined style={{ color: token.colorError }} />
            </Badge>
          )}
        </Space>
      }
      extra={
        <Button size="small" icon={<ReloadOutlined />} loading={loading} onClick={loadData}>
          {t('common.refresh')}
        </Button>
      }
      size="small"
    >
      {failedExecs.length > 0 && (
        <div style={{ marginBottom: 12 }}>
          <Tag color="error" icon={<AlertOutlined />}>
            {t('empTask.failedAlert', { count: failedExecs.length })}
          </Tag>
        </div>
      )}

      <div style={{ marginBottom: 12, display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <Select
          allowClear
          placeholder={t('empTask.filterStatus')}
          value={filterStatus}
          onChange={setFilterStatus}
          style={{ width: 120 }}
          size="small"
          options={[
            { label: t('empTask.statusRunning'), value: 'running' },
            { label: t('empTask.statusCompleted'), value: 'completed' },
            { label: t('empTask.statusFailed'), value: 'failed' },
            { label: t('empTask.statusTimeout'), value: 'timeout' },
          ]}
        />
        <Select
          allowClear
          placeholder={t('empTask.filterEmployee')}
          value={filterEmployee}
          onChange={setFilterEmployee}
          style={{ width: 140 }}
          size="small"
          options={employeeOptions}
          showSearch
          optionFilterProp="label"
        />
        <Select
          allowClear
          placeholder={t('empTask.filterTriggerType')}
          value={filterTrigger}
          onChange={setFilterTrigger}
          style={{ width: 120 }}
          size="small"
          options={[
            { label: t('empTask.manual'), value: 'manual' },
            { label: t('empTask.scheduled'), value: 'scheduled' },
          ]}
        />
      </div>

      <Table
        dataSource={filteredExecutions}
        columns={columns}
        rowKey="id"
        loading={loading}
        size="small"
        pagination={{ pageSize: 10, size: 'small' }}
        locale={{ emptyText: t('empTask.noExecutions') }}
        scroll={{ x: 'max-content' }}
      />

      <ExecutionDetailModal
        open={detailModalOpen}
        execution={detailExecution}
        onClose={() => setDetailModalOpen(false)}
      />
    </Card>
  )
}

export default GlobalTaskCenter
