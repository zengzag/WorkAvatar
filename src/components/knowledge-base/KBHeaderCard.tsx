import { useTranslation } from 'react-i18next'
import { Card, Typography, Space, Button, Tooltip, Dropdown, theme } from 'antd'
import {
  UploadOutlined, LinkOutlined, EditOutlined,
  ExportOutlined, ImportOutlined, FolderAddOutlined, MoreOutlined,
} from '@ant-design/icons'
import LLMSelector from '../llm/LLMSelector'
import { BulbOutlined } from '@ant-design/icons'
import type { KnowledgeBase } from './types'

interface KBHeaderCardProps {
  selectedKB: KnowledgeBase
  linkedProjects: any[]
  uploadLoading: boolean
  onUploadFiles: () => void
  onUploadFolder: () => void
  onEditKB: () => void
  onOpenExportModal: () => void
  onOpenImportModal: () => void
  onLinkProject: () => void
  selectedProviderId: string
  selectedModelId: string
  enableThinking: boolean
  onProviderChange: (id: string) => void
  onModelChange: (id: string) => void
  onThinkingChange: (v: boolean) => void
}

const KBHeaderCard: React.FC<KBHeaderCardProps> = ({
  selectedKB,
  linkedProjects,
  uploadLoading,
  onUploadFiles,
  onUploadFolder,
  onEditKB,
  onOpenExportModal,
  onOpenImportModal,
  onLinkProject,
  selectedProviderId,
  selectedModelId,
  enableThinking,
  onProviderChange,
  onModelChange,
  onThinkingChange,
}) => {
  const { t } = useTranslation()
  const { token } = theme.useToken()

  const { Title, Text } = Typography

  return (
    <Card style={{ marginBottom: 16 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
        <div style={{ flex: 1, minWidth: 0, overflow: 'hidden', position: 'relative' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <Title level={4} style={{ margin: 0 }} ellipsis>{selectedKB.name}</Title>
            {linkedProjects.length > 0 && (
              <Tooltip title={t('knowledgeBase.linkToProject')}>
                <LinkOutlined
                  style={{ cursor: 'pointer', color: token.colorPrimary, fontSize: 14 }}
                  onClick={onLinkProject}
                />
              </Tooltip>
            )}
          </div>
          <Tooltip title={selectedKB.description || t('common.noDescription')}>
            <Text type="secondary" ellipsis style={{ display: 'block' }}>{selectedKB.description || t('common.noDescription')}</Text>
          </Tooltip>
        </div>
        <Space>
          <Button icon={<UploadOutlined />} onClick={onUploadFiles} loading={uploadLoading} type="primary">
            {t('knowledgeBase.uploadFile')}
          </Button>
          <Button icon={<FolderAddOutlined />} onClick={onUploadFolder}>
            {t('knowledgeBase.uploadFolder')}
          </Button>

          <Dropdown
            menu={{
              items: [
                {
                  key: 'edit',
                  label: t('knowledgeBase.edit'),
                  icon: <EditOutlined />,
                  onClick: onEditKB
                },
                {
                  key: 'export',
                  label: t('knowledgeBase.export'),
                  icon: <ExportOutlined />,
                  onClick: onOpenExportModal
                },
                {
                  key: 'import',
                  label: t('knowledgeBase.import'),
                  icon: <ImportOutlined />,
                  onClick: onOpenImportModal
                }
              ]
            }}
            trigger={['click']}
          >
            <Button icon={<MoreOutlined />}>
              {t('common.more')}
            </Button>
          </Dropdown>
        </Space>
      </div>

      <div style={{ marginTop: 12, display: 'flex', justifyContent: 'flex-end', alignItems: 'center', gap: 16 }}>
        <LLMSelector
          providerId={selectedProviderId}
          modelId={selectedModelId}
          onProviderChange={onProviderChange}
          onModelChange={onModelChange}
        />
        <Tooltip title={enableThinking ? t('llmSelector.thinkingEnabled') : t('llmSelector.thinkingDisabled')}>
          <BulbOutlined
            style={{
              fontSize: 18,
              color: enableThinking ? token.colorWarning : token.colorTextSecondary,
              cursor: 'pointer',
              transition: 'color 0.3s'
            }}
            onClick={() => onThinkingChange(!enableThinking)}
          />
        </Tooltip>
      </div>
    </Card>
  )
}

export default KBHeaderCard
