import { useEffect, useState } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { Card, Button, Tabs, message, Statistic, Row, Col, Space, Tag, Typography, Modal, Popconfirm, Tooltip, theme } from 'antd'
import {
  RobotOutlined,
  EyeOutlined,
  PlusOutlined,
  UserOutlined,
  RocketOutlined,
  DatabaseOutlined,
  LinkOutlined,
  DisconnectOutlined,
} from '@ant-design/icons'
import PageHeader from '../components/common/PageHeader'
import EmptyState from '../components/common/EmptyState'
import type { Employee } from '../types'
import type { TabsProps } from 'antd'
import { EMPLOYEE_STATUS_COLOR_MAP, EMPLOYEE_STATUS_TEXT_MAP } from '../utils/status'

const { Text } = Typography

const ProjectDetail: React.FC = () => {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const { token } = theme.useToken()
  const [project, setProject] = useState<any>(null)
  const [employees, setEmployees] = useState<Employee[]>([])
  const [linkedKBs, setLinkedKBs] = useState<any[]>([])
  const [kbLinkModalOpen, setKbLinkModalOpen] = useState(false)
  const [allKBs, setAllKBs] = useState<any[]>([])

  useEffect(() => {
    if (id) {
      loadProject()
      loadEmployees()
      loadLinkedKBs()
    }
  }, [id])

  const loadProject = async () => {
    try {
      const result = await window.electronAPI.project.get(id!)
      setProject(result)
    } catch (error) {
      console.error('加载项目失败:', error)
      message.error('加载项目失败')
    }
  }

  const loadEmployees = async () => {
    try {
      const result = await window.electronAPI.employee.list({ project_id: id! })
      setEmployees(result)
    } catch (error) {
      console.error('加载数字员工失败:', error)
    }
  }

  const loadLinkedKBs = async () => {
    try {
      const result = await window.electronAPI.kb.getKBsForProject(id!)
      setLinkedKBs(result)
    } catch {}
  }

  const handleCreateEmployee = () => {
    navigate(`/project/${id}/wizard`)
  }

  const handleNavigateToEmployee = (employeeId: string) => {
    navigate(`/employee/${employeeId}`)
  }

  const handleOpenKBLinkModal = async () => {
    try {
      const result = await window.electronAPI.kb.list()
      setAllKBs(result)
      setKbLinkModalOpen(true)
    } catch { message.error('加载知识库列表失败') }
  }

  const handleLinkKB = async (kbId: string) => {
    try {
      await window.electronAPI.kb.linkProject({ kb_id: kbId, project_id: id! })
      message.success('关联知识库成功')
      loadLinkedKBs()
    } catch { message.error('关联失败') }
  }

  const handleUnlinkKB = async (kbId: string) => {
    try {
      await window.electronAPI.kb.unlinkProject({ kb_id: kbId, project_id: id! })
      message.success('取消关联成功')
      loadLinkedKBs()
    } catch { message.error('取消关联失败') }
  }

  if (!project) {
    return (
      <div style={{ padding: 24 }}>
        <EmptyState title="项目不存在" description="请检查项目ID是否正确" />
      </div>
    )
  }

  const statusColorMap = EMPLOYEE_STATUS_COLOR_MAP
  const statusTextMap = EMPLOYEE_STATUS_TEXT_MAP

  return (
    <div style={{ padding: 24, height: '100%', display: 'flex', flexDirection: 'column' }}>
      <PageHeader
        title={project.name}
        subTitle={project.description}
        onBack={() => navigate('/dashboard')}
        breadcrumb={[{ title: '仪表盘' }, { title: '项目详情' }]}
        extra={
          <Space>
            <Button icon={<RobotOutlined />} type="primary" onClick={handleCreateEmployee}>
              创建数字员工
            </Button>
          </Space>
        }
      />

      <Row gutter={16} style={{ marginBottom: 24, flexShrink: 0 }}>
        <Col span={8}>
          <Card>
            <Statistic
              title="关联知识库"
              value={linkedKBs.length}
              prefix={<DatabaseOutlined style={{ color: '#722ed1' }} />}
              styles={{ content: { color: '#722ed1' } }}
            />
          </Card>
        </Col>
        <Col span={8}>
          <Card>
            <Statistic
              title="数字员工"
              value={employees.length}
              prefix={<RobotOutlined style={{ color: token.colorPrimary }} />}
              styles={{ content: { color: token.colorPrimary } }}
            />
          </Card>
        </Col>
        <Col span={8}>
          <Card>
            <Statistic
              title="运行中"
              value={employees.filter((e) => e.status === 'active').length}
              styles={{ content: { color: token.colorSuccess } }}
            />
          </Card>
        </Col>
      </Row>

      <div style={{ flex: 1, minHeight: 0, overflow: 'auto' }}>
        <Tabs
          defaultActiveKey="knowledge"
          items={[
            {
              key: 'knowledge',
              label: (
                <Space>
                  <DatabaseOutlined />
                  知识库
                  <Tag color="purple">{linkedKBs.length}</Tag>
                </Space>
              ),
              children: (
                <Card
                  title="关联的知识库"
                  extra={
                    <Button type="primary" icon={<LinkOutlined />} onClick={handleOpenKBLinkModal}>
                      关联知识库
                    </Button>
                  }
                >
                  {linkedKBs.length > 0 ? (
                    <div>
                      {linkedKBs.map((kb: any) => (
                        <div
                          key={kb.id}
                          style={{
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'space-between',
                            padding: '12px 0',
                            borderBottom: `1px solid ${token.colorBorderSecondary}`,
                          }}
                        >
                          <div style={{ display: 'flex', alignItems: 'center', gap: 12, flex: 1, minWidth: 0 }}>
                            <div
                              style={{
                                width: 48,
                                height: 48,
                                borderRadius: 8,
                                background: token.colorPrimaryBg,
                                display: 'flex',
                                alignItems: 'center',
                                justifyContent: 'center',
                                flexShrink: 0,
                              }}
                            >
                              <DatabaseOutlined style={{ fontSize: 24, color: '#722ed1' }} />
                            </div>
                            <div style={{ flex: 1, minWidth: 0, overflow: 'hidden' }}>
                              <Tooltip title={kb.name}>
                                <Text strong ellipsis style={{ display: 'block' }}>{kb.name}</Text>
                              </Tooltip>
                              <Tooltip title={kb.description || '暂无描述'}>
                                <Text type="secondary" ellipsis style={{ display: 'block' }}>{kb.description || '暂无描述'}</Text>
                              </Tooltip>
                              <Tag style={{ marginTop: 4 }}>{kb.doc_count || 0} 文档</Tag>
                            </div>
                          </div>
                          <Space>
                            <Button
                              type="link"
                              icon={<EyeOutlined />}
                              onClick={() => navigate('/knowledge-base')}
                            >
                              查看
                            </Button>
                            <Popconfirm
                              title="确认取消关联？"
                              description="取消关联后，本项目的数字员工将无法查询该知识库"
                              onConfirm={() => handleUnlinkKB(kb.id)}
                            >
                              <Button type="link" danger icon={<DisconnectOutlined />}>
                                取消关联
                              </Button>
                            </Popconfirm>
                          </Space>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <EmptyState
                      title="尚未关联知识库"
                      description="关联全局知识库后，本项目的数字员工可以查询知识库中的内容"
                      actionText="关联知识库"
                      onAction={handleOpenKBLinkModal}
                    />
                  )}
                </Card>
              ),
            },
            {
              key: 'employees',
              label: (
                <Space>
                  <RobotOutlined />
                  数字员工
                  <Tag color="purple">{employees.length}</Tag>
                </Space>
              ),
              children: (
                <Card
                  title="项目数字员工"
                  extra={
                    <Button type="primary" icon={<PlusOutlined />} onClick={handleCreateEmployee}>
                      新建数字员工
                    </Button>
                  }
                >
                  {employees.length > 0 ? (
                    <div>
                      {employees.map((emp) => (
                        <div
                          key={emp.id}
                          style={{
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'space-between',
                            padding: '12px 0',
                            borderBottom: `1px solid ${token.colorBorderSecondary}`,
                          }}
                        >
                          <div style={{ display: 'flex', alignItems: 'center', gap: 12, flex: 1, minWidth: 0 }}>
                            <div
                              style={{
                                width: 48,
                                height: 48,
                                borderRadius: 8,
                                background: token.colorPrimaryBg,
                                display: 'flex',
                                alignItems: 'center',
                                justifyContent: 'center',
                                flexShrink: 0,
                              }}
                            >
                              <UserOutlined style={{ fontSize: 24, color: token.colorPrimary }} />
                            </div>
                            <div style={{ flex: 1, minWidth: 0, overflow: 'hidden' }}>
                              <div style={{ marginBottom: 4, display: 'flex', alignItems: 'center', gap: 4, flexWrap: 'wrap' }}>
                                <Tooltip title={emp.name}>
                                  <Text strong ellipsis style={{ display: 'inline-block', maxWidth: 200 }}>{emp.name}</Text>
                                </Tooltip>
                                <Tag color={statusColorMap[emp.status]} style={{ flexShrink: 0 }}>
                                  {statusTextMap[emp.status]}
                                </Tag>
                              </div>
                              <Tooltip title={emp.description || '暂无描述'}>
                                <Text type="secondary" ellipsis style={{ display: 'block' }}>{emp.description || '暂无描述'}</Text>
                              </Tooltip>
                              <div style={{ marginTop: 2 }}>
                                <Text type="secondary" style={{ fontSize: 12 }}>
                                  <RocketOutlined /> 处理任务: {emp.total_tasks || 0} ·
                                  赞: {emp.total_approvals || 0} ·
                                  版本: v{emp.arch_version || 1}
                                </Text>
                              </div>
                            </div>
                          </div>
                          <Button
                            type="primary"
                            icon={<EyeOutlined />}
                            onClick={() => handleNavigateToEmployee(emp.id)}
                          >
                            进入工作台
                          </Button>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <EmptyState
                      title="暂无数字员工"
                      description="基于知识库创建专属数字员工"
                      actionText="创建第一个数字员工"
                      onAction={handleCreateEmployee}
                    />
                  )}
                </Card>
              ),
            },
            {
              key: 'settings',
              label: '项目设置',
              children: (
                <Card>
                  <p>项目ID: {project.id}</p>
                  <p>项目路径: {project.root_path}</p>
                  <p>创建时间: {new Date(project.created_at * 1000).toLocaleString()}</p>
                </Card>
              ),
            },
          ] as TabsProps['items']}
        />
      </div>

      <Modal
        title="关联知识库"
        open={kbLinkModalOpen}
        onCancel={() => setKbLinkModalOpen(false)}
        footer={null}
        width={600}
      >
        {allKBs.length === 0 ? (
          <div style={{ textAlign: 'center', padding: 24, color: token.colorTextSecondary }}>
            暂无知识库。请先在知识库管理中创建知识库。
            <Button type="link" onClick={() => { setKbLinkModalOpen(false); navigate('/knowledge-base') }}>
              前往知识库管理
            </Button>
          </div>
        ) : (
          <div>
            {allKBs.map((kb: any) => {
              const isLinked = linkedKBs.some((lkb: any) => lkb.id === kb.id)
              return (
                <div
                  key={kb.id}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    padding: '12px 0',
                    borderBottom: `1px solid ${token.colorBorderSecondary}`,
                  }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', gap: 12, flex: 1, minWidth: 0 }}>
                    <div
                      style={{
                        width: 40,
                        height: 40,
                        borderRadius: 8,
                        background: token.colorPrimaryBg,
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        flexShrink: 0,
                      }}
                    >
                      <DatabaseOutlined style={{ fontSize: 20, color: '#722ed1' }} />
                    </div>
                    <div style={{ flex: 1, minWidth: 0, overflow: 'hidden' }}>
                      <Tooltip title={kb.name}>
                        <Text ellipsis style={{ display: 'block' }}>{kb.name}</Text>
                      </Tooltip>
                      <Tooltip title={kb.description || '暂无描述'}>
                        <Text type="secondary" ellipsis style={{ display: 'block' }}>{kb.description || '暂无描述'}</Text>
                      </Tooltip>
                      <Tag style={{ marginTop: 4 }}>{kb.doc_count || 0} 文档</Tag>
                    </div>
                  </div>
                  {isLinked ? (
                    <Tag color="green">已关联</Tag>
                  ) : (
                    <Button type="primary" size="small" icon={<LinkOutlined />} onClick={() => handleLinkKB(kb.id)}>
                      关联
                    </Button>
                  )}
                </div>
              )
            })}
          </div>
        )}
      </Modal>
    </div>
  )
}

export default ProjectDetail
