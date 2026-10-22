import { App, theme, Tooltip } from 'antd'
import { EyeOutlined, ExportOutlined, FolderOpenOutlined } from '@ant-design/icons'
import React, { useState, memo, useMemo, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import type { GeneratedFileInfo } from '../../types'
import type { MessageSegment } from './types'
import { getFileIcon, getFileColor } from './FilePreview'
import { pathToAppFileUrl } from '../../utils/file-url'
import { useTaskPanelStore } from '../../stores/task-panel.store'

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

interface GeneratedFilesBarProps {
  segments?: MessageSegment[]
}

const GeneratedFilesBar: React.FC<GeneratedFilesBarProps> = ({ segments }) => {
  const { token } = theme.useToken()
  const { message } = App.useApp()
  const { t } = useTranslation()
  const openPreview = useTaskPanelStore((s) => s.openPreview)
  const [missingPaths, setMissingPaths] = useState<Set<string>>(new Set())

  // 聚合所有 tool_call / delegation 段的 generatedFiles，按路径去重（后写覆盖先写，保留最新 size/mtime）
  const generatedFiles = useMemo(() => {
    if (!segments) return []
    const map = new Map<string, GeneratedFileInfo>()
    for (const seg of segments) {
      if (seg.generatedFiles && seg.generatedFiles.length > 0) {
        for (const f of seg.generatedFiles) map.set(f.path, f)
      }
    }
    return Array.from(map.values())
  }, [segments])

  // 探测文件是否仍存在：已删除的文件仍展示，但标记为"已删除"且不可打开
  useEffect(() => {
    if (generatedFiles.length === 0) {
      setMissingPaths(new Set())
      return
    }
    let cancelled = false
    Promise.all(generatedFiles.map(async (f): Promise<[string, boolean]> => {
      try {
        const res = await fetch(pathToAppFileUrl(f.path), { method: 'HEAD' })
        return [f.path, res.ok]
      } catch {
        return [f.path, false]
      }
    })).then(results => {
      if (cancelled) return
      const missing = new Set<string>()
      for (const [p, ok] of results) if (!ok) missing.add(p)
      setMissingPaths(missing)
    })
    return () => { cancelled = true }
  }, [generatedFiles])

  if (generatedFiles.length === 0) return null

  const openWithSystem = async (filePath: string) => {
    const res = await window.electronAPI.kms.openFile(filePath)
    if (res?.error) message.error(`${t('workbench.openWithSystemFailed')}: ${res.error}`)
  }

  return (
    <div style={{
        display: 'flex',
        flexWrap: 'wrap',
        gap: 8,
        marginTop: 4,
        marginLeft: 2,
      }}>
        {generatedFiles.map((file, index) => {
          const IconComp = getFileIcon(file.ext)
          const iconColor = getFileColor(file.ext)
          const isDeleted = missingPaths.has(file.path)
          return (
            <div
              key={`${file.path}-${index}`}
              onClick={isDeleted ? undefined : () => openPreview(file)}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                padding: '6px 12px',
                borderRadius: 8,
                background: token.colorBgTextHover,
                border: `1px solid ${isDeleted ? token.colorErrorBorder : token.colorBorderSecondary}`,
                cursor: isDeleted ? 'not-allowed' : 'pointer',
                opacity: isDeleted ? 0.75 : 1,
                transition: 'all 0.2s',
                maxWidth: 280,
                overflow: 'hidden',
              }}
              onMouseEnter={(e) => {
                if (isDeleted) return
                e.currentTarget.style.borderColor = token.colorPrimary
                e.currentTarget.style.background = token.colorPrimaryBg
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.borderColor = isDeleted ? token.colorErrorBorder : token.colorBorderSecondary
                e.currentTarget.style.background = token.colorBgTextHover
              }}
            >
              <IconComp style={{ color: iconColor, fontSize: 20, flexShrink: 0 }} />
              <div style={{
                minWidth: 0,
                flex: 1,
                overflow: 'hidden',
              }}>
                <div style={{
                  fontSize: 13,
                  fontWeight: 500,
                  color: token.colorText,
                  whiteSpace: 'nowrap',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  textDecoration: isDeleted ? 'line-through' : undefined,
                }}>
                  {file.name}
                </div>
                <div style={{
                  fontSize: 11,
                  color: token.colorTextTertiary,
                  textTransform: 'uppercase',
                }}>
                  {file.ext} · {formatFileSize(file.size)}
                </div>
              </div>
              {isDeleted ? (
                <span style={{
                  fontSize: 11,
                  fontWeight: 500,
                  color: token.colorError,
                  flexShrink: 0,
                  whiteSpace: 'nowrap',
                }}>
                  {t('workbench.fileDeleted')}
                </span>
              ) : (
                <>
                  <Tooltip title={t('workbench.previewFile')}>
                    <EyeOutlined style={{ color: token.colorPrimary, fontSize: 14, flexShrink: 0 }} />
                  </Tooltip>
                  <Tooltip title={t('workbench.openWithSystem')}>
                    <ExportOutlined
                      style={{ color: token.colorTextTertiary, fontSize: 14, flexShrink: 0 }}
                      onClick={(e) => {
                        e.stopPropagation()
                        openWithSystem(file.path)
                      }}
                    />
                  </Tooltip>
                  <Tooltip title={t('workbench.openInExplorer')}>
                    <FolderOpenOutlined
                      style={{ color: token.colorTextTertiary, fontSize: 14, flexShrink: 0 }}
                      onClick={(e) => {
                        e.stopPropagation()
                        window.electronAPI.kms.openFileDir(file.path)
                      }}
                    />
                  </Tooltip>
                </>
              )}
            </div>
          )
        })}
    </div>
  )
}

export default memo(GeneratedFilesBar)
