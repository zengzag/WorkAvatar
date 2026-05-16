import { useTranslation } from 'react-i18next'
import { Modal, Typography, Table, Tag, Button, Checkbox, Empty, Progress, theme, Tooltip } from 'antd'
import { FolderOpenOutlined } from '@ant-design/icons'
import type { ScanTreeNode } from './types'

const { Text } = Typography

interface KBFolderScanModalProps {
  open: boolean
  onClose: () => void
  scanning: boolean
  scannedFiles: Array<{ path: string; name: string; ext: string; size: number }>
  scannedUnsupported: Array<{ path: string; name: string; ext: string }>
  selectedKeys: Set<string>
  onSelectedKeysChange: (keys: Set<string>) => void
  treeData: ScanTreeNode[]
  expandedKeys: string[]
  uploading: boolean
  onTreeSelect: (keys: React.Key[]) => void
  onConfirm: () => void
}

const KBFolderScanModal: React.FC<KBFolderScanModalProps> = ({
  open,
  onClose,
  scanning,
  scannedFiles,
  scannedUnsupported,
  selectedKeys,
  onSelectedKeysChange,
  treeData,
  expandedKeys,
  uploading,
  onTreeSelect,
  onConfirm,
}) => {
  const { t } = useTranslation()
  const { token } = theme.useToken()

  return (
    <Modal
      title={t('knowledgeBase.folderScanModalTitle')}
      open={open}
      onCancel={onClose}
      width={760}
      footer={scanning ? null : [
        <Button key="cancel" onClick={onClose}>
          {t('common.cancel')}
        </Button>,
        <Button key="upload" type="primary" loading={uploading} disabled={selectedKeys.size === 0} onClick={onConfirm}>
          {t('knowledgeBase.uploadSelected', { count: selectedKeys.size })}
        </Button>,
      ]}
    >
      {scanning ? (
        <div style={{ textAlign: 'center', padding: '40px 0' }}>
          <Progress percent={undefined} status="active" />
          <Text type="secondary" style={{ display: 'block', marginTop: 12 }}>{t('knowledgeBase.scanningFolder')}</Text>
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          {scannedUnsupported.length > 0 && (
            <div style={{ padding: '8px 12px', background: token.colorWarningBg, borderRadius: 8 }}>
              <Text type="secondary">{t('knowledgeBase.unsupportedFilesTip', { count: scannedUnsupported.length })}</Text>
            </div>
          )}
          {scannedFiles.length > 0 && (
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <Checkbox
                checked={selectedKeys.size === scannedFiles.length}
                indeterminate={selectedKeys.size > 0 && selectedKeys.size < scannedFiles.length}
                onChange={e => {
                  if (e.target.checked) {
                    onSelectedKeysChange(new Set(scannedFiles.map(f => f.path)))
                  } else {
                    onSelectedKeysChange(new Set())
                  }
                }}
              >
                {t('knowledgeBase.selectAllSupported', { total: scannedFiles.length })}
              </Checkbox>
              <Text type="secondary">{t('knowledgeBase.selectedCount', { count: selectedKeys.size })}</Text>
            </div>
          )}
          {scannedFiles.length > 0 ? (
            <Table
              dataSource={treeData}
              rowKey="key"
              size="small"
              pagination={false}
              scroll={{ y: 420 }}
              defaultExpandedRowKeys={expandedKeys}
              rowSelection={{
                selectedRowKeys: Array.from(selectedKeys),
                onChange: (keys) => onTreeSelect(keys),
              }}
              columns={[
                {
                  title: t('knowledgeBase.fileName'),
                  dataIndex: 'name',
                  key: 'name',
                  ellipsis: true,
                  render: (name: string, record: ScanTreeNode) => (
                    <Tooltip title={record.key}>
                      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                        {!record.isLeaf && <FolderOpenOutlined style={{ color: token.colorWarning }} />}
                        {name}
                        {!record.isLeaf && record.fileCount != null && (
                          <Text type="secondary" style={{ fontSize: 12 }}>({record.fileCount})</Text>
                        )}
                      </span>
                    </Tooltip>
                  ),
                },
                {
                  title: t('common.type'),
                  dataIndex: 'ext',
                  key: 'ext',
                  width: 80,
                  render: (ext: string | undefined, record: ScanTreeNode) => {
                    if (!record.isLeaf || !ext) return null
                    const extUpper = ext.toUpperCase()
                    let color = token.colorTextSecondary
                    if (['pdf'].includes(ext)) color = '#f5222d'
                    else if (['doc', 'docx'].includes(ext)) color = '#1677ff'
                    else if (['xls', 'xlsx', 'csv'].includes(ext)) color = '#52c41a'
                    else if (['png', 'jpg', 'jpeg', 'bmp', 'tiff', 'webp'].includes(ext)) color = '#faad14'
                    else if (['md'].includes(ext)) color = '#722ed1'
                    return <Tag color={color === token.colorTextSecondary ? undefined : color}>{extUpper}</Tag>
                  },
                },
                {
                  title: t('knowledgeBase.size'),
                  dataIndex: 'size',
                  key: 'size',
                  width: 100,
                  render: (size: number | undefined, record: ScanTreeNode) => {
                    if (!record.isLeaf || size == null) return null
                    if (size < 1024) return `${size} B`
                    if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`
                    return `${(size / (1024 * 1024)).toFixed(1)} MB`
                  },
                },
              ]}
            />
          ) : (
            <Empty description={t('knowledgeBase.noSupportedFiles')} />
          )}
        </div>
      )}
    </Modal>
  )
}

export default KBFolderScanModal
