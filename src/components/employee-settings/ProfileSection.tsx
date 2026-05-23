import React from 'react'
import { useTranslation } from 'react-i18next'
import { Card, Row, Col, Statistic } from 'antd'
import { BarChartOutlined, CheckCircleOutlined } from '@ant-design/icons'
import type { Employee } from '../../types'

interface ProfileSectionProps {
  employee: Employee
}

const ProfileSection: React.FC<ProfileSectionProps> = ({ employee }) => {
  const { t } = useTranslation()

  return (
    <>
      <Row gutter={16}>
        <Col span={8}>
          <Card>
            <Statistic
              title={t('employeeSettings.totalTasks')}
              value={employee.total_tasks}
              prefix={<BarChartOutlined />}
            />
          </Card>
        </Col>
        <Col span={8}>
          <Card>
            <Statistic
              title={t('employeeSettings.userApprovals')}
              value={employee.total_approvals}
              prefix={<CheckCircleOutlined style={{ color: '#52c41a' }} />}
            />
          </Card>
        </Col>
      </Row>
      <Card title={t('employeeSettings.versionInfo')} style={{ marginTop: 16 }}>
        <p>{t('employeeSettings.currentVersion')} v{employee.arch_version}</p>
        <p>{t('employeeSettings.createTime')} {new Date(employee.created_at * 1000).toLocaleString()}</p>
        <p>{t('employeeSettings.updateTime')} {new Date(employee.updated_at * 1000).toLocaleString()}</p>
      </Card>
    </>
  )
}

export default ProfileSection
