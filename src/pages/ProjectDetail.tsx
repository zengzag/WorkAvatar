import { useEffect, useState } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { Card, Button, Tabs, message, Statistic, Row, Col, Space, Tag, Typography } from 'antd'
import {
  UploadOutlined,
  SyncOutlined,
  FileTextOutlined,
  RobotOutlined,
  EyeOutlined,
  PlusOutlined,
  UserOutlined,
  RocketOutlined,
  BookOutlined,
} from '@ant-design/icons'
import PageHeader from '../components/common/PageHeader'
import FileUploadZone from '../components/file/FileUploadZone'
import FileList from '../components/file/FileList'
import EmptyState from '../components/common/EmptyState'
import type { File, Employee } from '../types'
import type { TabsProps } from 'antd'

const { Text } = Typography

const ProjectDetail: React.FC = () => {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const [project, setProject] = useState<any>(null)
  const [files, setFiles] = useState<File[]>([])
  const [employees, setEmployees] = useState<Employee[]>([])
  const [loading, setLoading] = useState(false)
  const [, setEmployeesLoading] = useState(false)

  useEffect(() => {
    if (id) {
      loadProject()
      loadFiles()
      loadEmployees()
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

  const loadFiles = async () => {
    setLoading(true)
    try {
      const result = await window.electronAPI.file.list({ project_id: id! })
      setFiles(result.files)
    } catch (error) {
      console.error('加载文件失败:', error)
      message.error('加载文件失败')
    } finally {
      setLoading(false)
    }
  }

  const loadEmployees = async () => {
    setEmployeesLoading(true)
    try {
      const result = await window.electronAPI.employee.list({ project_id: id! })
      setEmployees(result)
    } catch (error) {
      console.error('加载数字员工失败:', error)
    } finally {
      setEmployeesLoading(false)
    }
  }

  const handleUploadSuccess = () => {
    loadFiles()
  }

  const handleSelectFiles = async () => {
    try {
      const result = await window.electronAPI.app.showOpenDialog({
        title: '选择文件',
        properties: ['openFile', 'multiSelections'],
        filters: [
          {
            name: '支持的文档类型',
            extensions: ['pdf', 'doc', 'docx', 'xls', 'xlsx', 'csv', 'txt', 'md', 'html', 'htm', 'eml'],
          },
        ],
      })

      if (!result.canceled && result.filePaths.length > 0) {
        const importResult = await window.electronAPI.file.import({
          project_id: id!,
          paths: result.filePaths,
        })

        if (importResult.imported.length > 0) {
          message.success(`成功导入 ${importResult.imported.length} 个文件`)
          loadFiles()
        }

        if (importResult.errors && importResult.errors.length > 0) {
          message.warning(`${importResult.errors.length} 个文件导入失败`)
        }
      }
    } catch (error) {
      console.error('File select error:', error)
      message.error('选择文件失败')
    }
  }

  const handleParseFile = async (fileId: string) => {
    try {
      const result = await window.electronAPI.file.parse({ file_id: fileId })
      if (result.success) {
        message.success('解析成功')
        loadFiles()
      } else {
        message.error(result.error || '解析失败')
      }
    } catch (error) {
      console.error('解析文件失败:', error)
      message.error('解析文件失败')
    }
  }

  const handleDeleteFile = async (fileId: string) => {
    try {
      await window.electronAPI.file.delete(fileId)
      message.success('删除成功')
      loadFiles()
    } catch (error) {
      console.error('删除文件失败:', error)
      message.error('删除文件失败')
    }
  }

  const handleBatchParse = async () => {
    const pendingFiles = files.filter((f) => f.status === 'pending' || f.status === 'failed')
    if (pendingFiles.length === 0) {
      message.info('没有待解析的文件')
      return
    }

    message.info(`开始解析 ${pendingFiles.length} 个文件`)
    for (const file of pendingFiles) {
      await handleParseFile(file.id)
    }
  }

  const handleCreateEmployee = () => {
    navigate(`/project/${id}/wizard`)
  }

  const handleNavigateToWiki = () => {
    navigate(`/project/${id}/wiki`)
  }

  const handleNavigateToEmployee = (employeeId: string) => {
    navigate(`/employee/${employeeId}`)
  }

  const handleViewFile = (file: any) => {
    if (id) {
      navigate(`/project/${id}/file/${file.id}`)
    }
  }

  if (!project) {
    return (
      <div style={{ padding: 24 }}>
        <EmptyState title="项目不存在" description="请检查项目ID是否正确" />
      </div>
    )
  }

  const pendingCount = files.filter((f) => f.status === 'pending').length
  const completedCount = files.filter((f) => f.status === 'completed').length
  const failedCount = files.filter((f) => f.status === 'failed').length
  void failedCount

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

  return (
    <div style={{ padding: 24, height: '100%', overflow: 'auto' }}>
      <PageHeader
        title={project.name}
        subTitle={project.description}
        onBack={() => navigate('/dashboard')}
        breadcrumb={[{ title: '仪表盘' }, { title: '项目详情' }]}
        extra={
          <Space>
            <Button icon={<BookOutlined />} onClick={handleNavigateToWiki}>
              知识库管理
            </Button>
            <Button icon={<RobotOutlined />} type="primary" onClick={handleCreateEmployee}>
              创建数字员工
            </Button>
          </Space>
        }
      />

      <Row gutter={16} style={{ marginBottom: 24 }}>
        <Col span={6}>
          <Card>
            <Statistic
              title="文件总数"
              value={files.length}
              prefix={<FileTextOutlined style={{ color: '#1677ff' }} />}
            />
          </Card>
        </Col>
        <Col span={6}>
          <Card>
            <Statistic
              title="已完成"
              value={completedCount}
              styles={{ content: { color: '#52c41a' } }}
            />
          </Card>
        </Col>
        <Col span={6}>
          <Card>
            <Statistic
              title="待解析"
              value={pendingCount}
              styles={{ content: { color: '#faad14' } }}
            />
          </Card>
        </Col>
        <Col span={6}>
          <Card>
            <Statistic
              title="数字员工"
              value={employees.length}
              prefix={<RobotOutlined style={{ color: '#722ed1' }} />}
              styles={{ content: { color: '#722ed1' } }}
            />
          </Card>
        </Col>
      </Row>

      <Tabs
        defaultActiveKey="files"
        items={[
          {
            key: 'files',
            label: (
              <Space>
                <FileTextOutlined />
                文件管理
                <Tag color="blue">{files.length}</Tag>
              </Space>
            ),
            children: (
              <>
                <Card
                  title="上传文件"
                  extra={
                    <Space>
                      {pendingCount > 0 && (
                        <Button icon={<SyncOutlined />} onClick={handleBatchParse}>
                          批量解析 ({pendingCount})
                        </Button>
                      )}
                      <Button type="primary" icon={<UploadOutlined />} onClick={handleSelectFiles}>
                        选择文件
                      </Button>
                    </Space>
                  }
                  style={{ marginBottom: 24 }}
                >
                  <FileUploadZone projectId={id!} onUploadSuccess={handleUploadSuccess} />
                </Card>

                <Card title="文件列表">
                  {files.length > 0 ? (
                    <FileList
                      files={files}
                      loading={loading}
                      onParseFile={handleParseFile}
                      onDeleteFile={handleDeleteFile}
                      onViewFile={handleViewFile}
                    />
                  ) : (
                    <EmptyState
                      title="暂无文件"
                      description="上传文件开始构建您的数字员工知识库"
                      actionText="上传文件"
                      onAction={() => {}}
                    />
                  )}
                </Card>
              </>
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
                          borderBottom: '1px solid #f0f0f0',
                        }}
                      >
                        <div style={{ display: 'flex', alignItems: 'center', gap: 12, flex: 1 }}>
                          <div
                            style={{
                              width: 48,
                              height: 48,
                              borderRadius: 8,
                              background: '#e6f4ff',
                              display: 'flex',
                              alignItems: 'center',
                              justifyContent: 'center',
                              flexShrink: 0,
                            }}
                          >
                            <UserOutlined style={{ fontSize: 24, color: '#1677ff' }} />
                          </div>
                          <div style={{ flex: 1, minWidth: 0 }}>
                            <div style={{ marginBottom: 4 }}>
                              <Space>
                                <Text strong>{emp.name}</Text>
                                <Tag color={statusColorMap[emp.status]}>
                                  {statusTextMap[emp.status]}
                                </Tag>
                              </Space>
                            </div>
                            <Text type="secondary">{emp.description || '暂无描述'}</Text>
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
                    description="基于已上传的文件创建专属数字员工"
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
  )
}

export default ProjectDetail
