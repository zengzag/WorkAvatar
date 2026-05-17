import { useEffect, useState } from 'react'
import {
  Card,
  Button,
  Table,
  App,
  Space,
  Typography,
  Modal,
  Input,
  Tag,
  theme,
} from 'antd'
import {
  ApartmentOutlined,
  PlusOutlined,
  DeleteOutlined,
  EditOutlined,
  PlayCircleOutlined,
} from '@ant-design/icons'
import { useNavigate } from 'react-router-dom'
import PageHeader from '../components/common/PageHeader'
import EmptyState from '../components/common/EmptyState'
import dayjs from 'dayjs'
import { useTranslation } from 'react-i18next'

const { Text } = Typography

const WorkflowList: React.FC = () => {
  const navigate = useNavigate()
  const { token } = theme.useToken()
  const { t } = useTranslation()
  const { message } = App.useApp()
  const [workflows, setWorkflows] = useState<any[]>([])
  const [loadingTable, setLoadingTable] = useState(false)
  const [createModalOpen, setCreateModalOpen] = useState(false)
  const [deleteModalOpen, setDeleteModalOpen] = useState(false)
  const [deleteWorkflow, setDeleteWorkflow] = useState<any>(null)
  const [newWorkflowName, setNewWorkflowName] = useState('')
  const [newWorkflowDesc, setNewWorkflowDesc] = useState('')

  useEffect(() => {
    loadWorkflows()
  }, [])

  const loadWorkflows = async () => {
    setLoadingTable(true)
    try {
      const result = await window.electronAPI.workflow.list()
      setWorkflows(Array.isArray(result) ? result : [])
    } catch (error) {
      console.error('Failed to load workflows:', error)
      message.error(t('workflow.loadFailed'))
    } finally {
      setLoadingTable(false)
    }
  }

  const handleCreateWorkflow = () => {
    setNewWorkflowName(t('workflow.defaultWorkflowName', { date: dayjs().format('MMDDHHmm') }))
    setNewWorkflowDesc('')
    setCreateModalOpen(true)
  }

  const confirmCreateWorkflow = async () => {
    if (!newWorkflowName.trim()) {
      message.error(t('workflow.namePlaceholder'))
      return
    }
    try {
      const workflow = await window.electronAPI.workflow.create({
        name: newWorkflowName,
        description: newWorkflowDesc,
      })
      message.success(t('workflow.createSuccess'))
      setCreateModalOpen(false)
      navigate(`/workflow/${workflow.id}`)
    } catch (error) {
      console.error('Failed to create workflow:', error)
      message.error(t('workflow.createFailed'))
    }
  }

  const handleDeleteWorkflow = (workflow: any) => {
    setDeleteWorkflow(workflow)
    setDeleteModalOpen(true)
  }

  const confirmDeleteWorkflow = async () => {
    if (!deleteWorkflow) return
    try {
      await window.electronAPI.workflow.delete(deleteWorkflow.id)
      setWorkflows(workflows.filter((w) => w.id !== deleteWorkflow.id))
      message.success(t('workflow.deleteSuccess'))
      setDeleteModalOpen(false)
      setDeleteWorkflow(null)
    } catch (error) {
      console.error('Failed to delete workflow:', error)
      message.error(t('workflow.deleteFailed'))
    }
  }

  const handleRunWorkflow = async (workflow: any) => {
    try {
      const result = await window.electronAPI.workflow.execute(workflow.id)
      if (result.success) {
        message.success(t('workflow.runSuccess'))
        navigate(`/workflow/${workflow.id}`)
      } else {
        message.error(result.error || t('workflow.runFailed'))
      }
    } catch (error) {
      console.error('Failed to run workflow:', error)
      message.error(t('workflow.runFailed'))
    }
  }

  const getStatusTag = (status: string) => {
    const map: Record<string, { color: string; label: string }> = {
      draft: { color: 'default', label: t('workflow.statusPending') },
      active: { color: 'green', label: t('workflow.statusRunning') },
      completed: { color: 'blue', label: t('workflow.statusCompleted') },
      failed: { color: 'red', label: t('workflow.statusFailed') },
    }
    const info = map[status] || map.draft
    return <Tag color={info.color} style={{ fontSize: 11, lineHeight: '18px', padding: '0 6px' }}>{info.label}</Tag>
  }

  const columns = [
    {
      title: t('common.name'),
      dataIndex: 'name',
      key: 'name',
      render: (_: string, record: any) => (
        <Space style={{ width: '100%', justifyContent: 'space-between' }}>
          <Space>
            <div
              style={{
                width: 40,
                height: 40,
                borderRadius: 8,
                background: token.colorPrimaryBg,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
              }}
            >
              <ApartmentOutlined style={{ fontSize: 20, color: token.colorPrimary }} />
            </div>
            <div>
              <Text strong>{record.name}</Text>
              <div>
                <Text type="secondary" style={{ fontSize: 13 }}>
                  {record.description || ''}
                </Text>
              </div>
            </div>
          </Space>
          <Space>
            <Button
              type="link"
              size="small"
              icon={<EditOutlined />}
              onClick={() => navigate(`/workflow/${record.id}`)}
            >
              {t('common.edit')}
            </Button>
            <Button
              type="link"
              size="small"
              icon={<PlayCircleOutlined />}
              onClick={() => handleRunWorkflow(record)}
            >
              {t('workflow.run')}
            </Button>
            <Button
              type="link"
              size="small"
              danger
              icon={<DeleteOutlined />}
              onClick={() => handleDeleteWorkflow(record)}
            >
              {t('common.delete')}
            </Button>
          </Space>
        </Space>
      ),
    },
    {
      title: t('common.status'),
      dataIndex: 'status',
      key: 'status',
      width: 100,
      render: (status: string) => getStatusTag(status),
    },
    {
      title: t('workflow.addNode'),
      dataIndex: 'nodes_json',
      key: 'nodeCount',
      width: 100,
      render: (value: string) => {
        try {
          const nodes = JSON.parse(value || '[]')
          return `${nodes.length}`
        } catch {
          return '0'
        }
      },
    },
    {
      title: t('workflow.createTime'),
      dataIndex: 'created_at',
      key: 'created_at',
      width: 180,
      render: (value: number) =>
        value ? dayjs(value * 1000).format('YYYY-MM-DD HH:mm') : '-',
    },
  ]

  return (
    <div style={{ padding: '16px 24px 24px' }}>
      <PageHeader
        title={t('workflow.title')}
        subTitle={t('workflow.subtitle')}
        extra={
          <Button
            type="primary"
            icon={<PlusOutlined />}
            onClick={handleCreateWorkflow}
          >
            {t('workflow.createWorkflow')}
          </Button>
        }
      />

      <Card>
        {workflows.length > 0 ? (
          <Table
            dataSource={workflows}
            columns={columns}
            rowKey="id"
            loading={loadingTable}
            pagination={{ pageSize: 10 }}
          />
        ) : (
          <EmptyState
            title={t('workflow.noWorkflows')}
            description={t('workflow.noWorkflowsDesc')}
            actionText={t('workflow.createFirst')}
            onAction={handleCreateWorkflow}
          />
        )}
      </Card>

      <Modal
        title={t('workflow.createWorkflow')}
        open={createModalOpen}
        onOk={confirmCreateWorkflow}
        onCancel={() => setCreateModalOpen(false)}
        okText={t('common.confirm')}
        cancelText={t('common.cancel')}
      >
        <div style={{ marginBottom: 16 }}>
          <div style={{ marginBottom: 4 }}>{t('common.name')}</div>
          <Input
            value={newWorkflowName}
            onChange={(e) => setNewWorkflowName(e.target.value)}
            onPressEnter={confirmCreateWorkflow}
          />
        </div>
        <div style={{ marginBottom: 16 }}>
          <div style={{ marginBottom: 4 }}>{t('common.description')}</div>
          <Input.TextArea
            rows={3}
            placeholder={t('workflow.descPlaceholder')}
            value={newWorkflowDesc}
            onChange={(e) => setNewWorkflowDesc(e.target.value)}
          />
        </div>
      </Modal>

      <Modal
        title={t('workflow.confirmDelete')}
        open={deleteModalOpen}
        onOk={confirmDeleteWorkflow}
        onCancel={() => { setDeleteModalOpen(false); setDeleteWorkflow(null) }}
        okText={t('common.confirm')}
        cancelText={t('common.cancel')}
        okButtonProps={{ danger: true }}
      >
        <p>{t('workflow.deleteDesc')}</p>
      </Modal>
    </div>
  )
}

export default WorkflowList
