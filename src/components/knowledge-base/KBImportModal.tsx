import { useTranslation } from 'react-i18next'
import { Modal, Typography, Input, Select, Progress, theme } from 'antd'

const { Text } = Typography

interface KBImportModalProps {
  open: boolean
  onCancel: () => void
  onConfirm: () => void
  conflictStrategy: 'skip' | 'overwrite' | 'rename'
  onConflictStrategyChange: (v: 'skip' | 'overwrite' | 'rename') => void
  importing: boolean
  importProgress: { stage: string; detail: string }
  importKBName: string
  onKBNameChange: (v: string) => void
}

const KBImportModal: React.FC<KBImportModalProps> = ({
  open,
  onCancel,
  onConfirm,
  conflictStrategy,
  onConflictStrategyChange,
  importing,
  importProgress,
  importKBName,
  onKBNameChange,
}) => {
  const { t } = useTranslation()
  const { token } = theme.useToken()

  return (
    <Modal
      title={t('knowledgeBase.importModalTitle')}
      open={open}
      onOk={onConfirm}
      onCancel={onCancel}
      okText={t('knowledgeBase.import')}
      cancelText={t('common.cancel')}
      okButtonProps={{ loading: importing }}
      width={520}
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
        <div>
          <Text strong style={{ display: 'block', marginBottom: 8 }}>{t('knowledgeBase.importKbNameLabel')}</Text>
          <Input
            placeholder={t('knowledgeBase.importKbNamePlaceholder')}
            value={importKBName}
            onChange={e => onKBNameChange(e.target.value)}
          />
        </div>
        <div>
          <Text strong style={{ display: 'block', marginBottom: 8 }}>{t('knowledgeBase.conflictStrategyLabel')}</Text>
          <Select
            value={conflictStrategy}
            onChange={v => onConflictStrategyChange(v)}
            style={{ width: '100%' }}
            options={[
              { value: 'skip', label: t('knowledgeBase.conflictSkip') },
              { value: 'overwrite', label: t('knowledgeBase.conflictOverwrite') },
              { value: 'rename', label: t('knowledgeBase.conflictRename') },
            ]}
          />
        </div>
        <div style={{ padding: '8px 12px', background: token.colorInfoBg, borderRadius: 8 }}>
          <Text type="secondary">{t('knowledgeBase.importFullDesc')}</Text>
        </div>
        {importing && importProgress.stage && (
          <div>
            <Progress percent={importProgress.stage === 'complete' ? 100 : undefined} status={importProgress.stage === 'complete' ? 'success' : 'active'} />
            <Text type="secondary" style={{ fontSize: 12 }}>{importProgress.detail}</Text>
          </div>
        )}
      </div>
    </Modal>
  )
}

export default KBImportModal
