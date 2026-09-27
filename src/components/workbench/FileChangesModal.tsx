import { useCallback, useEffect, useState } from 'react'
import { Modal, List, Button, Typography, Space, Tag, Empty, App, theme, Popconfirm, Spin } from 'antd'
import { UndoOutlined, FileAddOutlined, EditOutlined, DeleteOutlined, WarningOutlined } from '@ant-design/icons'
import { useTranslation } from 'react-i18next'
import type { FileChangeItem } from '../../../electron/shared/ipc-channels'

const { Text } = Typography
const { useToken } = theme

/** 改动类型 → 图标（明暗主题下随 token 适配） */
function kindIcon(kind: FileChangeItem['changeKind'], color: string) {
  const style = { color }
  switch (kind) {
    case 'write':
    case 'append':
      return <FileAddOutlined style={style} />
    case 'edit':
      return <EditOutlined style={style} />
    case 'delete':
      return <DeleteOutlined style={style} />
    default:
      return <EditOutlined style={style} />
  }
}

function kindLabelKey(kind: FileChangeItem['changeKind']): string {
  return `fileChanges.kind_${kind}`
}

const FileChangesModal: React.FC<{
  open: boolean
  conversationId?: string | null
  onClose: () => void
}> = ({ open, conversationId, onClose }) => {
  const { t } = useTranslation()
  const { token } = useToken()
  const { message } = App.useApp()
  const [items, setItems] = useState<FileChangeItem[]>([])
  const [loading, setLoading] = useState(false)
  const [reverting, setReverting] = useState(false)

  const refresh = useCallback(async () => {
    if (!conversationId) {
      setItems([])
      return
    }
    setLoading(true)
    try {
      const list = await window.electronAPI.snapshot.list(conversationId)
      setItems(Array.isArray(list) ? list : [])
    } catch {
      setItems([])
    } finally {
      setLoading(false)
    }
  }, [conversationId])

  useEffect(() => {
    if (open) refresh()
  }, [open, refresh])

  const handleRevert = useCallback(async (ids?: string[]) => {
    if (!conversationId) return
    setReverting(true)
    try {
      const result = await window.electronAPI.snapshot.revert(conversationId, ids)
      if (result.skipped?.length) {
        message.warning(t('fileChanges.revertedPartial', { count: result.reverted, skipped: result.skipped.length }))
      } else {
        message.success(t('fileChanges.reverted', { count: result.reverted }))
      }
      await refresh()
    } catch {
      message.error(t('fileChanges.revertFailed'))
    } finally {
      setReverting(false)
    }
  }, [conversationId, message, refresh, t])

  const revertableCount = items.filter(i => i.restorable).length

  return (
    <Modal
      open={open}
      title={t('fileChanges.title')}
      onCancel={onClose}
      footer={
        <Space style={{ display: 'flex', justifyContent: 'flex-end' }}>
          <Button onClick={onClose}>{t('common.close')}</Button>
          <Popconfirm
            title={t('fileChanges.revertAllTitle')}
            description={t('fileChanges.revertAllDesc')}
            okText={t('fileChanges.revertConfirm')}
            cancelText={t('common.cancel')}
            onConfirm={() => handleRevert()}
            disabled={revertableCount === 0 || reverting}
          >
            <Button danger icon={<UndoOutlined />} disabled={revertableCount === 0} loading={reverting}>
              {t('fileChanges.revertAll')}
            </Button>
          </Popconfirm>
        </Space>
      }
      width={620}
      styles={{ body: { maxHeight: '60vh', overflowY: 'auto' } }}
    >
      <Text type="secondary" style={{ fontSize: 12, display: 'block', marginBottom: 12 }}>
        {t('fileChanges.hint')}
      </Text>
      {loading ? (
        <div style={{ textAlign: 'center', padding: '24px 0' }}><Spin /></div>
      ) : items.length === 0 ? (
        <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t('fileChanges.empty')} />
      ) : (
        <List
          size="small"
          dataSource={items}
          renderItem={(item) => (
            <List.Item
              actions={[
                <Popconfirm
                  key="revert"
                  title={t('fileChanges.revertOneTitle')}
                  description={t('fileChanges.revertOneDesc')}
                  okText={t('fileChanges.revertConfirm')}
                  cancelText={t('common.cancel')}
                  onConfirm={() => handleRevert([item.id])}
                  disabled={!item.restorable || reverting}
                >
                  <Button
                    type="link"
                    size="small"
                    icon={<UndoOutlined />}
                    disabled={!item.restorable}
                    title={item.restorable ? undefined : t('fileChanges.notRestorable')}
                  >
                    {t('fileChanges.revert')}
                  </Button>
                </Popconfirm>,
              ]}
            >
              <Space align="start" style={{ minWidth: 0 }}>
                {kindIcon(item.changeKind, token.colorPrimary)}
                <div style={{ minWidth: 0 }}>
                  <Space size={6}>
                    <Tag color={item.changeKind === 'delete' ? 'error' : 'blue'} style={{ marginInlineEnd: 0 }}>
                      {t(kindLabelKey(item.changeKind))}
                    </Tag>
                    {!item.restorable && (
                      <Tag icon={<WarningOutlined />} color="warning" style={{ marginInlineEnd: 0 }}>
                        {t('fileChanges.notRestorableTag')}
                      </Tag>
                    )}
                  </Space>
                  <Text
                    style={{ display: 'block', fontSize: 12, wordBreak: 'break-all' }}
                    title={item.path}
                  >
                    {item.path}
                  </Text>
                </div>
              </Space>
            </List.Item>
          )}
        />
      )}
    </Modal>
  )
}

export default FileChangesModal
