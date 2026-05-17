import { useEffect, useState } from 'react'
import {
  Button,
  Table,
  Space,
  Typography,
  Modal,
  Input,
  theme,
  Checkbox,
  Empty,
  App,
} from 'antd'
import {
  FolderOpenOutlined,
  PlusOutlined,
  DeleteOutlined,
  EditOutlined,
} from '@ant-design/icons'
import { useNavigate } from 'react-router-dom'
import { useAppStore } from '../../stores/app.store'
import dayjs from 'dayjs'
import type { Project } from '../../types'
import { useTranslation } from 'react-i18next'

const { Text, Title, Paragraph } = Typography

const ProjectManagement: React.FC = () => {
  const navigate = useNavigate()
  const { token } = theme.useToken()
  const { t } = useTranslation()
  const { message: messageApi } = App.useApp()
  const { projects, setProjects, addProject } = useAppStore()
  const [loadingTable, setLoadingTable] = useState(false)
  const [createModalOpen, setCreateModalOpen] = useState(false)
  const [renameModalOpen, setRenameModalOpen] = useState(false)
  const [deleteModalOpen, setDeleteModalOpen] = useState(false)
  const [deleteProject, setDeleteProject] = useState<Project | null>(null)
  const [deleteWorkspace, setDeleteWorkspace] = useState(false)
  const [currentProject, setCurrentProject] = useState<any>(null)
  const [newProjectName, setNewProjectName] = useState('')
  const [newProjectDesc, setNewProjectDesc] = useState('')

  useEffect(() => {
    loadProjects()
  }, [])

  const loadProjects = async () => {
    setLoadingTable(true)
    try {
      const result = await window.electronAPI.project.list()
      setProjects(result.projects)
    } catch (error) {
      messageApi.error(t('settings.projectManagement.createFailed'))
    } finally {
      setLoadingTable(false)
    }
  }

  const handleCreateProject = () => {
    setNewProjectName(t('projectManager.defaultProjectName', { date: dayjs().format('MMDDHHmm') }))
    setNewProjectDesc(t('projectManager.defaultProjectDesc'))
    setCreateModalOpen(true)
  }

  const confirmCreateProject = async () => {
    if (!newProjectName.trim()) {
      messageApi.error(t('settings.projectManagement.nameRequired'))
      return
    }
    try {
      const documentsPath = await window.electronAPI.app.getPath({ name: 'documents' })
      const project = await window.electronAPI.project.create({
        name: newProjectName,
        description: newProjectDesc,
        root_path: documentsPath,
      })
      addProject(project as Project)
      messageApi.success(t('settings.projectManagement.createSuccess'))
      setCreateModalOpen(false)
      navigate(`/project/${project.id}`)
    } catch (error) {
      messageApi.error(t('settings.projectManagement.createFailed'))
    }
  }

  const handleDeleteProject = async (project: Project) => {
    setDeleteProject(project)
    setDeleteWorkspace(false)
    setDeleteModalOpen(true)
  }

  const confirmDeleteProject = async () => {
    if (!deleteProject) return
    try {
      await window.electronAPI.project.delete({
        id: deleteProject.id,
        delete_workspace: deleteWorkspace,
      })
      setProjects(projects.filter((p) => p.id !== deleteProject.id))
      messageApi.success(t('settings.projectManagement.deleteSuccess'))
      setDeleteModalOpen(false)
      setDeleteProject(null)
    } catch (error) {
      messageApi.error(t('settings.projectManagement.deleteFailed'))
    }
  }

  const handleRenameProject = (project: any) => {
    setCurrentProject(project)
    setNewProjectName(project.name)
    setNewProjectDesc(project.description || '')
    setRenameModalOpen(true)
  }

  const confirmRenameProject = async () => {
    if (!newProjectName.trim() || !currentProject) {
      messageApi.error(t('settings.projectManagement.nameRequired'))
      return
    }
    try {
      await window.electronAPI.project.update({
        id: currentProject.id,
        name: newProjectName,
        description: newProjectDesc,
      })
      setProjects(projects.map(p => p.id === currentProject.id ? { ...p, name: newProjectName, description: newProjectDesc } : p))
      messageApi.success(t('settings.projectManagement.renameSuccess'))
      setRenameModalOpen(false)
    } catch (error) {
      messageApi.error(t('settings.projectManagement.renameFailed'))
    }
  }

  const columns = [
    {
      title: t('settings.projectManagement.projectName'),
      dataIndex: 'name',
      key: 'name',
      render: (_: string, record: Project) => (
        <Space style={{ width: '100%', justifyContent: 'space-between' }}>
          <Space
            style={{ cursor: 'pointer' }}
            onClick={() => navigate(`/project/${record.id}`)}
          >
            <div
              style={{
                width: 36,
                height: 36,
                borderRadius: 8,
                background: token.colorPrimaryBg,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
              }}
            >
              <FolderOpenOutlined style={{ fontSize: 18, color: token.colorPrimary }} />
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
          <Space size={0}>
            <Button
              type="text"
              size="small"
              icon={<EditOutlined />}
              onClick={() => handleRenameProject(record)}
            />
            <Button
              type="text"
              size="small"
              danger
              icon={<DeleteOutlined />}
              onClick={() => handleDeleteProject(record)}
            />
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
    <div>
      <div style={{ marginBottom: 16, display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
        <div>
          <Title level={5} style={{ margin: 0 }}>{t('settings.projectManagement.title')}</Title>
          <Paragraph type="secondary" style={{ margin: '4px 0 0' }}>{t('settings.projectManagement.desc')}</Paragraph>
        </div>
        <Button
          type="primary"
          icon={<PlusOutlined />}
          onClick={handleCreateProject}
        >
          {t('settings.projectManagement.createProject')}
        </Button>
      </div>

      {projects.length > 0 ? (
        <Table
          dataSource={projects}
          columns={columns}
          rowKey="id"
          loading={loadingTable}
          pagination={false}
          size="small"
        />
      ) : (
        <Empty
          description={
            <div>
              <Text type="secondary">{t('settings.projectManagement.noProjects')}</Text>
              <br />
              <Text type="secondary" style={{ fontSize: 12 }}>{t('settings.projectManagement.noProjectsDesc')}</Text>
            </div>
          }
        >
          <Button type="primary" icon={<PlusOutlined />} onClick={handleCreateProject}>
            {t('settings.projectManagement.createProject')}
          </Button>
        </Empty>
      )}

      <Modal
        title={t('settings.projectManagement.createProject')}
        open={createModalOpen}
        onOk={confirmCreateProject}
        onCancel={() => setCreateModalOpen(false)}
        okText={t('common.confirm')}
        cancelText={t('common.cancel')}
      >
        <div style={{ marginBottom: 16 }}>
          <div style={{ marginBottom: 4 }}>{t('settings.projectManagement.projectName')}</div>
          <Input
            value={newProjectName}
            onChange={(e) => setNewProjectName(e.target.value)}
            onPressEnter={confirmCreateProject}
          />
        </div>
        <div>
          <div style={{ marginBottom: 4 }}>{t('settings.projectManagement.projectDesc')}</div>
          <Input.TextArea
            rows={3}
            placeholder={t('settings.projectManagement.descPlaceholder')}
            value={newProjectDesc}
            onChange={(e) => setNewProjectDesc(e.target.value)}
          />
        </div>
      </Modal>

      <Modal
        title={t('settings.projectManagement.renameProject')}
        open={renameModalOpen}
        onOk={confirmRenameProject}
        onCancel={() => setRenameModalOpen(false)}
        okText={t('common.confirm')}
        cancelText={t('common.cancel')}
      >
        <div style={{ marginBottom: 16 }}>
          <div style={{ marginBottom: 4 }}>{t('settings.projectManagement.projectName')}</div>
          <Input
            placeholder={t('settings.projectManagement.renamePlaceholder')}
            value={newProjectName}
            onChange={(e) => setNewProjectName(e.target.value)}
            onPressEnter={confirmRenameProject}
          />
        </div>
        <div>
          <div style={{ marginBottom: 4 }}>{t('settings.projectManagement.projectDesc')}</div>
          <Input.TextArea
            rows={3}
            placeholder={t('settings.projectManagement.descPlaceholder')}
            value={newProjectDesc}
            onChange={(e) => setNewProjectDesc(e.target.value)}
          />
        </div>
      </Modal>

      <Modal
        title={t('settings.projectManagement.confirmDeleteProject')}
        open={deleteModalOpen}
        onOk={confirmDeleteProject}
        onCancel={() => { setDeleteModalOpen(false); setDeleteProject(null) }}
        okText={t('common.confirm')}
        cancelText={t('common.cancel')}
        okButtonProps={{ danger: true }}
      >
        <p>{t('settings.projectManagement.deleteProjectDesc')}</p>
        {deleteProject?.root_path && (
          <Checkbox
            checked={deleteWorkspace}
            onChange={(e) => setDeleteWorkspace(e.target.checked)}
            style={{ marginTop: 8 }}
          >
            {t('settings.projectManagement.deleteWorkspace')}
          </Checkbox>
        )}
        {deleteWorkspace && deleteProject?.root_path && (
          <div style={{ marginTop: 8, padding: '8px 12px', background: token.colorWarningBg, borderRadius: 6, fontSize: 13 }}>
            {t('settings.projectManagement.deleteWorkspaceWarning')}<br />
            <Text type="secondary" style={{ fontSize: 12 }}>{deleteProject.root_path}</Text>
          </div>
        )}
      </Modal>
    </div>
  )
}

export default ProjectManagement
