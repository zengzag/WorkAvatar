import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Card, Button, Tag, Statistic, Row, Col, Typography, message, Space, Popconfirm, Tooltip, theme, Modal, Input } from 'antd'
import {
  RocketOutlined,
  FolderOpenOutlined,
  UserOutlined,
  DatabaseOutlined,
  PlusOutlined,
  RobotOutlined,
  EyeOutlined,
  SettingOutlined,
  DeleteOutlined,
  RightOutlined,
} from '@ant-design/icons'
import { useNavigate, useLocation } from 'react-router-dom'
import { useAppStore } from '../stores/app.store'
import EmptyState from '../components/common/EmptyState'
import dayjs from 'dayjs'
import type { Project, Employee } from '../types'
import { EMPLOYEE_STATUS_COLOR_MAP, getEmployeeStatusTextMap } from '../utils/status'

const { Text } = Typography

const Dashboard: React.FC = () => {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const location = useLocation()
  const { token } = theme.useToken()
  const { projects, setProjects, addProject, setLoading } = useAppStore()
  const [employees, setEmployees] = useState<Employee[]>([])
  const [kbList, setKBList] = useState<any[]>([])
  const [createModalOpen, setCreateModalOpen] = useState(false)
  const [newProjectName, setNewProjectName] = useState('')
  const [newProjectDesc, setNewProjectDesc] = useState('')

  useEffect(() => {
    loadProjects()
    loadEmployees()
    loadKBs()
  }, [])

  useEffect(() => {
    const hash = location.hash
    if (hash) {
      const element = document.getElementById(hash.slice(1))
      if (element) {
        element.scrollIntoView({ behavior: 'smooth' })
      }
    }
  }, [location.hash])

  const loadProjects = async () => {
    setLoading('projects', true)
    try {
      const result = await window.electronAPI.project.list()
      setProjects(result.projects)
    } catch (error) {
      console.error('加载项目失败:', error)
      message.error(t('dashboard.loadProjectsFailed'))
    } finally {
      setLoading('projects', false)
    }
  }

  const loadEmployees = async () => {
    try {
      const result = await window.electronAPI.employee.list()
      setEmployees(result)
    } catch (error) {
      console.error('加载数字员工失败:', error)
      message.error(t('dashboard.loadEmployeesFailed'))
    }
  }

  const loadKBs = async () => {
    try {
      const result = await window.electronAPI.kb.list()
      setKBList(result)
    } catch (error) {
      console.error('加载知识库失败:', error)
    }
  }

  const handleCreateProject = () => {
    setNewProjectName(t('dashboard.defaultProjectName', { date: dayjs().format('MMDDHHmm') }))
    setNewProjectDesc('')
    setCreateModalOpen(true)
  }

  const confirmCreateProject = async () => {
    try {
      const documentsPath = await window.electronAPI.app.getPath({ name: 'documents' })
      const project = await window.electronAPI.project.create({
        name: newProjectName,
        description: newProjectDesc,
        root_path: documentsPath,
      })
      addProject(project as Project)
      message.success(t('dashboard.projectCreated'))
      setCreateModalOpen(false)
      navigate(`/project/${project.id}`)
    } catch (error) {
      console.error('创建项目失败:', error)
      message.error(t('dashboard.projectCreateFailed'))
    }
  }

  const handleDeleteProject = async (id: string) => {
    try {
      await window.electronAPI.project.delete(id)
      setProjects(projects.filter(p => p.id !== id))
      message.success(t('dashboard.projectDeleted'))
    } catch (error) {
      console.error('删除项目失败:', error)
      message.error(t('dashboard.projectDeleteFailed'))
    }
  }

  const handleDeleteEmployee = async (id: string) => {
    try {
      await window.electronAPI.employee.delete(id)
      setEmployees(employees.filter(e => e.id !== id))
      message.success(t('dashboard.employeeDeleted'))
    } catch (error) {
      console.error('删除数字员工失败:', error)
      message.error(t('dashboard.employeeDeleteFailed'))
    }
  }

  const totalKBs = kbList.length
  const totalEmployees = employees.length

  return (
    <div style={{ padding: 24 }}>
      <Card style={{ marginBottom: 24 }}>
        <div style={{ textAlign: 'center', marginBottom: 32 }}>
          <RocketOutlined style={{ fontSize: 48, color: token.colorPrimary, marginBottom: 16 }} />
          <Typography.Title level={3} style={{ marginBottom: 8 }}>
            {t('dashboard.welcome')}
          </Typography.Title>
          <Typography.Text type="secondary">
            {t('dashboard.subtitle')}
          </Typography.Text>
        </div>

        <div style={{ display: 'flex', justifyContent: 'center', gap: 16, marginBottom: 32 }}>
          <Button type="primary" size="large" icon={<PlusOutlined />} onClick={handleCreateProject}>
            {t('dashboard.createProject')}
          </Button>
          <Button size="large" icon={<RobotOutlined />} onClick={() => navigate('/settings')}>
            {t('dashboard.configureLlm')}
          </Button>
        </div>

        <Row gutter={16}>
          <Col span={6}>
            <Card>
              <Statistic
                title={t('dashboard.totalProjects')}
                value={projects.length}
                prefix={<FolderOpenOutlined style={{ color: token.colorPrimary }} />}
                styles={{ content: { color: token.colorPrimary } }}
              />
            </Card>
          </Col>
          <Col span={6}>
            <Card>
              <Statistic
                title={t('dashboard.totalEmployees')}
                value={totalEmployees}
                prefix={<UserOutlined style={{ color: token.colorSuccess }} />}
                styles={{ content: { color: token.colorSuccess } }}
              />
            </Card>
          </Col>
          <Col span={6}>
            <Card>
              <Statistic
                title={t('dashboard.totalKnowledgeBases')}
                value={totalKBs}
                prefix={<DatabaseOutlined style={{ color: token.colorWarning }} />}
                styles={{ content: { color: token.colorWarning } }}
              />
            </Card>
          </Col>
          <Col span={6}>
            <Card>
              <Statistic
                title={t('dashboard.processingTasks')}
                value={employees.reduce((sum, e) => sum + (e.total_tasks || 0), 0)}
                prefix={<RocketOutlined style={{ color: '#722ed1' }} />}
                styles={{ content: { color: '#722ed1' } }}
              />
            </Card>
          </Col>
        </Row>
      </Card>

      <Row gutter={16}>
        <Col span={12}>
          <Card
            id="projects"
            title={t('dashboard.recentProjects')}
            extra={
              <Space>
                <Button type="link" onClick={() => navigate('/projects')}>
                  {t('dashboard.viewMore')} <RightOutlined />
                </Button>
                <Button type="link" onClick={handleCreateProject}>
                  <PlusOutlined /> {t('dashboard.newProject')}
                </Button>
              </Space>
            }
          >
            {projects.length > 0 ? (
              <div>
                {projects.slice(0, 5).map((item) => (
                  <div
                    key={item.id}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      padding: '12px 0',
                      borderBottom: `1px solid ${token.colorBorderSecondary}`,
                    }}
                  >
                    <div style={{ display: 'flex', alignItems: 'center', gap: 12, flex: 1 }}>
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
                      <div style={{ flex: 1, minWidth: 0, overflow: 'hidden' }}>
                        <div style={{ marginBottom: 2, overflow: 'hidden' }}>
                          <Text strong ellipsis style={{ display: 'block' }}>{item.name}</Text>
                        </div>
                        <Text type="secondary" style={{ fontSize: 13, display: 'block' }} ellipsis>
                          {item.description || ''}
                        </Text>
                      </div>
                    </div>
                    <Space>
                      <Button type="link" size="small" onClick={() => navigate(`/project/${item.id}`)}>
                        {t('dashboard.open')}
                      </Button>
                      <Popconfirm
                        title={t('dashboard.confirmDeleteProject')}
                        description={t('dashboard.deleteProjectDesc')}
                        onConfirm={() => handleDeleteProject(item.id)}
                        okText={t('common.confirm')}
                        cancelText={t('common.cancel')}
                      >
                        <Button type="link" size="small" danger icon={<DeleteOutlined />} />
                      </Popconfirm>
                    </Space>
                  </div>
                ))}
              </div>
            ) : (
              <EmptyState
                title={t('dashboard.noProjects')}
                description={t('dashboard.noProjectsDesc')}
                actionText={t('dashboard.createProjectAction')}
                onAction={handleCreateProject}
              />
            )}
          </Card>
        </Col>

        <Col span={12}>
          <Card
            id="employees"
            title={t('dashboard.employeesSection')}
            extra={
              <Space>
                <Button type="link" onClick={() => navigate('/employees')}>
                  {t('dashboard.viewMore')} <RightOutlined />
                </Button>
                <Button type="link" onClick={() => navigate('/settings')}>
                  <SettingOutlined /> {t('dashboard.settings')}
                </Button>
              </Space>
            }
          >
            {employees.length > 0 ? (
              <div>
                {employees.slice(0, 6).map((emp) => (
                  <div
                    key={emp.id}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      padding: '8px 0',
                      borderBottom: `1px solid ${token.colorBorderSecondary}`,
                    }}
                  >
                    <div style={{ flex: 1, minWidth: 0, marginRight: 8, overflow: 'hidden' }}>
                      <div style={{ marginBottom: 4 }}>
                        <Space>
                          <Text strong style={{ fontSize: 14 }}>{emp.name}</Text>
                          <Tag color={EMPLOYEE_STATUS_COLOR_MAP[emp.status]} style={{ fontSize: 11 }}>
                            {getEmployeeStatusTextMap(t)[emp.status]}
                          </Tag>
                        </Space>
                      </div>
                      <Tooltip title={emp.description || t('common.noDescription')}>
                        <Text type="secondary" style={{ fontSize: 12, display: 'block' }} ellipsis>
                          {emp.description || t('common.noDescription')}
                        </Text>
                      </Tooltip>
                    </div>
                    <Space>
                      <Button
                        type="link"
                        size="small"
                        icon={<EyeOutlined />}
                        onClick={() => navigate(`/employee/${emp.id}`)}
                      >
                        {t('dashboard.workbench')}
                      </Button>
                      <Popconfirm
                        title={t('dashboard.confirmDeleteEmployee')}
                        description={t('dashboard.deleteEmployeeDesc')}
                        onConfirm={() => handleDeleteEmployee(emp.id)}
                        okText={t('common.confirm')}
                        cancelText={t('common.cancel')}
                      >
                        <Button type="link" size="small" danger icon={<DeleteOutlined />} />
                      </Popconfirm>
                    </Space>
                  </div>
                ))}
              </div>
            ) : (
              <EmptyState
                title={t('dashboard.noEmployees')}
                description={t('dashboard.noEmployeesDesc')}
                actionText={t('dashboard.viewProjects')}
                onAction={() => {
                  if (projects.length > 0) {
                    navigate(`/project/${projects[0].id}`)
                  } else {
                    handleCreateProject()
                  }
                }}
              />
            )}
          </Card>
        </Col>
      </Row>

      <Modal
        open={createModalOpen}
        title={t('dashboard.createProject')}
        okText={t('common.confirm')}
        cancelText={t('common.cancel')}
        onOk={confirmCreateProject}
        onCancel={() => setCreateModalOpen(false)}
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16, marginTop: 8 }}>
          <div>
            <div style={{ marginBottom: 4 }}>{t('dashboard.projectName')}</div>
            <Input
              value={newProjectName}
              onChange={e => setNewProjectName(e.target.value)}
              placeholder={t('dashboard.defaultProjectName', { date: dayjs().format('MMDDHHmm') })}
            />
          </div>
          <div>
            <div style={{ marginBottom: 4 }}>{t('dashboard.projectDesc')}</div>
            <Input.TextArea
              value={newProjectDesc}
              onChange={e => setNewProjectDesc(e.target.value)}
              rows={3}
              placeholder={t('dashboard.defaultProjectDesc')}
            />
          </div>
        </div>
      </Modal>
    </div>
  )
}

export default Dashboard
