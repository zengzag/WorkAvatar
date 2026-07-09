import { useTranslation } from 'react-i18next'
import { Alert, Card, Descriptions, Tag, Typography, Space, Button } from 'antd'
import { UserOutlined, EditOutlined, ToolOutlined, CommentOutlined } from '@ant-design/icons'
import type { EmployeeProfile } from './types'

interface ProfileDisplayProps {
  profile: EmployeeProfile
  builtinTools: any[]
  hasAnalysisMessages: boolean
  onReAnalyze: () => void
  onRefine: () => void
}

/** 员工画像展示卡片（含重新分析、优化按钮） */
const ProfileDisplay: React.FC<ProfileDisplayProps> = ({
  profile,
  builtinTools,
  hasAnalysisMessages,
  onReAnalyze,
  onRefine,
}) => {
  const { t } = useTranslation()

  return (
    <>
      <Alert
        title={t('creationWizard.analysisComplete', { roleName: profile.roleName })}
        type="success"
        showIcon
        style={{ marginBottom: 16 }}
        action={
          <Space>
            <Button size="small" onClick={onReAnalyze} icon={<EditOutlined />}>
              {t('creationWizard.reAnalyze')}
            </Button>
            {hasAnalysisMessages && (
              <Button size="small" onClick={onRefine} icon={<CommentOutlined />}>
                {t('creationWizard.refineProfile')}
              </Button>
            )}
          </Space>
        }
      />

      <Card style={{ marginBottom: 16 }}>
        <Descriptions title={t('creationWizard.employeeProfile')} bordered column={1} size="small">
          <Descriptions.Item label={t('creationWizard.roleName')}>
            <Space>
              <UserOutlined />
              <Typography.Text strong>{profile.roleName}</Typography.Text>
            </Space>
          </Descriptions.Item>
          <Descriptions.Item label={t('creationWizard.roleDesc')}>{profile.roleDescription}</Descriptions.Item>
          {profile.suggestedTools.length > 0 && (
            <Descriptions.Item label={t('creationWizard.suggestedTools')}>
              <Space wrap>
                {profile.suggestedTools.map((tool, i) => {
                  const found = builtinTools.find((bt: any) => bt.name === tool)
                  return (
                    <Tag key={i} icon={<ToolOutlined />} color="orange">
                      {found ? (found.title || found.name) : tool}
                    </Tag>
                  )
                })}
              </Space>
            </Descriptions.Item>
          )}
        </Descriptions>
      </Card>
    </>
  )
}

export default ProfileDisplay
