import React from 'react'
import { useTranslation } from 'react-i18next'
import { useNavigate } from 'react-router-dom'
import {
  Card,
  Button,
  Empty,
} from 'antd'
import { LinkOutlined } from '@ant-design/icons'
import KBListItem from '../common/KBListItem'

interface KnowledgeBaseSectionProps {
  linkedKBs: any[]
  projectId: string
}

const KnowledgeBaseSection: React.FC<KnowledgeBaseSectionProps> = ({ linkedKBs, projectId }) => {
  const { t } = useTranslation()
  const navigate = useNavigate()

  return (
    <Card title={t('employeeSettings.projectKb')} extra={<Button type="link" icon={<LinkOutlined />} onClick={() => navigate(`/project/${projectId}`)}>{t('employeeSettings.manageAssociation')}</Button>}>
      {linkedKBs.length > 0 ? (
        <div>
          {linkedKBs.map((kb: any) => (
            <KBListItem key={kb.id} kb={kb} />
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
