import { useEffect, useState } from 'react'
import {
  Card,
  Button,
  Table,
  message,
  Space,
  Popconfirm,
  Typography,
  Modal,
  Input,
} from 'antd'
import {
  FolderOpenOutlined,
  PlusOutlined,
  DeleteOutlined,
  EyeOutlined,
  EditOutlined,
} from '@ant-design/icons'
import { useNavigate } from 'react-router-dom'
import { useAppStore } from '../stores/app.store'
import PageHeader from '../components/common/PageHeader'
import EmptyState from '../components/common/EmptyState'
import dayjs from 'dayjs'
import type { Project } from '../types'

const { Text } = Typography

const ProjectManager: React.FC = () => {
  const navigate = useNavigate()
  const { projects, setProjects, addProject, setLoading } = useAppStore()
  const [loadingTable, setLoadingTable] = useState(false)
  const [renameModalOpen, setRenameModalOpen] = useState(false)
  const [currentProject, setCurrentProject] = useState<any>(null)
  const [newProjectName, setNewProjectName] = useState('')

  useEffect(() => {
    loadProjects()
  }, [])

  const loadProjects = async () => {
    setLoadingTable(true)
    setLoading('projects', true)
    try {
      const result = await window.electronAPI.project.list()
      setProjects(result.projects)
    } catch (error) {
      console.error('加载项目失败:', error)
      message.error('加载项目失败')
    } finally {
      setLoadingTable(false)
      setLoading('projects', false)
    }
  }

  const handleCreateProject = async () => {
    try {
      const documentsPath = await window.electronAPI.app.getPath({ name: 'documents' })
      const project = await window.electronAPI.project.create({
        name: `项目 ${dayjs().format('MMDDHHmm')}`,
        description: '新建的数字员工项目',
        root_path: documentsPath,
      })
      addProject(project as Project)
      message.success('项目创建成功')
      navigate(`/project/${project.id}`)
    } catch (error) {
      console.error('创建项目失败:', error)
      message.error('创建项目失败')
    }
  }

  const handleDeleteProject = async (id: string) => {
    try {
      await window.electronAPI.project.delete(id)
      setProjects(projects.filter((p) => p.id !== id))
      message.success('项目删除成功')
    } catch (error) {
      console.error('删除项目失败:', error)
      message.error('删除项目失败')
    }
  }

  const handleRenameProject = (project: any) => {
    setCurrentProject(project)
    setNewProjectName(project.name)
    setRenameModalOpen(true)
  }

  const confirmRenameProject = async () => {
    if (!newProjectName.trim() || !currentProject) {
      message.error('项目名称不能为空')
      return
    }
    try {
      await window.electronAPI.project.update({
        id: currentProject.id,
        name: newProjectName,
      })
      setProjects(projects.map(p => p.id === currentProject.id ? { ...p, name: newProjectName } : p))
      message.success('项目重命名成功')
      setRenameModalOpen(false)
    } catch (error) {
      console.error('重命名项目失败:', error)
      message.error('重命名项目失败')
    }
  }

  const columns = [
    {
      title: '项目名称',
      dataIndex: 'name',
      key: 'name',
      render: (_: string, record: Project) => (
        <Space style={{ width: '100%', justifyContent: 'space-between' }}>
          <Space>
            <div
              style={{
                width: 40,
                height: 40,
                borderRadius: 8,
                background: '#e6f4ff',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
              }}
            >
              <FolderOpenOutlined style={{ fontSize: 20, color: '#1677ff' }} />
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
              icon={<EyeOutlined />}
              onClick={() => navigate(`/project/${record.id}`)}
            >
              查看
            </Button>
            <Button
              type="link"
              size="small"
              icon={<EditOutlined />}
              onClick={() => handleRenameProject(record)}
            >
              重命名
            </Button>
            <Popconfirm
              title="确定删除该项目?"
              description="删除后项目下的所有文件和员工也将被删除，此操作不可撤销。"
              onConfirm={() => handleDeleteProject(record.id)}
              okText="确定"
              cancelText="取消"
            >
              <Button type="link" size="small" danger icon={<DeleteOutlined />}>
                删除
              </Button>
            </Popconfirm>
          </Space>
        </Space>
      ),
    },
    {
      title: '创建时间',
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
        title="项目管理"
        subTitle="管理所有数字员工项目"
        extra={
          <Button
            type="primary"
            icon={<PlusOutlined />}
            onClick={handleCreateProject}
          >
            新建项目
          </Button>
        }
      />

      <Card>
        {projects.length > 0 ? (
          <Table
            dataSource={projects}
            columns={columns}
            rowKey="id"
            loading={loadingTable}
            pagination={{ pageSize: 10 }}
          />
        ) : (
          <EmptyState
            title="暂无项目"
            description="创建您的第一个项目，开始构建数字员工"
            actionText="创建项目"
            onAction={handleCreateProject}
          />
        )}
      </Card>

      <Modal
        title="重命名项目"
        open={renameModalOpen}
        onOk={confirmRenameProject}
        onCancel={() => setRenameModalOpen(false)}
        okText="确定"
        cancelText="取消"
      >
        <Input
          placeholder="请输入新的项目名称"
          value={newProjectName}
          onChange={(e) => setNewProjectName(e.target.value)}
          onPressEnter={confirmRenameProject}
        />
      </Modal>
    </div>
  )
}

export default ProjectManager
