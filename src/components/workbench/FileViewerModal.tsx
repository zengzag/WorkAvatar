import { Modal, Spin, theme, Button, Space, Result } from 'antd'
import {
  FileWordOutlined,
  FileExcelOutlined,
  FilePptOutlined,
  FilePdfOutlined,
  FileImageOutlined,
  FileTextOutlined,
  FileOutlined,
  DownloadOutlined,
  ReloadOutlined,
} from '@ant-design/icons'
import { lazy, Suspense, useCallback, useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { GeneratedFileInfo } from '../../types'
import { pathToAppFileUrl } from '../../utils/file-url'
import { useAppearanceStore, getEffectiveTheme } from '../../stores/appearance.store'

const FileViewer = lazy(() => import('@file-viewer/react-full'))

const FILE_ICONS: Record<string, React.FC<{ style?: React.CSSProperties }>> = {
  docx: FileWordOutlined, docm: FileWordOutlined, dotx: FileWordOutlined, dotm: FileWordOutlined,
  doc: FileWordOutlined, rtf: FileWordOutlined, odt: FileWordOutlined,
  xlsx: FileExcelOutlined, xltx: FileExcelOutlined, xlsm: FileExcelOutlined,
  xlsb: FileExcelOutlined, xls: FileExcelOutlined, csv: FileExcelOutlined, ods: FileExcelOutlined,
  pptx: FilePptOutlined, pptm: FilePptOutlined, potx: FilePptOutlined,
  ppsx: FilePptOutlined, ppsm: FilePptOutlined, odp: FilePptOutlined,
  pdf: FilePdfOutlined, ofd: FilePdfOutlined,
  gif: FileImageOutlined, jpg: FileImageOutlined, jpeg: FileImageOutlined,
  bmp: FileImageOutlined, tiff: FileImageOutlined, tif: FileImageOutlined,
  png: FileImageOutlined, svg: FileImageOutlined, webp: FileImageOutlined,
  ico: FileImageOutlined, heic: FileImageOutlined,
}

const FILE_COLORS: Record<string, string> = {
  docx: '#2b579a', doc: '#2b579a', rtf: '#2b579a', odt: '#2b579a',
  xlsx: '#217346', xls: '#217346', csv: '#217346', ods: '#217346',
  pptx: '#d24726', ppt: '#d24726', odp: '#d24726',
  pdf: '#cb2233', ofd: '#cb2233',
}

export function getFileIcon(ext: string): React.FC<{ style?: React.CSSProperties }> {
  return FILE_ICONS[ext] || FileTextOutlined
}

export function getFileColor(ext: string): string {
  return FILE_COLORS[ext] || '#8c8c8c'
}

interface FileViewerModalProps {
  file: GeneratedFileInfo | null
  open: boolean
  onClose: () => void
}

const FileViewerModal: React.FC<FileViewerModalProps> = ({ file, open, onClose }) => {
  const { token } = theme.useToken()
  const { t } = useTranslation()
  const themeMode = useAppearanceStore((s) => s.themeMode)
  const effectiveTheme = getEffectiveTheme(themeMode)

  const fileUrl = useMemo(() => {
    if (!file) return ''
    return pathToAppFileUrl(file.path)
  }, [file])

  const viewerOptions = useMemo(() => ({ theme: effectiveTheme }), [effectiveTheme])

  // 探测文件是否存在；文件被用户删除时 app-file:// 协议会返回 404，
  // 此处提前拦截并显示提示，避免在预览器内出现空白
  const [fileMissing, setFileMissing] = useState(false)
  const [probing, setProbing] = useState(false)
  const [probeNonce, setProbeNonce] = useState(0)

  useEffect(() => {
    if (!open || !file || !fileUrl) {
      setFileMissing(false)
      setProbing(false)
      return
    }
    let cancelled = false
    setProbing(true)
    setFileMissing(false)
    fetch(fileUrl, { method: 'HEAD' })
      .then((res) => {
        if (cancelled) return
        setFileMissing(!res.ok)
      })
      .catch(() => {
        if (cancelled) return
        setFileMissing(true)
      })
      .finally(() => {
        if (cancelled) return
        setProbing(false)
      })
    return () => {
      cancelled = true
    }
  }, [open, file, fileUrl, probeNonce])

  const handleDownload = useCallback(() => {
    if (!file) return
    window.electronAPI.kms.openFileDir(file.path)
  }, [file])

  const icon = file ? getFileIcon(file.ext) : FileOutlined
  const iconColor = file ? getFileColor(file.ext) : '#8c8c8c'
  const IconComp = icon

  return (
    <Modal
      title={
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <IconComp style={{ color: iconColor, fontSize: 18 }} />
          <span>{file?.name}</span>
        </div>
      }
      open={open}
      onCancel={onClose}
      footer={null}
      width="90%"
      style={{ top: 20 }}
      styles={{ body: { height: 'calc(100vh - 120px)', padding: 0, overflow: 'hidden' } }}
      destroyOnHidden
    >
      {file && (
        <Suspense
          fallback={
            <div style={{
              height: '100%',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
            }}>
              <Spin size="large" />
            </div>
          }
        >
          <div style={{
            height: '100%',
            background: token.colorBgLayout,
            borderRadius: 8,
            overflow: 'hidden',
            position: 'relative',
          }}
          data-viewer-theme={effectiveTheme}
          >
            {probing ? (
              <div style={{
                height: '100%',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
              }}>
                <Spin size="large" />
              </div>
            ) : fileMissing ? (
              <div style={{
                height: '100%',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                padding: 24,
              }}>
                <Result
                  status="warning"
                  title={t('workbench.fileNotFoundTitle')}
                  subTitle={t('workbench.fileNotFoundDesc', { path: file.path })}
                  extra={[
                    <Button key="open" type="primary" onClick={handleDownload}>
                      {t('workbench.fileNotFoundOpenDir')}
                    </Button>,
                    <Button key="retry" icon={<ReloadOutlined />} onClick={() => setProbeNonce((n) => n + 1)}>
                      {t('workbench.fileNotFoundRetry')}
                    </Button>,
                  ]}
                />
              </div>
            ) : (
              <>
                <FileViewer
                  url={fileUrl}
                  options={viewerOptions}
                  style={{ height: '100%', width: '100%' }}
                />
                <div style={{
                  position: 'absolute',
                  bottom: 12,
                  right: 12,
                  zIndex: 10,
                }}>
                  <Space>
                    <Button
                      size="small"
                      icon={<ReloadOutlined />}
                      onClick={() => {
                        const url = fileUrl
                        window.open(url, '_blank')
                      }}
                      title={t('workbench.reloadPreview')}
                    />
                    <Button
                      size="small"
                      icon={<DownloadOutlined />}
                      onClick={handleDownload}
                      title={t('workbench.openInExplorer')}
                    />
                  </Space>
                </div>
              </>
            )}
          </div>
        </Suspense>
      )}
    </Modal>
  )
}

export default FileViewerModal
