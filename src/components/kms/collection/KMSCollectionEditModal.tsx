import React from 'react'
import { useTranslation } from 'react-i18next'
import { Modal, Input, theme } from 'antd'

interface CollectionItem {
  id: string
  name: string
  description: string
  file_count: number
  created_at: number
  updated_at: number
}

interface KMSCollectionEditModalProps {
  open: boolean
  /** null = 创建模式；非 null = 编辑模式 */
  editingCollection: CollectionItem | null
  formName: string
  formDesc: string
  saving: boolean
  onNameChange: (v: string) => void
  onDescChange: (v: string) => void
  onCancel: () => void
  onSave: () => void
}

/** 创建/编辑合集弹窗 */
export const KMSCollectionEditModal: React.FC<KMSCollectionEditModalProps> = ({
  open,
  editingCollection,
  formName,
  formDesc,
  saving,
  onNameChange,
  onDescChange,
  onCancel,
  onSave,
}) => {
  const { t } = useTranslation()
  const { token } = theme.useToken()

  return (
    <Modal
      title={editingCollection ? t('kms.collections.editCollection') : t('kms.collections.createCollection')}
      open={open}
      onCancel={onCancel}
      onOk={onSave}
      confirmLoading={saving}
      okText={t('common.save')}
      cancelText={t('common.cancel')}
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12, paddingTop: 8 }}>
        <div>
          <div style={{ marginBottom: 6, fontSize: 12, color: token.colorTextSecondary }}>
            {t('kms.collections.collectionName')} <span style={{ color: token.colorError }}>*</span>
          </div>
          <Input
            value={formName}
            onChange={(e) => onNameChange(e.target.value)}
            placeholder={t('kms.collections.collectionNamePlaceholder')}
            maxLength={50}
          />
        </div>
        <div>
          <div style={{ marginBottom: 6, fontSize: 12, color: token.colorTextSecondary }}>
            {t('kms.collections.collectionDesc')}
          </div>
          <Input.TextArea
            value={formDesc}
            onChange={(e) => onDescChange(e.target.value)}
            placeholder={t('kms.collections.collectionDescPlaceholder')}
            rows={3}
            maxLength={200}
          />
        </div>
      </div>
    </Modal>
  )
}

export default KMSCollectionEditModal
