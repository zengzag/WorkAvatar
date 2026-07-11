import { theme, Tooltip } from 'antd'
import { EyeOutlined, FolderOpenOutlined } from '@ant-design/icons'
import React, { useState, memo, useMemo, Suspense } from 'react'
import { useTranslation } from 'react-i18next'
import type { GeneratedFileInfo } from '../../types'
import type { MessageSegment } from './types'
import { getFileIcon, getFileColor } from './FileViewerModal'

const FileViewerModal = React.lazy(() => import('./FileViewerModal'))

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
  const { t } = useTranslation()
  const [previewFile, setPreviewFile] = useState<GeneratedFileInfo | null>(null)

  const generatedFiles = useMemo(() => {
    if (!segments) return []
    const files: GeneratedFileInfo[] = []
    for (const seg of segments) {
      if (seg.type === 'tool_call' && seg.generatedFiles && seg.generatedFiles.length > 0) {
        files.push(...seg.generatedFiles)
      }
    }
    return files
  }, [segments])

  if (generatedFiles.length === 0) return null

  return (
    <>
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
          return (
            <div
              key={`${file.path}-${index}`}
              onClick={() => setPreviewFile(file)}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                padding: '6px 12px',
                borderRadius: 8,
                background: token.colorBgTextHover,
                border: `1px solid ${token.colorBorderSecondary}`,
                cursor: 'pointer',
                transition: 'all 0.2s',
                maxWidth: 280,
                overflow: 'hidden',
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.borderColor = token.colorPrimary
                e.currentTarget.style.background = token.colorPrimaryBg
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.borderColor = token.colorBorderSecondary
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
              <Tooltip title={t('workbench.previewFile')}>
                <EyeOutlined style={{ color: token.colorPrimary, fontSize: 14, flexShrink: 0 }} />
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
            </div>
          )
        })}
      </div>
      <Suspense fallback={null}>
        <FileViewerModal
          file={previewFile}
          open={!!previewFile}
          onClose={() => setPreviewFile(null)}
        />
      </Suspense>
    </>
  )
}

export default memo(GeneratedFilesBar)
