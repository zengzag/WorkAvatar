import { useTranslation } from 'react-i18next'
import { Modal, Typography, Progress, theme } from 'antd'

const { Text } = Typography

interface KBExportModalProps {
  open: boolean
  onCancel: () => void
  onConfirm: () => void
  exporting: boolean
  exportProgress: { stage: string; detail: string }
}

const KBExportModal: React.FC<KBExportModalProps> = ({
  open,
  onCancel,
  onConfirm,
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
        <div style={{ padding: '8px 12px', background: token.colorInfoBg, borderRadius: 8 }}>
          <Text type="secondary">{t('knowledgeBase.exportFullDesc')}</Text>
        </div>
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
