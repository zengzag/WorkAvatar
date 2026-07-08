import React, { useEffect, useRef, useState, useCallback, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { Modal, Button, Spin, Typography, Space, Tooltip, theme, Alert } from 'antd'
import {
  FileOutlined, FolderOpenOutlined, ArrowUpOutlined, ArrowDownOutlined,
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
  /** 同文件的所有匹配结果（用于预览中切换匹配位置） */
  allMatches?: SearchResult[]
  keywords: string[]
  onClose: () => void
  onOpenFile: (filePath: string) => void
  onOpenFileDir: (filePath: string) => void
}

const KMSFilePreview: React.FC<KMSFilePreviewProps> = ({
  open,
  result,
  allMatches,
  keywords,
  onClose,
  onOpenFile,
  onOpenFileDir,
}) => {
  const { t } = useTranslation()
  const { token } = theme.useToken()
  const { Text } = Typography

  const [content, setContent] = useState<string>('')
  const [loading, setLoading] = useState(false)
  const [truncated, setTruncated] = useState(false)
  const [currentMatchIndex, setCurrentMatchIndex] = useState(0)
  const contentRef = useRef<HTMLDivElement>(null)
  const lineRefs = useRef<HTMLDivElement[]>([])

  // 确定当前预览的匹配项
  const effectiveMatches = useMemo(() => {
    if (allMatches && allMatches.length > 0) return allMatches
    return result ? [result] : []
  }, [allMatches, result])

  const currentResult = effectiveMatches[currentMatchIndex] || result

  useEffect(() => {
    // 找到用户点击的具体匹配项在 effectiveMatches 中的索引
    if (result && effectiveMatches.length > 1) {
      const idx = effectiveMatches.findIndex(m =>
        m.paragraph_id === result.paragraph_id &&
        m.start_offset === result.start_offset &&
        m.start_line === result.start_line
      )
      setCurrentMatchIndex(idx >= 0 ? idx : 0)
    } else {
      setCurrentMatchIndex(0)
    }
  }, [result, open, effectiveMatches])

  const currentFileId = currentResult?.file_id

  const lines = content ? content.split('\n') : []

  const loadContent = useCallback(async () => {
    if (!currentFileId) return
    setLoading(true)
    setContent('')
    setTruncated(false)
    try {
      const res = await window.electronAPI.kms.getFileFullContent(currentFileId)
      setContent(res?.content || '')
      setTruncated(!!res?.truncated)
    } catch (err) {
      console.error('Failed to load file content:', err)
      setContent('')
    } finally {
      setLoading(false)
    }
  }, [currentFileId])

  useEffect(() => {
    if (open && currentResult) {
      // 仅当 file_id 不同时才重新加载内容（匹配切换时不需要重新加载）
      loadContent()
    } else {
      setContent('')
      lineRefs.current = []
    }
  }, [open, currentResult?.file_id, loadContent])

  useEffect(() => {
    if (!open || !currentResult || loading || !content) return
    const targetLine = currentResult.start_line
    const targetOffset = currentResult.start_offset

    // 使用 requestAnimationFrame 确保 DOM 已渲染（refs 已挂载）
    const rafId = requestAnimationFrame(() => {
      if (!contentRef.current) return

      if (targetLine !== undefined && targetLine > 0) {
        const lineIdx = Math.min(targetLine - 1, lines.length - 1)
        const targetEl = lineRefs.current[lineIdx]
        if (targetEl) {
          const containerRect = contentRef.current!.getBoundingClientRect()
          const elRect = targetEl.getBoundingClientRect()
          const scrollOffset = elRect.top - containerRect.top + contentRef.current!.scrollTop - 80
          contentRef.current!.scrollTo({ top: Math.max(0, scrollOffset), behavior: 'smooth' })
          return
        }
      }

      // 回退：按 start_offset 的比例定位
      if (targetOffset !== undefined && targetOffset > 0) {
        // 通过行内容来精确找到 offset 对应的行
        let accumulatedLen = 0
        for (let i = 0; i < lines.length; i++) {
          accumulatedLen += lines[i].length + 1 // +1 for \n
          if (accumulatedLen > targetOffset) {
            const targetEl = lineRefs.current[i]
            if (targetEl) {
              const containerRect = contentRef.current!.getBoundingClientRect()
              const elRect = targetEl.getBoundingClientRect()
              const scrollOffset = elRect.top - containerRect.top + contentRef.current!.scrollTop - 80
              contentRef.current!.scrollTo({ top: Math.max(0, scrollOffset), behavior: 'smooth' })
            }
            return
          }
        }
        // 如果没找到对应行，按比例回退
        const ratio = Math.min(targetOffset / Math.max(content.length, 1), 1)
        const targetScroll = ratio * contentRef.current!.scrollHeight - 80
        contentRef.current!.scrollTo({ top: Math.max(0, targetScroll), behavior: 'smooth' })
      }
    })

    return () => cancelAnimationFrame(rafId)
  }, [open, currentResult, loading, content, lines])

  const handlePrevMatch = useCallback(() => {
    setCurrentMatchIndex(prev => Math.max(0, prev - 1))
  }, [])

  const handleNextMatch = useCallback(() => {
    setCurrentMatchIndex(prev => Math.min(effectiveMatches.length - 1, prev + 1))
  }, [effectiveMatches.length])

  const setLineRef = useCallback((el: HTMLDivElement | null, index: number) => {
    if (el) {
      lineRefs.current[index] = el
    } else {
      delete lineRefs.current[index]
    }
  }, [])

  const title = currentResult ? (
    <Space size={8}>
      <FileOutlined />
      <span>{currentResult.file_name}</span>
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
        justifyContent: 'space-between',
        alignItems: 'center',
        gap: 8,
        padding: '8px 16px',
        borderBottom: `1px solid ${token.colorBorderSecondary}`,
        flexShrink: 0,
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          {effectiveMatches.length > 0 && (
            <>
              <Text type="secondary" style={{ fontSize: 12 }}>
                {t('kms.matchCount', { count: effectiveMatches.length })}
              </Text>
              {effectiveMatches.length > 1 && (
                <Space size={2}>
                  <Tooltip title={t('kms.prevMatch')}>
                    <Button
                      size="small"
                      icon={<ArrowUpOutlined />}
                      disabled={currentMatchIndex <= 0}
                      onClick={handlePrevMatch}
                    />
                  </Tooltip>
                  <Text type="secondary" style={{ fontSize: 12 }}>
                    {currentMatchIndex + 1}/{effectiveMatches.length}
                  </Text>
                  <Tooltip title={t('kms.nextMatch')}>
                    <Button
                      size="small"
                      icon={<ArrowDownOutlined />}
                      disabled={currentMatchIndex >= effectiveMatches.length - 1}
                      onClick={handleNextMatch}
                    />
                  </Tooltip>
                </Space>
              )}
            </>
          )}
        </div>
        <Space size={4}>
          <Tooltip title={t('kms.openFile')}>
            <Button
              size="small"
              icon={<FileOutlined />}
              onClick={() => currentResult && onOpenFile(currentResult.file_path)}
            >
              {t('kms.openFile')}
            </Button>
          </Tooltip>
          <Tooltip title={t('kms.openDir')}>
            <Button
              size="small"
              icon={<FolderOpenOutlined />}
              onClick={() => currentResult && onOpenFileDir(currentResult.file_path)}
            >
              {t('kms.openDir')}
            </Button>
          </Tooltip>
        </Space>
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
            <Spin size="large" description={t('kms.loadingContent')} />
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
