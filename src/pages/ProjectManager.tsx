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
  theme,
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
import { useTranslation } from 'react-i18next'

const { Text } = Typography

const ProjectManager: React.FC = () => {
  const navigate = useNavigate()
  const { token } = theme.useToken()
  const { t } = useTranslation()
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
      message.error(t('projectManager.loadFailed'))
    } finally {
      setLoadingTable(false)
      setLoading('projects', false)
    }
  }

  const handleCreateProject = async () => {
    try {
      const documentsPath = await window.electronAPI.app.getPath({ name: 'documents' })
      const project = await window.electronAPI.project.create({
        name: t('projectManager.defaultProjectName', { date: dayjs().format('MMDDHHmm') }),
        description: t('projectManager.defaultProjectDesc'),
        root_path: documentsPath,
      })
      addProject(project as Project)
      message.success(t('projectManager.createSuccess'))
      navigate(`/project/${project.id}`)
    } catch (error) {
      console.error('创建项目失败:', error)
      message.error(t('projectManager.createFailed'))
    }
  }

  const handleDeleteProject = async (id: string) => {
    try {
      await window.electronAPI.project.delete(id)
      setProjects(projects.filter((p) => p.id !== id))
      message.success(t('projectManager.deleteSuccess'))
    } catch (error) {
      console.error('删除项目失败:', error)
      message.error(t('projectManager.deleteFailed'))
    }
  }

  const handleRenameProject = (project: any) => {
    setCurrentProject(project)
    setNewProjectName(project.name)
    setRenameModalOpen(true)
  }

  const confirmRenameProject = async () => {
    if (!newProjectName.trim() || !currentProject) {
      message.error(t('projectManager.nameRequired'))
      return
    }
    try {
      await window.electronAPI.project.update({
        id: currentProject.id,
        name: newProjectName,
      })
      setProjects(projects.map(p => p.id === currentProject.id ? { ...p, name: newProjectName } : p))
      message.success(t('projectManager.renameSuccess'))
      setRenameModalOpen(false)
    } catch (error) {
      console.error('重命名项目失败:', error)
      message.error(t('projectManager.renameFailed'))
    }
  }

  const columns = [
    {
      title: t('projectManager.projectName'),
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
                background: token.colorPrimaryBg,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
              }}
            >
              <FolderOpenOutlined style={{ fontSize: 20, color: token.colorPrimary }} />
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
              {t('projectManager.view')}
            </Button>
            <Button
              type="link"
              size="small"
              icon={<EditOutlined />}
              onClick={() => handleRenameProject(record)}
            >
              {t('common.rename')}
            </Button>
            <Popconfirm
              title={t('projectManager.confirmDeleteProject')}
              description={t('projectManager.deleteProjectDesc')}
              onConfirm={() => handleDeleteProject(record.id)}
              okText={t('common.confirm')}
              cancelText={t('common.cancel')}
            >
              <Button type="link" size="small" danger icon={<DeleteOutlined />}>
                {t('common.delete')}
              </Button>
            </Popconfirm>
          </Space>
        </Space>
      ),
    },
    {
      title: t('projectManager.createTime'),
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
        title={t('projectManager.title')}
        subTitle={t('projectManager.subtitle')}
        extra={
          <Button
            type="primary"
            icon={<PlusOutlined />}
            onClick={handleCreateProject}
          >
            {t('projectManager.newProject')}
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
            title={t('projectManager.noProjects')}
            description={t('projectManager.noProjectsDesc')}
            actionText={t('projectManager.createProjectAction')}
            onAction={handleCreateProject}
          />
        )}
      </Card>

      <Modal
        title={t('projectManager.renameProject')}
        open={renameModalOpen}
        onOk={confirmRenameProject}
        onCancel={() => setRenameModalOpen(false)}
        okText={t('common.confirm')}
        cancelText={t('common.cancel')}
      >
        <Input
          placeholder={t('projectManager.renamePlaceholder')}
          value={newProjectName}
          onChange={(e) => setNewProjectName(e.target.value)}
          onPressEnter={confirmRenameProject}
        />
      </Modal>
    </div>
  )
}

export default ProjectManager
