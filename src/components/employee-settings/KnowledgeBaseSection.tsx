import React from 'react'
import { useTranslation } from 'react-i18next'
import { useNavigate } from 'react-router-dom'
import {
  Card,
  Button,
  Tag,
  Empty,
  Typography,
  Tooltip,
  theme,
} from 'antd'
import { LinkOutlined, DatabaseOutlined } from '@ant-design/icons'

const { Text } = Typography

interface KnowledgeBaseSectionProps {
  linkedKBs: any[]
  projectId: string
}

const KnowledgeBaseSection: React.FC<KnowledgeBaseSectionProps> = ({ linkedKBs, projectId }) => {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const { token } = theme.useToken()

  return (
    <Card title={t('employeeSettings.projectKb')} extra={<Button type="link" icon={<LinkOutlined />} onClick={() => navigate(`/project/${projectId}`)}>{t('employeeSettings.manageAssociation')}</Button>}>
      {linkedKBs.length > 0 ? (
        <div>
          {linkedKBs.map((kb: any) => (
            <div
              key={kb.id}
              style={{
                display: 'flex',
                alignItems: 'center',
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
                    <Text strong ellipsis style={{ display: 'block' }}>{kb.name}</Text>
                  </Tooltip>
                  <div style={{ overflow: 'hidden' }}>
                    <Tooltip title={kb.description || t('common.noDescription')}>
                      <Text type="secondary" ellipsis style={{ display: 'block' }}>{kb.description || t('common.noDescription')}</Text>
                    </Tooltip>
                    <Tag style={{ marginTop: 4 }}>{t('common.documents', { count: kb.doc_count || 0 })}</Tag>
                  </div>
                </div>
              </div>
            </div>
          ))}
        </div>
      ) : (
        <Empty description={t('employeeSettings.noLinkedKb')}>
          <Button type="primary" onClick={() => navigate(`/project/${projectId}`)}>
            {t('employeeSettings.goToLinkKb')}
          </Button>
        </Empty>
      )}
    </Card>
  )
}

export default KnowledgeBaseSection
