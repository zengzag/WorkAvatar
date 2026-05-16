import { useTranslation } from 'react-i18next'
import { Modal, Input, Typography } from 'antd'

const { Text } = Typography

interface KBCreateModalProps {
  open: boolean
  onCancel: () => void
  onConfirm: () => void
  name: string
  onNameChange: (v: string) => void
  desc: string
  onDescChange: (v: string) => void
}

const KBCreateModal: React.FC<KBCreateModalProps> = ({
  open,
  onCancel,
  onConfirm,
  name,
  onNameChange,
  desc,
  onDescChange,
}) => {
  const { t } = useTranslation()

  return (
    <Modal title={t('knowledgeBase.newKbModal')} open={open} onOk={onConfirm} onCancel={onCancel} okText={t('common.create')} cancelText={t('common.cancel')}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 16, padding: '8px 0' }}>
        <div><Text strong>{t('knowledgeBase.kbName')}</Text>
          <Input placeholder={t('knowledgeBase.kbNamePlaceholder')} value={name} onChange={e => onNameChange(e.target.value)} onPressEnter={onConfirm} style={{ marginTop: 8 }} />
        </div>
        <div><Text strong>{t('knowledgeBase.kbDescOptional')}</Text>
          <Input.TextArea placeholder={t('knowledgeBase.kbDescPlaceholder')} value={desc} onChange={e => onDescChange(e.target.value)} rows={3} style={{ marginTop: 8 }} />
        </div>
      </div>
    </Modal>
  )
}

export default KBCreateModal
