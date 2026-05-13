import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  Card,
  Button,
  Tag,
  Table,
  message,
  Space,
  Popconfirm,
  Typography,
  theme,
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
import GlobalTaskCenter from '../components/common/GlobalTaskCenter'
import dayjs from 'dayjs'
import type { Employee } from '../types'
import { EMPLOYEE_STATUS_COLOR_MAP, getEmployeeStatusTextMap } from '../utils/status'

const { Text } = Typography

const EmployeeManager: React.FC = () => {
  const navigate = useNavigate()
  const { token } = theme.useToken()
  const { t } = useTranslation()
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
      message.error(t('employeeManager.loadFailed'))
    } finally {
      setLoadingTable(false)
    }
  }

  const handleDeleteEmployee = async (id: string) => {
    try {
      await window.electronAPI.employee.delete(id)
      setEmployees(employees.filter((e) => e.id !== id))
      message.success(t('employeeManager.deleteSuccess'))
    } catch (error) {
      console.error('删除数字员工失败:', error)
      message.error(t('employeeManager.deleteFailed'))
    }
  }

  const columns = [
    {
      title: t('employeeManager.employeeName'),
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
                <Tag color={EMPLOYEE_STATUS_COLOR_MAP[record.status]} style={{ fontSize: 11, flexShrink: 0 }}>
                  {getEmployeeStatusTextMap(t)[record.status]}
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
              {t('employeeManager.workbench')}
            </Button>
            <Button
              type="link"
              size="small"
              icon={<SettingOutlined />}
              onClick={() => navigate(`/employee/${record.id}/settings`)}
            >
              {t('employeeManager.settings')}
            </Button>
            <Popconfirm
              title={t('employeeManager.confirmDelete')}
              description={t('employeeManager.deleteDesc')}
              onConfirm={() => handleDeleteEmployee(record.id)}
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
      title: t('employeeManager.project'),
      key: 'project_name',
      width: 180,
      ellipsis: true,
      render: (_: any, record: Employee) => record.project_name || record.project_id,
    },
    {
      title: t('employeeManager.tasksApprovals'),
      key: 'stats',
      width: 150,
      render: (_: any, record: Employee) => (
        <Space>
          <Tag color="blue">{t('common.tasks', { count: record.total_tasks || 0 })}</Tag>
          <Tag color="green">{t('common.approvals', { count: record.total_approvals || 0 })}</Tag>
        </Space>
      ),
    },
    {
      title: t('employeeManager.createTime'),
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
        title={t('employeeManager.title')}
        subTitle={t('employeeManager.subtitle')}
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
            title={t('employeeManager.noEmployees')}
            description={t('employeeManager.noEmployeesDesc')}
            actionText={t('employeeManager.goToProjects')}
            onAction={() => navigate('/projects')}
          />
        )}
      </Card>

      <div style={{ marginTop: 16 }}>
        <GlobalTaskCenter />
      </div>
    </div>
  )
}

export default EmployeeManager
