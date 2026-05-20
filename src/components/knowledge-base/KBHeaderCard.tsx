import { useTranslation } from 'react-i18next'
import { Typography, Space, Button, Tooltip, Dropdown, Divider, theme } from 'antd'
import {
  UploadOutlined, EditOutlined,
  ExportOutlined, ImportOutlined, FolderAddOutlined, MoreOutlined,
} from '@ant-design/icons'
import LLMSelector from '../llm/LLMSelector'
import { BulbOutlined, DatabaseOutlined } from '@ant-design/icons'
import type { KnowledgeBase } from './types'

interface KBHeaderCardProps {
  selectedKB: KnowledgeBase
  uploadLoading: boolean
  onUploadFiles: () => void
  onUploadFolder: () => void
  onEditKB: () => void
  onOpenExportModal: () => void
  onOpenImportModal: () => void
  selectedProviderId: string
  selectedModelId: string
  enableThinking: boolean
  onLlmChange: (providerId: string, modelId: string) => void
  onThinkingChange: (v: boolean) => void
}

const KBHeaderCard: React.FC<KBHeaderCardProps> = ({
  selectedKB,
  uploadLoading,
  onUploadFiles,
  onUploadFolder,
  onEditKB,
  onOpenExportModal,
  onOpenImportModal,
  selectedProviderId,
  selectedModelId,
  enableThinking,
  onLlmChange,
  onThinkingChange,
}) => {
  const { t } = useTranslation()
  const { token } = theme.useToken()

  const { Text } = Typography

  return (
    <div style={{
      display: 'flex',
      alignItems: 'center',
      gap: 12,
      padding: '8px 12px',
      background: token.colorBgContainer,
      borderRadius: 8,
      border: `1px solid ${token.colorBorderSecondary}`,
      marginBottom: 12,
      flexWrap: 'wrap',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0, flex: '1 1 auto' }}>
        <DatabaseOutlined style={{ color: token.colorPrimary, fontSize: 16, flexShrink: 0 }} />
        <Tooltip title={selectedKB.description || t('common.noDescription')}>
          <Text strong style={{ fontSize: 15 }} ellipsis>{selectedKB.name}</Text>
        </Tooltip>
      </div>

      <Divider vertical style={{ height: 24, margin: '0 4px', flexShrink: 0 }} />

      <Space size={4} style={{ flexShrink: 0 }}>
        <Button icon={<UploadOutlined />} onClick={onUploadFiles} loading={uploadLoading} type="primary" size="small">
          {t('knowledgeBase.uploadFile')}
        </Button>
        <Button icon={<FolderAddOutlined />} onClick={onUploadFolder} size="small">
          {t('knowledgeBase.uploadFolder')}
        </Button>
        <Dropdown
          menu={{
            items: [
              { key: 'edit', label: t('knowledgeBase.edit'), icon: <EditOutlined />, onClick: onEditKB },
              { key: 'export', label: t('knowledgeBase.export'), icon: <ExportOutlined />, onClick: onOpenExportModal },
              { key: 'import', label: t('knowledgeBase.import'), icon: <ImportOutlined />, onClick: onOpenImportModal },
            ]
          }}
          trigger={['click']}
        >
          <Button icon={<MoreOutlined />} size="small" />
        </Dropdown>
      </Space>

      <Divider vertical style={{ height: 24, margin: '0 4px', flexShrink: 0 }} />

      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
        <LLMSelector
          providerId={selectedProviderId}
          modelId={selectedModelId}
          onChange={onLlmChange}
        />
        <Tooltip title={enableThinking ? t('llmSelector.thinkingEnabled') : t('llmSelector.thinkingDisabled')}>
          <BulbOutlined
            style={{
              fontSize: 16,
              color: enableThinking ? token.colorWarning : token.colorTextSecondary,
              cursor: 'pointer',
              transition: 'color 0.3s'
            }}
            onClick={() => onThinkingChange(!enableThinking)}
          />
        </Tooltip>
      </div>
    </div>
  )
}

export default KBHeaderCard
