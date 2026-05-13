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
  FolderOutlined,
} from '@ant-design/icons'
import PageHeader from '../components/common/PageHeader'
import EmptyState from '../components/common/EmptyState'
import ProjectWorkspace from '../components/project/ProjectWorkspace'
import type { Employee } from '../types'
import type { TabsProps } from 'antd'
import { EMPLOYEE_STATUS_COLOR_MAP, getEmployeeStatusTextMap } from '../utils/status'
import { useTranslation } from 'react-i18next'

const { Text } = Typography

const ProjectDetail: React.FC = () => {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const { token } = theme.useToken()
  const { t } = useTranslation()
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
      message.error(t('projectDetail.loadFailed'))
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
    } catch { message.error(t('projectDetail.loadKbFailed')) }
  }

  const handleLinkKB = async (kbId: string) => {
    try {
      await window.electronAPI.kb.linkProject({ kb_id: kbId, project_id: id! })
      message.success(t('projectDetail.linkKbSuccess'))
      loadLinkedKBs()
    } catch { message.error(t('projectDetail.linkFailed')) }
  }

  const handleUnlinkKB = async (kbId: string) => {
    try {
      await window.electronAPI.kb.unlinkProject({ kb_id: kbId, project_id: id! })
      message.success(t('projectDetail.unlinkSuccess'))
      loadLinkedKBs()
    } catch { message.error(t('projectDetail.unlinkFailed')) }
  }

  if (!project) {
    return (
      <div style={{ padding: 24 }}>
        <EmptyState title={t('projectDetail.projectNotFound')} description={t('projectDetail.projectNotFoundDesc')} />
      </div>
    )
  }

  const statusColorMap = EMPLOYEE_STATUS_COLOR_MAP
  const statusTextMap = getEmployeeStatusTextMap(t)

  return (
    <div style={{ padding: 24, height: '100%', display: 'flex', flexDirection: 'column' }}>
      <PageHeader
        title={project.name}
        subTitle={project.description}
        onBack={() => navigate('/dashboard')}
        breadcrumb={[{ title: t('projectDetail.breadcrumbDashboard') }, { title: t('projectDetail.breadcrumbProjectDetail') }]}
        extra={
          <Space>
            <Button icon={<RobotOutlined />} type="primary" onClick={handleCreateEmployee}>
              {t('projectDetail.createEmployee')}
            </Button>
          </Space>
        }
      />

      <Row gutter={16} style={{ marginBottom: 24, flexShrink: 0 }}>
        <Col span={8}>
          <Card>
            <Statistic
              title={t('projectDetail.linkedKb')}
              value={linkedKBs.length}
              prefix={<DatabaseOutlined style={{ color: '#722ed1' }} />}
              styles={{ content: { color: '#722ed1' } }}
            />
          </Card>
        </Col>
        <Col span={8}>
          <Card>
            <Statistic
              title={t('projectDetail.runningEmployees')}
              value={employees.length}
              prefix={<RobotOutlined style={{ color: token.colorPrimary }} />}
              styles={{ content: { color: token.colorPrimary } }}
            />
          </Card>
        </Col>
        <Col span={8}>
          <Card>
            <Statistic
              title={t('projectDetail.running')}
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
                  {t('projectDetail.tabKb')}
                  <Tag color="purple">{linkedKBs.length}</Tag>
                </Space>
              ),
              children: (
                <Card
                  title={t('projectDetail.linkedKbCard')}
                  extra={
                    <Button type="primary" icon={<LinkOutlined />} onClick={handleOpenKBLinkModal}>
                      {t('projectDetail.linkKb')}
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
                              <Tooltip title={kb.description || t('common.noDescription')}>
                                <Text type="secondary" ellipsis style={{ display: 'block' }}>{kb.description || t('common.noDescription')}</Text>
                              </Tooltip>
                              <Tag style={{ marginTop: 4 }}>{t('common.documents', { count: kb.doc_count || 0 })}</Tag>
                            </div>
                          </div>
                          <Space>
                            <Button
                              type="link"
                              icon={<EyeOutlined />}
                              onClick={() => navigate('/knowledge-base')}
                            >
                              {t('projectManager.view')}
                            </Button>
                            <Popconfirm
                              title={t('projectDetail.confirmUnlink')}
                              description={t('projectDetail.unlinkDesc')}
                              onConfirm={() => handleUnlinkKB(kb.id)}
                            >
                              <Button type="link" danger icon={<DisconnectOutlined />}>
                                {t('projectDetail.unlink')}
                              </Button>
                            </Popconfirm>
                          </Space>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <EmptyState
                      title={t('projectDetail.noLinkedKb')}
                      description={t('projectDetail.noLinkedKbDesc')}
                      actionText={t('projectDetail.linkKbAction')}
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
                  {t('projectDetail.tabEmployees')}
                  <Tag color="purple">{employees.length}</Tag>
                </Space>
              ),
              children: (
                <Card
                  title={t('projectDetail.projectEmployees')}
                  extra={
                    <Button type="primary" icon={<PlusOutlined />} onClick={handleCreateEmployee}>
                      {t('projectDetail.newEmployee')}
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
                              <Tooltip title={emp.description || t('common.noDescription')}>
                                <Text type="secondary" ellipsis style={{ display: 'block' }}>{emp.description || t('common.noDescription')}</Text>
                              </Tooltip>
                              <div style={{ marginTop: 2 }}>
                                <Text type="secondary" style={{ fontSize: 12 }}>
                                  <RocketOutlined /> {t('projectDetail.processingTasks')}: {emp.total_tasks || 0} ·
                                  {t('projectDetail.likes')}: {emp.total_approvals || 0} ·
                                  {t('projectDetail.version')}: v{emp.arch_version || 1}
                                </Text>
                              </div>
                            </div>
                          </div>
                          <Button
                            type="primary"
                            icon={<EyeOutlined />}
                            onClick={() => handleNavigateToEmployee(emp.id)}
                          >
                            {t('projectDetail.enterWorkbench')}
                          </Button>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <EmptyState
                      title={t('projectDetail.noEmployees')}
                      description={t('projectDetail.noEmployeesDesc')}
                      actionText={t('projectDetail.createFirstEmployee')}
                      onAction={handleCreateEmployee}
                    />
                  )}
                </Card>
              ),
            },
            {
              key: 'workspace',
              label: (
                <Space>
                  <FolderOutlined />
                  {t('projectDetail.tabWorkspace')}
                </Space>
              ),
              children: (
                <Card title={t('projectDetail.workspaceTitle')}>
                  <ProjectWorkspace projectId={id!} projectPath={project.root_path} />
                </Card>
              ),
            },
            {
              key: 'settings',
              label: t('projectDetail.tabSettings'),
              children: (
                <Card>
                  <p>{t('projectDetail.projectId')} {project.id}</p>
                  <p>{t('projectDetail.projectPath')} {project.root_path}</p>
                  <p>{t('projectDetail.createTime')} {new Date(project.created_at * 1000).toLocaleString()}</p>
                </Card>
              ),
            },
          ] as TabsProps['items']}
        />
      </div>

      <Modal
        title={t('projectDetail.linkKbModal')}
        open={kbLinkModalOpen}
        onCancel={() => setKbLinkModalOpen(false)}
        footer={null}
        width={600}
      >
        {allKBs.length === 0 ? (
          <div style={{ textAlign: 'center', padding: 24, color: token.colorTextSecondary }}>
            {t('projectDetail.noKbAvailable')}
            <Button type="link" onClick={() => { setKbLinkModalOpen(false); navigate('/knowledge-base') }}>
              {t('projectDetail.goToKb')}
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
                      <Tooltip title={kb.description || t('common.noDescription')}>
                        <Text type="secondary" ellipsis style={{ display: 'block' }}>{kb.description || t('common.noDescription')}</Text>
                      </Tooltip>
                      <Tag style={{ marginTop: 4 }}>{t('common.documents', { count: kb.doc_count || 0 })}</Tag>
                    </div>
                  </div>
                  {isLinked ? (
                    <Tag color="green">{t('projectDetail.linked')}</Tag>
                  ) : (
                    <Button type="primary" size="small" icon={<LinkOutlined />} onClick={() => handleLinkKB(kb.id)}>
                      {t('knowledgeBase.link')}
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
