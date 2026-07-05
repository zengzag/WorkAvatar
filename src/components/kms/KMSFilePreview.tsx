import React, { useEffect, useRef, useState, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { Modal, Button, Spin, Typography, Space, Tooltip, theme, Alert } from 'antd'
import {
  FileOutlined, FolderOpenOutlined,
} from '@ant-design/icons'
import HighlightText from './HighlightText'

interface HighlightRange {
  start: number
  end: number
}

interface SearchResult {
  file_id: string
  file_name: string
  file_path: string
  paragraph_id?: string
  paragraph_title?: string
  text: string
  match_type: string
  start_offset?: number
  end_offset?: number
  start_line?: number
  end_line?: number
  score?: number
  highlights?: HighlightRange[]
  matched_keywords?: string[]
}

interface KMSFilePreviewProps {
  open: boolean
  result: SearchResult | null
  keywords: string[]
  onClose: () => void
  onOpenFile: (filePath: string) => void
  onOpenFileDir: (filePath: string) => void
}

const KMSFilePreview: React.FC<KMSFilePreviewProps> = ({
  open,
  result,
  keywords,
  onClose,
  onOpenFile,
  onOpenFileDir,
}) => {
  const { t } = useTranslation()
  const { token } = theme.useToken()

  const [content, setContent] = useState<string>('')
  const [loading, setLoading] = useState(false)
  const [truncated, setTruncated] = useState(false)
  const contentRef = useRef<HTMLDivElement>(null)
  const lineRefs = useRef<HTMLDivElement[]>([])

  const loadContent = useCallback(async () => {
    if (!result) return
    setLoading(true)
    setContent('')
    setTruncated(false)
    try {
      const res = await window.electronAPI.kms.getFileFullContent(result.file_id)
      setContent(res?.content || '')
      setTruncated(!!res?.truncated)
    } catch (err) {
      console.error('Failed to load file content:', err)
      setContent('')
    } finally {
      setLoading(false)
    }
  }, [result])

  useEffect(() => {
    if (open && result) {
      loadContent()
    } else {
      setContent('')
      lineRefs.current = []
    }
  }, [open, result, loadContent])

  useEffect(() => {
    if (!open || !result || loading || !content) return
    const targetLine = result.start_line
    const targetOffset = result.start_offset

    if (targetLine !== undefined && targetLine > 0) {
      const lineIdx = targetLine - 1
      const targetEl = lineRefs.current[lineIdx]
      if (targetEl && contentRef.current) {
        const containerRect = contentRef.current.getBoundingClientRect()
        const elRect = targetEl.getBoundingClientRect()
        const offset = elRect.top - containerRect.top + contentRef.current.scrollTop - 80
        contentRef.current.scrollTo({ top: Math.max(0, offset), behavior: 'smooth' })
        return
      }
    }

    if (targetOffset !== undefined && targetOffset > 0 && contentRef.current) {
      const ratio = targetOffset / content.length
      const targetScroll = ratio * contentRef.current.scrollHeight - 80
      contentRef.current.scrollTo({ top: Math.max(0, targetScroll), behavior: 'smooth' })
    }
  }, [open, result, loading, content])

  const lines = content ? content.split('\n') : []

  const setLineRef = useCallback((el: HTMLDivElement | null, index: number) => {
    if (el) {
      lineRefs.current[index] = el
    } else {
      delete lineRefs.current[index]
    }
  }, [])

  const title = result ? (
    <Space size={8}>
      <FileOutlined />
      <span>{result.file_name}</span>
    </Space>
  ) : t('kms.filePreview')

  return (
    <Modal
      open={open}
      title={title}
      onCancel={onClose}
      footer={null}
      width="90%"
      style={{ top: 20 }}
      styles={{ body: { height: 'calc(90vh - 110px)', padding: 0, overflow: 'hidden', display: 'flex', flexDirection: 'column' } }}
    >
      {/* 顶部操作栏 */}
      <div style={{
        display: 'flex',
        justifyContent: 'flex-end',
        gap: 8,
        padding: '8px 16px',
        borderBottom: `1px solid ${token.colorBorderSecondary}`,
        flexShrink: 0,
      }}>
        <Tooltip title={t('kms.openFile')}>
          <Button
            size="small"
            icon={<FileOutlined />}
            onClick={() => result && onOpenFile(result.file_path)}
          >
            {t('kms.openFile')}
          </Button>
        </Tooltip>
        <Tooltip title={t('kms.openDir')}>
          <Button
            size="small"
            icon={<FolderOpenOutlined />}
            onClick={() => result && onOpenFileDir(result.file_path)}
          >
            {t('kms.openDir')}
          </Button>
        </Tooltip>
      </div>

      {/* 内容区域 */}
      <div
        ref={contentRef}
        style={{
          flex: 1,
          overflow: 'auto',
          padding: '12px 16px',
          backgroundColor: token.colorBgContainer,
        }}
      >
        {truncated && (
          <Alert
            type="warning"
            showIcon
            style={{ marginBottom: 8 }}
            message={t('kms.filePreviewTruncated')}
          />
        )}
        {loading ? (
          <div style={{ textAlign: 'center', padding: 60 }}>
            <Spin size="large" tip={t('kms.loadingContent')} />
          </div>
        ) : content ? (
          <div style={{ fontFamily: 'Consolas, "Courier New", monospace', fontSize: 13, lineHeight: 1.8 }}>
            {lines.map((line, idx) => (
              <div
                key={`line-${idx}`}
                ref={(el) => setLineRef(el, idx)}
                style={{
                  display: 'flex',
                  minHeight: '1.8em',
                  padding: '0 4px',
                  borderRadius: 2,
                }}
              >
                <span
                  style={{
                    color: token.colorTextQuaternary,
                    width: 48,
                    textAlign: 'right',
                    paddingRight: 12,
                    userSelect: 'none',
                    flexShrink: 0,
                  }}
                >
                  {idx + 1}
                </span>
                <span style={{ flex: 1, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
                  <HighlightText text={line} keywords={keywords} />
                </span>
              </div>
            ))}
          </div>
        ) : (
          <div style={{ textAlign: 'center', padding: 60, color: token.colorTextSecondary }}>
            <Typography.Text type="secondary">
              {t('kms.noResults')}
            </Typography.Text>
          </div>
        )}
      </div>
    </Modal>
  )
}

export default KMSFilePreview
