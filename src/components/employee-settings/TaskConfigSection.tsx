import { useState, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import {
  Card,
  Table,
  Button,
  Space,
  Modal,
  Form,
  Input,
  Switch,
  InputNumber,
  App,
  Tag,
  Popconfirm,
  Tooltip,
  Typography,
  Select,
} from 'antd'
import {
  PlusOutlined,
  EditOutlined,
  DeleteOutlined,
  PlayCircleOutlined,
  ClockCircleOutlined,
  BulbOutlined,
} from '@ant-design/icons'
import dayjs from 'dayjs'
import LLMSelector from '../llm/LLMSelector'
import ExecutionDetailModal from './ExecutionDetailModal'

const { Text } = Typography

interface TaskItem {
  id: string
  name: string
  description: string
  prompt: string
  is_enabled: boolean
  timeout_ms: number
  llm_provider_id: string | null
  llm_model: string | null
  enable_thinking: boolean
  extra_config_json: string
  created_at: number
  updated_at: number
}

interface ExecutionItem {
  id: string
  task_id: string
  trigger_type: 'manual' | 'scheduled'
  status: 'running' | 'completed' | 'failed' | 'timeout'
  result_text: string | null
  error_message: string | null
  segments_json: string | null
  started_at: number
  completed_at: number | null
  duration_ms: number | null
}

interface TaskConfigSectionProps {
  employeeId: string
}

const TaskConfigSection: React.FC<TaskConfigSectionProps> = ({ employeeId }) => {
  const { t } = useTranslation()
  const { message } = App.useApp()
  const [tasks, setTasks] = useState<TaskItem[]>([])
  const [loading, setLoading] = useState(false)
  const [modalOpen, setModalOpen] = useState(false)
  const [editingTask, setEditingTask] = useState<TaskItem | null>(null)
  const [executingTaskId, setExecutingTaskId] = useState<string | null>(null)
  const [form] = Form.useForm()

  const [taskProviderId, setTaskProviderId] = useState<string | undefined>(undefined)
  const [taskModelId, setTaskModelId] = useState<string | undefined>(undefined)

  const [execModalOpen, setExecModalOpen] = useState(false)
  const [selectedTaskExecs, setSelectedTaskExecs] = useState<ExecutionItem[]>([])
  const [selectedTaskName, setSelectedTaskName] = useState('')

  const [detailModalOpen, setDetailModalOpen] = useState(false)
  const [detailExecution, setDetailExecution] = useState<ExecutionItem | null>(null)

  useEffect(() => {
    loadTasks()
  }, [employeeId])

  const loadTasks = async () => {
    setLoading(true)
    try {
      const result = await window.electronAPI.employeeTask.list(employeeId)
      setTasks(result || [])
    } catch {
      message.error(t('empTask.loadFailed'))
    } finally {
      setLoading(false)
    }
  }

  const handleCreate = () => {
    setEditingTask(null)
    form.resetFields()
    form.setFieldsValue({ timeout_ms: 300000, is_enabled: true, enable_thinking: false })
    setTaskProviderId(undefined)
    setTaskModelId(undefined)
    setModalOpen(true)
  }

  const handleEdit = (task: TaskItem) => {
    setEditingTask(task)
    form.setFieldsValue({
      name: task.name,
      description: task.description,
      prompt: task.prompt,
      timeout_ms: task.timeout_ms,
      is_enabled: task.is_enabled,
      enable_thinking: task.enable_thinking,
    })
    setTaskProviderId(task.llm_provider_id || undefined)
    setTaskModelId(task.llm_model || undefined)
    setModalOpen(true)
  }

  const handleSave = async (values: any) => {
    try {
      const data = {
        ...values,
        llm_provider_id: taskProviderId || null,
        llm_model: taskModelId || null,
      }
      if (editingTask) {
        await window.electronAPI.employeeTask.update({
          id: editingTask.id,
          ...data,
        })
        message.success(t('common.updateSuccess'))
      } else {
        await window.electronAPI.employeeTask.create({
          employee_id: employeeId,
          ...data,
        })
        message.success(t('common.createSuccess'))
      }
      setModalOpen(false)
      loadTasks()
    } catch {
      message.error(t('common.saveFailed'))
    }
  }

  const handleDelete = async (taskId: string) => {
    try {
      await window.electronAPI.employeeTask.delete(taskId)
      message.success(t('common.deleteSuccess'))
      loadTasks()
    } catch {
      message.error(t('common.deleteFailed'))
    }
  }

  const handleToggleEnabled = async (taskId: string, enabled: boolean) => {
    try {
      await window.electronAPI.employeeTask.update({ id: taskId, is_enabled: enabled })
      loadTasks()
    } catch {
      message.error(t('common.failed'))
    }
  }

  const handleExecute = async (taskId: string) => {
    setExecutingTaskId(taskId)
    try {
      const result = await window.electronAPI.employeeTask.execute(taskId)
      if (result.success) {
        message.success(t('empTask.executeSuccess'))
      } else {
        message.error(result.error || t('empTask.executeFailed'))
      }
      loadTasks()
    } catch {
      message.error(t('empTask.executeFailed'))
    } finally {
      setExecutingTaskId(null)
    }
  }

  const handleViewExecutions = async (task: TaskItem) => {
    try {
      const result = await window.electronAPI.employeeTask.listExecutionsForTask({ task_id: task.id, limit: 20 })
      setSelectedTaskExecs(result || [])
      setSelectedTaskName(task.name)
      setExecModalOpen(true)
    } catch {
      message.error(t('empTask.loadExecFailed'))
    }
  }

  const handleViewDetail = (exec: ExecutionItem) => {
    setDetailExecution(exec)
    setDetailModalOpen(true)
  }

  const handleDeleteExecution = async (execId: string) => {
    try {
      await window.electronAPI.employeeTask.deleteExecution(execId)
      message.success(t('common.deleteSuccess'))
      setSelectedTaskExecs(prev => prev.filter(e => e.id !== execId))
    } catch {
      message.error(t('common.deleteFailed'))
    }
  }

  const statusTag = (status: string) => {
    const colorMap: Record<string, string> = { running: 'processing', completed: 'success', failed: 'error', timeout: 'warning' }
    const labelMap: Record<string, string> = {
      running: t('empTask.statusRunning'),
      completed: t('empTask.statusCompleted'),
      failed: t('empTask.statusFailed'),
      timeout: t('empTask.statusTimeout'),
    }
    return <Tag color={colorMap[status] || 'default'}>{labelMap[status] || status}</Tag>
  }

  const columns = [
    {
      title: t('common.name'),
      dataIndex: 'name',
      key: 'name',
      ellipsis: true,
      render: (name: string, record: TaskItem) => (
        <div>
          <Text strong>{name}</Text>
          {record.description && <div><Text type="secondary" style={{ fontSize: 12 }}>{record.description}</Text></div>}
        </div>
      ),
    },
    {
      title: t('common.status'),
      dataIndex: 'is_enabled',
      key: 'is_enabled',
      width: 70,
      render: (enabled: boolean, record: TaskItem) => (
        <Switch size="small" checked={enabled} onChange={(v) => handleToggleEnabled(record.id, v)} />
      ),
    },
    {
      title: t('common.action'),
      key: 'action',
      width: 180,
      fixed: 'right',
      render: (_: any, record: TaskItem) => (
        <Space size="small">
          <Tooltip title={t('empTask.run')}>
            <Button
              type="link"
              size="small"
              icon={<PlayCircleOutlined />}
              loading={executingTaskId === record.id}
              disabled={!record.is_enabled || !!executingTaskId}
              onClick={() => handleExecute(record.id)}
            />
          </Tooltip>
          <Tooltip title={t('empTask.history')}>
            <Button
              type="link"
              size="small"
              icon={<ClockCircleOutlined />}
              onClick={() => handleViewExecutions(record)}
            />
          </Tooltip>
          <Tooltip title={t('common.edit')}>
            <Button
              type="link"
              size="small"
              icon={<EditOutlined />}
              onClick={() => handleEdit(record)}
            />
          </Tooltip>
          <Popconfirm
            title={t('common.confirmDelete')}
            onConfirm={() => handleDelete(record.id)}
            okText={t('common.confirm')}
            cancelText={t('common.cancel')}
          >
            <Tooltip title={t('common.delete')}>
              <Button type="link" size="small" danger icon={<DeleteOutlined />} />
            </Tooltip>
          </Popconfirm>
        </Space>
      ),
    },
  ]

  const execColumns = [
    {
      title: t('empTask.triggerType'),
      dataIndex: 'trigger_type',
      key: 'trigger_type',
      width: 90,
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
      width: 140,
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
      width: 120,
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
  ]

  return (
    <div>
      <Card
        title={t('empTask.taskConfigTitle')}
        extra={
          <Button type="primary" icon={<PlusOutlined />} onClick={handleCreate}>
            {t('empTask.createTask')}
          </Button>
        }
      >
        <Table
          dataSource={tasks}
          columns={columns}
          rowKey="id"
          loading={loading}
          pagination={false}
          size="small"
          scroll={{ x: 'max-content' }}
          locale={{ emptyText: t('empTask.noTasks') }}
        />
      </Card>

      <Modal
        open={modalOpen}
        title={editingTask ? t('empTask.editTask') : t('empTask.createTask')}
        okText={t('common.save')}
        cancelText={t('common.cancel')}
        onOk={() => form.submit()}
        onCancel={() => setModalOpen(false)}
        width={720}
      >
        <Form form={form} layout="vertical" onFinish={handleSave} style={{ marginTop: 16 }}>
          <Form.Item name="name" label={t('common.name')} rules={[{ required: true, message: t('empTask.nameRequired') }]}>
            <Input placeholder={t('empTask.namePlaceholder')} />
          </Form.Item>
          <Form.Item name="description" label={t('common.description')}>
            <Input.TextArea rows={2} placeholder={t('empTask.descPlaceholder')} />
          </Form.Item>
          <Form.Item name="prompt" label={t('empTask.prompt')} rules={[{ required: true, message: t('empTask.promptRequired') }]}>
            <Input.TextArea rows={5} placeholder={t('empTask.promptPlaceholder')} />
          </Form.Item>
          <Form.Item label={t('empTask.llmConfigLabel')}>
            <LLMSelector
              providerId={taskProviderId}
              modelId={taskModelId}
              onProviderChange={setTaskProviderId}
              onModelChange={setTaskModelId}
            />
            <Text type="secondary" style={{ fontSize: 12, marginLeft: 8 }}>{t('empTask.llmConfigTip')}</Text>
          </Form.Item>
          <Form.Item name="enable_thinking" label={t('empTask.thinkingModeLabel')} valuePropName="checked">
            <Switch />
          </Form.Item>
          <Form.Item name="timeout_ms" label={t('empTask.timeoutLabel')}>
            <InputNumber min={10000} max={3600000} step={10000} addonAfter="ms" style={{ width: '100%' }} />
          </Form.Item>
          <Form.Item name="is_enabled" label={t('empTask.enabledLabel')} valuePropName="checked">
            <Switch />
          </Form.Item>
        </Form>
      </Modal>

      <Modal
        open={execModalOpen}
        title={`${t('empTask.execHistory')} - ${selectedTaskName}`}
        onCancel={() => setExecModalOpen(false)}
        footer={null}
        width={800}
      >
        <Table
          dataSource={selectedTaskExecs}
          columns={execColumns}
          rowKey="id"
          pagination={false}
          size="small"
          locale={{ emptyText: t('empTask.noExecutions') }}
        />
      </Modal>

      <ExecutionDetailModal
        open={detailModalOpen}
        execution={detailExecution}
        onClose={() => setDetailModalOpen(false)}
      />
    </div>
  )
}

export default TaskConfigSection
