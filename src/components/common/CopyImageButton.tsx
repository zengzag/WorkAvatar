import { App, Button, Tooltip } from 'antd'
import { CheckOutlined, CopyOutlined } from '@ant-design/icons'
import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { copyImageToClipboard } from '../../utils/clipboard'

/** 图片缩略图上的复制按钮：把图片写入系统剪贴板，供粘贴到其他应用 */
const CopyImageButton: React.FC<{
  src: string
  className?: string
  style?: React.CSSProperties
  dataTestId?: string
}> = ({ src, className, style, dataTestId }) => {
  const { t } = useTranslation()
  const { message } = App.useApp()
  const [copied, setCopied] = useState(false)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => () => {
    if (timerRef.current) clearTimeout(timerRef.current)
  }, [])

  const handleCopy = useCallback(async (e: React.MouseEvent) => {
    e.stopPropagation()
    e.preventDefault()
    if (!await copyImageToClipboard(src)) {
      message.error(t('workbench.copyImageFailed'))
      return
    }
    message.success(t('workbench.imageCopied'))
    setCopied(true)
    if (timerRef.current) clearTimeout(timerRef.current)
    timerRef.current = setTimeout(() => setCopied(false), 1500)
  }, [src, message, t])

  return (
    <Tooltip title={t('workbench.copyImage')}>
      <Button
        type="text"
        size="small"
        className={['wa-image-copy-btn', className].filter(Boolean).join(' ')}
        style={style}
        data-testid={dataTestId}
        aria-label={t('workbench.copyImage')}
        icon={copied ? <CheckOutlined style={{ fontSize: 11 }} /> : <CopyOutlined style={{ fontSize: 11 }} />}
        onClick={handleCopy}
      />
    </Tooltip>
  )
}

export default CopyImageButton
