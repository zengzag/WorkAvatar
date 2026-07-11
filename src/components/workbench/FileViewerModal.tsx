import { Modal, Spin, theme, Button, Space } from 'antd'
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
import { lazy, Suspense, useCallback, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import type { GeneratedFileInfo } from '../../types'
import { pathToAppFileUrl } from '../../utils/file-url'

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

  const fileUrl = useMemo(() => {
    if (!file) return ''
    return pathToAppFileUrl(file.path)
  }, [file])

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
          }}>
            <FileViewer
              url={fileUrl}
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
          </div>
        </Suspense>
      )}
    </Modal>
  )
}

export default FileViewerModal
