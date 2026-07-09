import { useTranslation } from 'react-i18next'
import { Space, Tooltip, Tag, Button, Popconfirm, Typography, theme } from 'antd'
import type { ColumnsType } from 'antd/es/table'
import {
  FileOutlined, FolderOutlined, EyeOutlined, DeleteOutlined, ExclamationCircleOutlined,
} from '@ant-design/icons'
import { formatFileSize } from '../../../utils/format'
import { formatTime } from '../kms-columns'
import type { CollectionFile } from './collection-types'

const { Text } = Typography

export interface CollectionFileColumnsHandlers {
  onOpenFile: (filePath: string) => void
  onPreviewFile: (file: CollectionFile) => void
  onOpenFileDir: (filePath: string) => void
  onRemoveFile: (file: CollectionFile) => void
}

export const buildFileColumns = (
  t: ReturnType<typeof useTranslation>['t'],
  token: ReturnType<typeof theme.useToken>['token'],
  handlers: CollectionFileColumnsHandlers,
): ColumnsType<CollectionFile> => [
  {
    title: t('kms.collections.fileName'),
    dataIndex: 'file_name',
    key: 'file_name',
    render: (name: string, record: CollectionFile) => (
      <Tooltip title={record.file_path}>
        <Space size={4}>
          <FileOutlined style={{ color: token.colorPrimary }} />
          <a onClick={() => handlers.onOpenFile(record.file_path)} style={{ fontSize: 12 }}>{name}</a>
        </Space>
      </Tooltip>
    ),
  },
  {
    title: t('kms.collections.fileSize'),
    dataIndex: 'file_size',
    key: 'file_size',
    width: 90,
    render: (size: number) => <Text type="secondary" style={{ fontSize: 12 }}>{formatFileSize(size)}</Text>,
  },
  {
    title: t('kms.collections.fileStatus'),
    dataIndex: 'index_status',
    key: 'index_status',
    width: 90,
    render: (status: string) => {
      const colorMap: Record<string, string> = {
        completed: 'success',
        pending: 'processing',
        failed: 'error',
      }
      const labelMap: Record<string, string> = {
        completed: t('kms.collections.statusCompleted'),
        pending: t('kms.collections.statusPending'),
        failed: t('kms.collections.statusFailed'),
      }
      return <Tag color={colorMap[status] || 'default'} style={{ fontSize: 11 }}>{labelMap[status] || status}</Tag>
    },
  },
  {
    title: t('kms.collections.fileSummary'),
    dataIndex: 'summary',
    key: 'summary',
    ellipsis: true,
    render: (summary: string, record: CollectionFile) => {
      const text = summary || record.light_summary
      return text
        ? <Text type="secondary" style={{ fontSize: 12 }}>{text}</Text>
        : <Text type="secondary" style={{ fontSize: 12, opacity: 0.5 }}>-</Text>
    },
  },
  {
    title: t('kms.collections.addedAt'),
    dataIndex: 'added_at',
    key: 'added_at',
    width: 130,
    render: (ts: number) => <Text type="secondary" style={{ fontSize: 11 }}>{formatTime(ts, 'datetime')}</Text>,
  },
  {
    title: '',
    key: 'actions',
    width: 140,
    render: (_: any, record: CollectionFile) => (
      <Space size={4}>
        <Tooltip title={t('kms.collections.previewFile')}>
          <Button type="text" size="small" icon={<EyeOutlined />} onClick={() => handlers.onPreviewFile(record)} />
        </Tooltip>
        <Tooltip title={t('kms.openDir')}>
          <Button type="text" size="small" icon={<FolderOutlined />} onClick={() => handlers.onOpenFileDir(record.file_path)} />
        </Tooltip>
        <Popconfirm
          title={t('kms.collections.removeFileConfirm')}
          icon={<ExclamationCircleOutlined style={{ color: token.colorError }} />}
          onConfirm={() => handlers.onRemoveFile(record)}
        >
          <Button type="text" size="small" danger icon={<DeleteOutlined />} />
        </Popconfirm>
      </Space>
    ),
  },
]
