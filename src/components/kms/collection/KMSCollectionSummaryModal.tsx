import React from 'react'
import { useTranslation } from 'react-i18next'
import { Modal, Input, Button, theme } from 'antd'
import { RobotOutlined } from '@ant-design/icons'
import type { CollectionItem } from './index'

interface KMSCollectionSummaryModalProps {
  open: boolean
  summaryCollection: CollectionItem | null
  summaryText: string
  summaryTopics: string
  summarySaving: boolean
  summaryGenerating: boolean
  onSummaryChange: (v: string) => void
  onTopicsChange: (v: string) => void
  onCancel: () => void
  onSave: () => void
  onAIGenerate: () => void
}

/** 合集摘要编辑弹窗（含 AI 生成） */
const KMSCollectionSummaryModalComponent: React.FC<KMSCollectionSummaryModalProps> = ({
  open,
  summaryCollection,
  summaryText,
  summaryTopics,
  summarySaving,
  summaryGenerating,
  onSummaryChange,
  onTopicsChange,
  onCancel,
  onSave,
  onAIGenerate,
}) => {
  const { t } = useTranslation()
  const { token } = theme.useToken()

  return (
    <Modal
      title={summaryCollection ? `${t('kms.collections.editSummary')} - ${summaryCollection.name}` : t('kms.collections.editSummary')}
      open={open}
      onCancel={onCancel}
      footer={[
        <Button key="cancel" onClick={onCancel}>{t('common.cancel')}</Button>,
        <Button key="ai" type="default" icon={<RobotOutlined />} loading={summaryGenerating} onClick={onAIGenerate}>
          {t('kms.collections.aiGenerateSummary')}
        </Button>,
        <Button key="save" type="primary" loading={summarySaving} onClick={onSave}>
          {t('common.save')}
        </Button>,
      ]}
      width={600}
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12, paddingTop: 8 }}>
        <div>
          <div style={{ marginBottom: 6, fontSize: 12, color: token.colorTextSecondary }}>
            {t('kms.collections.summary')}
          </div>
          <Input.TextArea
            value={summaryText}
            onChange={(e) => onSummaryChange(e.target.value)}
            placeholder={t('kms.collections.summaryPlaceholder')}
            rows={6}
            maxLength={2000}
          />
        </div>
        <div>
          <div style={{ marginBottom: 6, fontSize: 12, color: token.colorTextSecondary }}>
            {t('kms.collections.keyTopics')}
          </div>
          <Input
            value={summaryTopics}
            onChange={(e) => onTopicsChange(e.target.value)}
            placeholder={t('kms.collections.keyTopicsPlaceholder')}
          />
        </div>
      </div>
    </Modal>
  )
}

// React.memo 包裹避免父组件无关渲染导致的重复绘制
const KMSCollectionSummaryModal = React.memo(KMSCollectionSummaryModalComponent)
export { KMSCollectionSummaryModal }
export default KMSCollectionSummaryModal
