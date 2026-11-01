import { Spin, theme, Button, Space, Result, App } from 'antd'
import {
  FileWordOutlined,
  FileExcelOutlined,
  FilePptOutlined,
  FilePdfOutlined,
  FileImageOutlined,
  FileTextOutlined,
  ReloadOutlined,
  MoonOutlined,
  SunOutlined,
  ExportOutlined,
} from '@ant-design/icons'
import { lazy, Suspense, useCallback, useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { GeneratedFileInfo } from '../../types'
import { pathToAppFileUrl } from '../../utils/file-url'
import { useAppearanceStore, getEffectiveTheme } from '../../stores/appearance.store'
import { isCodePreviewPath, MAX_CODE_PREVIEW_BYTES } from '../../utils/shiki'
import CodePreview from './CodePreview'
import ImagePreview, { isImagePreviewPath } from './ImagePreview'

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

interface FilePreviewProps {
  file: GeneratedFileInfo
}

/**
 * 文件预览正文（不含弹窗容器）：供任务右侧面板内嵌使用。
 * 文件被用户删除时 app-file:// 返回 404，这里提前拦截并给出可恢复提示。
 */
const FilePreview: React.FC<FilePreviewProps> = ({ file }) => {
  const { token } = theme.useToken()
  const { message } = App.useApp()
  const { t } = useTranslation()
  const themeMode = useAppearanceStore((s) => s.themeMode)
  const effectiveTheme = getEffectiveTheme(themeMode)
  const [previewTheme, setPreviewTheme] = useState<'light' | 'dark'>(effectiveTheme)

  // 应用主题变化时同步预览主题，手动切换仅在当前预览内生效
  useEffect(() => {
    setPreviewTheme(effectiveTheme)
  }, [effectiveTheme])

  const fileUrl = useMemo(() => pathToAppFileUrl(file.path), [file.path])
  const codePreview = useMemo(
    () => isCodePreviewPath(file.path) && file.size <= MAX_CODE_PREVIEW_BYTES,
    [file.path, file.size],
  )
  const imagePreview = useMemo(() => !codePreview && isImagePreviewPath(file.ext), [codePreview, file.ext])
  const viewerOptions = useMemo(() => ({
    theme: previewTheme,
    // 侧边栏预览聚焦"看"：隐藏顶部工具栏（搜索/缩放/主题），主题切换与系统打开由右下角按钮提供
    toolbar: false,
  }), [previewTheme])

  const [fileMissing, setFileMissing] = useState(false)
  const [probing, setProbing] = useState(true)
  const [probeNonce, setProbeNonce] = useState(0)

  useEffect(() => {
    let cancelled = false
    setProbing(true)
    setFileMissing(false)
    fetch(fileUrl, { method: 'HEAD' })
      .then((res) => { if (!cancelled) setFileMissing(!res.ok) })
      .catch(() => { if (!cancelled) setFileMissing(true) })
      .finally(() => { if (!cancelled) setProbing(false) })
    return () => { cancelled = true }
  }, [fileUrl, probeNonce])

  const openInExplorer = useCallback(() => {
    window.electronAPI.kms.openFileDir(file.path)
  }, [file.path])

  const openWithSystem = useCallback(async () => {
    const res = await window.electronAPI.kms.openFile(file.path)
    if (res?.error) message.error(`${t('workbench.openWithSystemFailed')}: ${res.error}`)
  }, [file.path, message, t])

  if (probing) {
    return (
      <div style={{ height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <Spin size="large" />
      </div>
    )
  }

  if (fileMissing) {
    return (
      <div style={{ height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24 }}>
        <Result
          status="warning"
          title={t('workbench.fileNotFoundTitle')}
          subTitle={t('workbench.fileNotFoundDesc', { path: file.path })}
          extra={[
            <Button key="open" type="primary" onClick={openInExplorer}>
              {t('workbench.fileNotFoundOpenDir')}
            </Button>,
            <Button key="retry" icon={<ReloadOutlined />} onClick={() => setProbeNonce((n) => n + 1)}>
              {t('workbench.fileNotFoundRetry')}
            </Button>,
          ]}
        />
      </div>
    )
  }

  return (
    <div
      style={{
        height: '100%',
        background: token.colorBgLayout,
        overflow: 'hidden',
        position: 'relative',
      }}
      data-viewer-theme={previewTheme}
    >
      {codePreview ? (
        <CodePreview file={file} fileUrl={fileUrl} dark={previewTheme === 'dark'} />
      ) : imagePreview ? (
        <ImagePreview fileUrl={fileUrl} fileName={file.name} onOpenWithSystem={openWithSystem} />
      ) : (
        <Suspense
          fallback={
            <div style={{ height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
              <Spin size="large" />
            </div>
          }
        >
          <FileViewer url={fileUrl} options={viewerOptions} style={{ height: '100%', width: '100%' }} />
        </Suspense>
      )}
      <div style={{ position: 'absolute', bottom: 12, right: 12, zIndex: 10 }}>
        <Space>
          {!imagePreview && (
            <Button
              size="small"
              icon={previewTheme === 'dark' ? <SunOutlined /> : <MoonOutlined />}
              onClick={() => setPreviewTheme((prev) => (prev === 'dark' ? 'light' : 'dark'))}
              title={t('workbench.togglePreviewTheme')}
            />
          )}
          <Button
            size="small"
            icon={<ExportOutlined />}
            onClick={openWithSystem}
            title={t('workbench.openWithSystem')}
          />
        </Space>
      </div>
    </div>
  )
}

export default FilePreview
