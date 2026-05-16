import { useTranslation } from 'react-i18next'
import { Modal, Typography, Space, Tag, Button, Tooltip, theme } from 'antd'
import { FolderOpenOutlined } from '@ant-design/icons'
import { useNavigate } from 'react-router-dom'

const { Text } = Typography

interface KBLinkProjectModalProps {
  open: boolean
  onCancel: () => void
  allProjects: any[]
  linkedProjects: any[]
  onProjectLink: (projectId: string) => void
}

const KBLinkProjectModal: React.FC<KBLinkProjectModalProps> = ({
  open,
  onCancel,
  allProjects,
  linkedProjects,
  onProjectLink,
}) => {
  const { t } = useTranslation()
  const { token } = theme.useToken()
  const navigate = useNavigate()

  return (
    <Modal title={t('knowledgeBase.linkToProjectModal')} open={open} onCancel={onCancel} footer={null}>
      <div>
        {allProjects.map((project: any) => (
          <div
            key={project.id}
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
                <FolderOpenOutlined style={{ color: token.colorPrimary }} />
              </div>
              <div style={{ flex: 1, minWidth: 0, overflow: 'hidden' }}>
                <Tooltip title={project.name}>
                  <Text strong ellipsis style={{ display: 'block' }}>{project.name}</Text>
                </Tooltip>
                <Tooltip title={project.description}>
                  <Text type="secondary" ellipsis style={{ display: 'block' }}>{project.description}</Text>
                </Tooltip>
              </div>
            </div>
            {linkedProjects.some(lp => lp.id === project.id) ? (
              <Space>
                <Tag color="green">{t('knowledgeBase.linked')}</Tag>
                <Button type="link" size="small" icon={<FolderOpenOutlined />} onClick={() => navigate(`/project/${project.id}`)}>
                  {t('knowledgeBase.viewProject')}
                </Button>
              </Space>
            ) : (
              <Button type="link" onClick={() => onProjectLink(project.id)}>{t('knowledgeBase.link')}</Button>
            )}
          </div>
        ))}
      </div>
    </Modal>
  )
}

export default KBLinkProjectModal
