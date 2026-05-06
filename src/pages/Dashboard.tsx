import { useEffect, useState } from 'react'
import { Card, Button, Tag, Statistic, Row, Col, Typography, message, Space, Popconfirm } from 'antd'
import {
  RocketOutlined,
  FolderOpenOutlined,
  UserOutlined,
  FileOutlined,
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

const { Text } = Typography

const statusColorMap: Record<string, string> = {
  draft: 'default',
  active: 'green',
  paused: 'orange',
  error: 'red',
}

const statusTextMap: Record<string, string> = {
  draft: '草稿',
  active: '运行中',
  paused: '已暂停',
  error: '错误',
}

const Dashboard: React.FC = () => {
  const navigate = useNavigate()
  const location = useLocation()
  const { projects, setProjects, addProject, setLoading } = useAppStore()
  const [employees, setEmployees] = useState<Employee[]>([])

  useEffect(() => {
    loadProjects()
    loadEmployees()
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
      message.error('加载项目失败')
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
      setProjects(projects.filter(p => p.id !== id))
      message.success('项目删除成功')
    } catch (error) {
      console.error('删除项目失败:', error)
      message.error('删除项目失败')
    }
  }

  const handleDeleteEmployee = async (id: string) => {
    try {
      await window.electronAPI.employee.delete(id)
      setEmployees(employees.filter(e => e.id !== id))
      message.success('数字员工删除成功')
    } catch (error) {
      console.error('删除数字员工失败:', error)
      message.error('删除数字员工失败')
    }
  }

  const totalFiles = projects.reduce((sum, p) => sum + ((p as any).file_count || 0), 0)
  const totalEmployees = employees.length

  return (
    <div style={{ padding: 24 }}>
      <Card style={{ marginBottom: 24 }}>
        <div style={{ textAlign: 'center', marginBottom: 32 }}>
          <RocketOutlined style={{ fontSize: 48, color: '#1677ff', marginBottom: 16 }} />
          <Typography.Title level={3} style={{ marginBottom: 8 }}>
            欢迎使用 WorkAvatar
          </Typography.Title>
          <Typography.Text type="secondary">
            本地优先的零代码数字员工自动生成平台
          </Typography.Text>
        </div>

        <div style={{ display: 'flex', justifyContent: 'center', gap: 16, marginBottom: 32 }}>
          <Button type="primary" size="large" icon={<PlusOutlined />} onClick={handleCreateProject}>
            创建项目
          </Button>
          <Button size="large" icon={<RobotOutlined />} onClick={() => navigate('/settings')}>
            配置 LLM 服务
          </Button>
        </div>

        <Row gutter={16}>
          <Col span={6}>
            <Card>
              <Statistic
                title="项目总数"
                value={projects.length}
                prefix={<FolderOpenOutlined style={{ color: '#1677ff' }} />}
                styles={{ content: { color: '#1677ff' } }}
              />
            </Card>
          </Col>
          <Col span={6}>
            <Card>
              <Statistic
                title="数字员工"
                value={totalEmployees}
                prefix={<UserOutlined style={{ color: '#52c41a' }} />}
                styles={{ content: { color: '#52c41a' } }}
              />
            </Card>
          </Col>
          <Col span={6}>
            <Card>
              <Statistic
                title="文件数量"
                value={totalFiles}
                prefix={<FileOutlined style={{ color: '#faad14' }} />}
                styles={{ content: { color: '#faad14' } }}
              />
            </Card>
          </Col>
          <Col span={6}>
            <Card>
              <Statistic
                title="处理任务"
                value={employees.reduce((sum, e) => sum + (e.total_tasks || 0), 0)}
                prefix={<RocketOutlined style={{ color: '#722ed1' }} />}
                styles={{ content: { color: '#722ed1' } }}
              />
            </Card>
          </Col>
        </Row>
      </Card>

      <Row gutter={16}>
        <Col span={14}>
          <Card
            id="projects"
            title="最近项目"
            extra={
              <Space>
                <Button type="link" onClick={() => navigate('/projects')}>
                  查看更多 <RightOutlined />
                </Button>
                <Button type="link" onClick={handleCreateProject}>
                  <PlusOutlined /> 新建项目
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
                      borderBottom: '1px solid #f0f0f0',
                    }}
                  >
                    <div style={{ display: 'flex', alignItems: 'center', gap: 12, flex: 1 }}>
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
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ marginBottom: 2 }}>
                          <Text strong>{item.name}</Text>
                          <Tag color="blue" style={{ marginLeft: 8 }}>
                            {(item as any).file_count || 0} 个文件
                          </Tag>
                        </div>
                        <Text type="secondary" style={{ fontSize: 13 }}>
                          {item.description || ''}
                        </Text>
                      </div>
                    </div>
                    <Space>
                      <Button type="link" size="small" onClick={() => navigate(`/project/${item.id}`)}>
                        打开
                      </Button>
                      <Popconfirm
                        title="确定删除该项目?"
                        description="删除后项目下的所有文件和员工也将被删除，此操作不可撤销。"
                        onConfirm={() => handleDeleteProject(item.id)}
                        okText="确定"
                        cancelText="取消"
                      >
                        <Button type="link" size="small" danger icon={<DeleteOutlined />} />
                      </Popconfirm>
                    </Space>
                  </div>
                ))}
              </div>
            ) : (
              <EmptyState
                title="暂无项目"
                description="创建您的第一个项目，开始构建数字员工"
                actionText="创建项目"
                onAction={handleCreateProject}
              />
            )}
          </Card>
        </Col>

        <Col span={10}>
          <Card
            id="employees"
            title="数字员工"
            extra={
              <Space>
                <Button type="link" onClick={() => navigate('/employees')}>
                  查看更多 <RightOutlined />
                </Button>
                <Button type="link" onClick={() => navigate('/settings')}>
                  <SettingOutlined /> 设置
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
                      borderBottom: '1px solid #f0f0f0',
                    }}
                  >
                    <div style={{ flex: 1, minWidth: 0, marginRight: 8 }}>
                      <div style={{ marginBottom: 4 }}>
                        <Space>
                          <Text strong style={{ fontSize: 14 }}>{emp.name}</Text>
                          <Tag color={statusColorMap[emp.status]} style={{ fontSize: 11 }}>
                            {statusTextMap[emp.status]}
                          </Tag>
                        </Space>
                      </div>
                      <Text type="secondary" style={{ fontSize: 12 }} ellipsis>
                        {emp.description || '暂无描述'}
                      </Text>
                    </div>
                    <Space>
                      <Button
                        type="link"
                        size="small"
                        icon={<EyeOutlined />}
                        onClick={() => navigate(`/employee/${emp.id}`)}
                      >
                        工作台
                      </Button>
                      <Popconfirm
                        title="确定删除该数字员工?"
                        description="删除后相关的对话记录也将被删除，此操作不可撤销。"
                        onConfirm={() => handleDeleteEmployee(emp.id)}
                        okText="确定"
                        cancelText="取消"
                      >
                        <Button type="link" size="small" danger icon={<DeleteOutlined />} />
                      </Popconfirm>
                    </Space>
                  </div>
                ))}
              </div>
            ) : (
              <EmptyState
                title="暂无数字员工"
                description="在项目中上传文件并创建数字员工"
                actionText="查看项目"
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
    </div>
  )
}

export default Dashboard
