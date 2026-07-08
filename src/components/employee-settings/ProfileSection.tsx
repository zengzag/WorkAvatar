import React, { useState, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { Card, Row, Col, Statistic } from 'antd'
import { MessageOutlined, CommentOutlined } from '@ant-design/icons'
import type { Employee } from '../../types'

interface ProfileSectionProps {
  employee: Employee
}

const ProfileSection: React.FC<ProfileSectionProps> = ({ employee }) => {
  const { t } = useTranslation()

  const [conversationCount, setConversationCount] = useState(0)
  const [totalMessages, setTotalMessages] = useState(0)

  useEffect(() => {
    const loadStats = async () => {
      try {
        const conversations = await window.electronAPI.conversation.list({ employee_id: employee.id })
        setConversationCount(conversations?.length || 0)
        const total = (conversations || []).reduce((sum: number, conv: any) => sum + (conv.message_count || 0), 0)
        setTotalMessages(total)
      } catch {
        // ignore
      }
    }
    loadStats()
  }, [employee.id])

  return (
    <>
      <Row gutter={16}>
        <Col span={8}>
          <Card>
            <Statistic
              title={t('employeeSettings.totalConversations')}
              value={conversationCount}
              prefix={<CommentOutlined />}
            />
          </Card>
        </Col>
        <Col span={8}>
          <Card>
            <Statistic
              title={t('employeeSettings.totalMessages')}
              value={totalMessages}
              prefix={<MessageOutlined />}
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

export default React.memo(ProfileSection)
