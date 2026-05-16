import { useTranslation } from 'react-i18next'
import { Modal, Input, Typography } from 'antd'

const { Text } = Typography

interface KBEditModalProps {
  open: boolean
  onCancel: () => void
  onConfirm: () => void
  name: string
  onNameChange: (v: string) => void
  desc: string
  onDescChange: (v: string) => void
}

const KBEditModal: React.FC<KBEditModalProps> = ({
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
    <Modal
      title={t('knowledgeBase.editKbModal')}
      open={open}
      onOk={onConfirm}
      onCancel={onCancel}
      okText={t('common.save')}
      cancelText={t('common.cancel')}
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
        <div>
          <Text strong style={{ display: 'block', marginBottom: 8 }}>{t('knowledgeBase.kbNameInput')}</Text>
          <Input
            placeholder={t('knowledgeBase.kbNameInputPlaceholder')}
            value={name}
            onChange={(e) => onNameChange(e.target.value)}
          />
        </div>
        <div>
          <Text strong style={{ display: 'block', marginBottom: 8 }}>{t('knowledgeBase.kbIntro')}</Text>
          <Input.TextArea
            placeholder={t('knowledgeBase.kbIntroPlaceholder')}
            value={desc}
            onChange={(e) => onDescChange(e.target.value)}
            rows={4}
          />
        </div>
      </div>
    </Modal>
  )
}

export default KBEditModal
