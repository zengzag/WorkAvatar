import { useEffect, useState } from 'react'
import {
  Card,
  Button,
  Tag,
  Table,
  message,
  Space,
  Popconfirm,
  Typography,
} from 'antd'
import {
  UserOutlined,
  EyeOutlined,
  DeleteOutlined,
  SettingOutlined,
  RobotOutlined,
} from '@ant-design/icons'
import { useNavigate } from 'react-router-dom'
import PageHeader from '../components/common/PageHeader'
import EmptyState from '../components/common/EmptyState'
import dayjs from 'dayjs'
import type { Employee } from '../types'
import { theme } from 'antd'

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

const EmployeeManager: React.FC = () => {
  const navigate = useNavigate()
  const { token } = theme.useToken()
  const [employees, setEmployees] = useState<Employee[]>([])
  const [loadingTable, setLoadingTable] = useState(false)

  useEffect(() => {
    loadEmployees()
  }, [])

  const loadEmployees = async () => {
    setLoadingTable(true)
    try {
      const result = await window.electronAPI.employee.list()
      setEmployees(result)
    } catch (error) {
      console.error('加载数字员工失败:', error)
      message.error('加载数字员工失败')
    } finally {
      setLoadingTable(false)
    }
  }

  const handleDeleteEmployee = async (id: string) => {
    try {
      await window.electronAPI.employee.delete(id)
      setEmployees(employees.filter((e) => e.id !== id))
      message.success('数字员工删除成功')
    } catch (error) {
      console.error('删除数字员工失败:', error)
      message.error('删除数字员工失败')
    }
  }

  const columns = [
    {
      title: '员工名称',
      dataIndex: 'name',
      key: 'name',
      width: 450,
      render: (_: string, record: Employee) => (
        <Space style={{ width: '100%', justifyContent: 'space-between' }}>
          <Space>
            <div
              style={{
                width: 40,
                height: 40,
                borderRadius: 8,
                background: token.colorSuccessBg,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                flexShrink: 0,
              }}
            >
              {record.avatar_type === 'default' ? (
                <RobotOutlined style={{ fontSize: 20, color: token.colorPrimary }} />
              ) : (
                <UserOutlined style={{ fontSize: 20, color: token.colorSuccess }} />
              )}
            </div>
            <div style={{ minWidth: 0, overflow: 'hidden', flex: 1 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 4, overflow: 'hidden' }}>
                <Text strong ellipsis style={{ display: 'inline-block', maxWidth: 160 }}>{record.name}</Text>
                <Tag color={statusColorMap[record.status]} style={{ fontSize: 11, flexShrink: 0 }}>
                  {statusTextMap[record.status]}
                </Tag>
              </div>
            </div>
          </Space>
          <Space>
            <Button
              type="link"
              size="small"
              icon={<EyeOutlined />}
              onClick={() => navigate(`/employee/${record.id}`)}
            >
              工作台
            </Button>
            <Button
              type="link"
              size="small"
              icon={<SettingOutlined />}
              onClick={() => navigate(`/employee/${record.id}/settings`)}
            >
              设置
            </Button>
            <Popconfirm
              title="确定删除该数字员工?"
              description="删除后相关的对话记录也将被删除，此操作不可撤销。"
              onConfirm={() => handleDeleteEmployee(record.id)}
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
      title: '项目',
      dataIndex: 'project_id',
      key: 'project_id',
      width: 180,
      ellipsis: true,
    },
    {
      title: '任务/赞',
      key: 'stats',
      width: 150,
      render: (_: any, record: Employee) => (
        <Space>
          <Tag color="blue">{record.total_tasks || 0} 任务</Tag>
          <Tag color="green">{record.total_approvals || 0} 赞</Tag>
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
        title="数字员工"
        subTitle="管理所有数字员工"
      />

      <Card>
        {employees.length > 0 ? (
          <Table
            dataSource={employees}
            columns={columns}
            rowKey="id"
            loading={loadingTable}
            pagination={{ pageSize: 10 }}
            scroll={{ x: 'max-content' }}
          />
        ) : (
          <EmptyState
            title="暂无数字员工"
            description="在项目中上传文件并创建数字员工"
            actionText="前往项目"
            onAction={() => navigate('/projects')}
          />
        )}
      </Card>
    </div>
  )
}

export default EmployeeManager
