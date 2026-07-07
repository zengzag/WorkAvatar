import { useMemo, type RefObject } from 'react'
import { useTranslation } from 'react-i18next'
import { Space, Tag, Tooltip, Button, Typography, theme } from 'antd'
import {
  FolderOpenOutlined, FileTextOutlined, FireOutlined, InboxOutlined,
  EyeOutlined, ReloadOutlined, RobotOutlined,
} from '@ant-design/icons'
import type { FileSummaryItem } from '../../hooks/useKMS'
import { formatFileSize } from '../../utils/format'

const { Text } = Typography

/**
 * 统一格式化时间戳（秒 → 指定格式）
 * - 'date'：YYYY-MM-DD（默认）
 * - 'datetime'：YYYY-MM-DD HH:mm
 * - 'time'：HH:mm:ss
 */
export function formatTime(ts: number, format: 'date' | 'datetime' | 'time' = 'date'): string {
  if (!ts) return '-'
  const d = new Date(ts * 1000)
  const date = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
  if (format === 'date') return date
  if (format === 'datetime') {
    return `${date} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
  }
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`
}

export interface UseFileSummaryColumnsOptions {
  /** 当前正在处理摘要生成的文件 ID 集合（ref 镜像，避免 Set 引用进入 useMemo 依赖） */
  processingFileIdsRef: RefObject<Set<string>>
  /** 打开文件 */
  onOpenFile: (filePath: string) => void
  /** 打开文件所在目录 */
  onOpenFileDir: (filePath: string) => void
  /** 触发文件摘要生成 */
  onGenerateFileSummary: (fileId: string) => void
  onRebuildFileIndex?: (fileId: string) => void
}

/**
 * 文件摘要表格列定义 Hook
 *
 * 从 KMSKnowledgeView 抽离，便于复用与单元测试。
 * 使用 ref 镜像读取 processingFileIds，避免 Set 引用进入 useMemo 依赖导致每次变更都重算列定义。
 */
export function useFileSummaryColumns(options: UseFileSummaryColumnsOptions) {
  const { processingFileIdsRef, onOpenFile, onOpenFileDir, onGenerateFileSummary, onRebuildFileIndex } = options
  const { t } = useTranslation()
  const { token } = theme.useToken()

  return useMemo(() => [
    {
      title: t('kms.knowledge.fileName'),
      dataIndex: 'file_name',
      key: 'file_name',
      width: 200,
      render: (text: string, record: FileSummaryItem) => (
        <Tooltip title={record.file_path}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 4, minWidth: 0 }}>
            <FileTextOutlined style={{ color: token.colorTextSecondary, flexShrink: 0, fontSize: 12 }} />
            <span
              style={{ fontSize: 12, fontWeight: 500, cursor: 'pointer', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1, minWidth: 0 }}
              onClick={() => onOpenFile(record.file_path)}
            >
              {text}
            </span>
          </div>
        </Tooltip>
      ),
    },
    {
      title: t('kms.knowledge.tier'),
      dataIndex: 'data_tier',
      key: 'data_tier',
      width: 70,
      render: (tier: string) => (
        <Tag
          color={tier === 'hot' ? 'red' : 'default'}
          style={{ fontSize: 10, margin: 0, padding: '0 4px' }}
        >
          {tier === 'hot' ? <FireOutlined /> : <InboxOutlined />}
        </Tag>
      ),
    },
    {
      title: t('kms.knowledge.dir'),
      dataIndex: 'dir_name',
      key: 'dir_name',
      width: 120,
      render: (text: string, record: FileSummaryItem) => (
        <Tooltip title={record.file_path}>
          <span style={{ fontSize: 12, color: token.colorTextSecondary, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', display: 'block' }}>
            {text || '-'}
          </span>
        </Tooltip>
      ),
    },
    {
      title: t('kms.knowledge.summary'),
      key: 'summary',
      width: 250,
      render: (_: any, record: FileSummaryItem) => {
        const summary = record.summary || record.light_summary || record.preview_text || ''
        return (
          <Tooltip title={summary || t('kms.knowledge.noSummary')}>
            <span style={{ fontSize: 12, color: token.colorTextSecondary, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', display: 'block' }}>
              {summary || t('kms.knowledge.noSummary')}
            </span>
          </Tooltip>
        )
      },
    },
    {
      title: t('kms.knowledge.vector'),
      key: 'vector',
      width: 65,
      render: (_: any, record: FileSummaryItem) => (
        <span style={{ fontSize: 12, color: record.has_embedding ? token.colorSuccess : token.colorTextQuaternary }}>
          {record.has_embedding ? t('common.yes') : t('common.no')}
        </span>
      ),
    },
    {
      title: t('kms.knowledge.size'),
      dataIndex: 'file_size',
      key: 'file_size',
      width: 80,
      render: (size: number) => (
        <Text type="secondary" style={{ fontSize: 11 }}>{formatFileSize(size)}</Text>
      ),
    },
    {
      title: t('kms.knowledge.updated'),
      dataIndex: 'updated_at',
      key: 'updated_at',
      width: 100,
      render: (ts: number) => (
        <Text type="secondary" style={{ fontSize: 11 }}>{formatTime(ts)}</Text>
      ),
    },
    {
      title: t('common.actions'),
      key: 'actions',
      width: 130,
      render: (_: any, record: FileSummaryItem) => {
        const isProcessing = processingFileIdsRef.current?.has(record.id) ?? false
        return (
          <Space size={2}>
            <Tooltip title={t('kms.knowledge.generateFileSummary')}>
              <Button
                size="small"
                type="text"
                icon={isProcessing ? <ReloadOutlined spin /> : <RobotOutlined />}
                loading={isProcessing}
                onClick={() => onGenerateFileSummary(record.id)}
              />
            </Tooltip>
            {onRebuildFileIndex && (
              <Tooltip title={t('kms.rebuildIndex')}>
                <Button
                  size="small"
                  type="text"
                  icon={<ReloadOutlined />}
                  onClick={() => onRebuildFileIndex(record.id)}
                />
              </Tooltip>
            )}
            <Tooltip title={t('kms.openFile')}>
              <Button
                size="small"
                type="text"
                icon={<EyeOutlined />}
                onClick={() => onOpenFile(record.file_path)}
              />
            </Tooltip>
            <Tooltip title={t('kms.openDir')}>
              <Button
                size="small"
                type="text"
                icon={<FolderOpenOutlined />}
                onClick={() => onOpenFileDir(record.file_path)}
              />
            </Tooltip>
          </Space>
        )
      },
    },
  ], [t, token, onOpenFile, onOpenFileDir, onGenerateFileSummary])
}
