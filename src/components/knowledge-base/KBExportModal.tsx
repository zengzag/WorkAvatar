import { useTranslation } from 'react-i18next'
import { Modal, Typography, Radio, Space, Select, Progress, theme } from 'antd'

const { Text } = Typography

interface KBExportModalProps {
  open: boolean
  onCancel: () => void
  onConfirm: () => void
  exportType: 'full' | 'summary' | 'documents'
  onTypeChange: (v: 'full' | 'summary' | 'documents') => void
  exportFormat: 'json-ld' | 'csv'
  onFormatChange: (v: 'json-ld' | 'csv') => void
  exporting: boolean
  exportProgress: { stage: string; detail: string }
}

const KBExportModal: React.FC<KBExportModalProps> = ({
  open,
  onCancel,
  onConfirm,
  exportType,
  onTypeChange,
  exportFormat,
  onFormatChange,
  exporting,
  exportProgress,
}) => {
  const { t } = useTranslation()
  const { token } = theme.useToken()

  return (
    <Modal
      title={t('knowledgeBase.exportModalTitle')}
      open={open}
      onOk={onConfirm}
      onCancel={onCancel}
      okText={t('knowledgeBase.export')}
      cancelText={t('common.cancel')}
      okButtonProps={{ loading: exporting }}
      width={520}
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
        <div>
          <Text strong style={{ display: 'block', marginBottom: 8 }}>{t('knowledgeBase.exportTypeLabel')}</Text>
          <Radio.Group value={exportType} onChange={e => onTypeChange(e.target.value)}>
            <Space orientation="vertical">
              <Radio value="full">{t('knowledgeBase.exportTypeFull')}</Radio>
              <Radio value="summary">{t('knowledgeBase.exportTypeSummary')}</Radio>
              <Radio value="documents">{t('knowledgeBase.exportTypeDocuments')}</Radio>
            </Space>
          </Radio.Group>
        </div>
        {exportType === 'summary' && (
          <div>
            <Text strong style={{ display: 'block', marginBottom: 8 }}>{t('knowledgeBase.exportFormatLabel')}</Text>
            <Select
              value={exportFormat}
              onChange={onFormatChange}
              style={{ width: '100%' }}
              options={[
                { value: 'json-ld', label: 'JSON-LD' },
                { value: 'csv', label: 'CSV' },
              ]}
            />
          </div>
        )}
        {exportType === 'full' && (
          <div style={{ padding: '8px 12px', background: token.colorInfoBg, borderRadius: 8 }}>
            <Text type="secondary">{t('knowledgeBase.exportFullDesc')}</Text>
          </div>
        )}
        {exportType === 'summary' && (
          <div style={{ padding: '8px 12px', background: token.colorInfoBg, borderRadius: 8 }}>
            <Text type="secondary">{t('knowledgeBase.exportSummaryDesc')}</Text>
          </div>
        )}
        {exportType === 'documents' && (
          <div style={{ padding: '8px 12px', background: token.colorInfoBg, borderRadius: 8 }}>
            <Text type="secondary">{t('knowledgeBase.exportDocsDesc')}</Text>
          </div>
        )}
        {exporting && exportProgress.stage && (
          <div>
            <Progress percent={exportProgress.stage === 'complete' ? 100 : undefined} status={exportProgress.stage === 'complete' ? 'success' : 'active'} />
            <Text type="secondary" style={{ fontSize: 12 }}>{exportProgress.detail}</Text>
          </div>
        )}
      </div>
    </Modal>
  )
}

export default KBExportModal
