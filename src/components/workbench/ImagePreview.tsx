import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Button, Result, Spin, Tooltip, theme } from 'antd'
import {
  ExpandOutlined,
  OneToOneOutlined,
  ReloadOutlined,
  ZoomInOutlined,
  ZoomOutOutlined,
} from '@ant-design/icons'
import { useTranslation } from 'react-i18next'

/** 支持滚轮缩放/拖拽平移的常见位图格式（HEIC/TIFF 仍交给 file-viewer 解码） */
const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'ico', 'avif'])

export function isImagePreviewPath(ext: string): boolean {
  return IMAGE_EXTENSIONS.has(ext.replace(/^\./, '').toLowerCase())
}

interface ImagePreviewProps {
  fileUrl: string
  fileName?: string
  onOpenWithSystem?: () => void
}

interface ViewState {
  scale: number
  x: number
  y: number
}

const VIEWPORT_PADDING = 24
const MAX_SCALE = 16

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value))

/** 图片预览：滚轮以光标为中心缩放、拖拽平移、双击在「适应窗口 / 原始尺寸」间切换，支持双指缩放 */
const ImagePreview: React.FC<ImagePreviewProps> = ({ fileUrl, fileName, onOpenWithSystem }) => {
  const { token } = theme.useToken()
  const { t } = useTranslation()
  const viewportRef = useRef<HTMLDivElement>(null)
  const pointersRef = useRef(new Map<number, { x: number; y: number }>())
  const dragRef = useRef<{ startX: number; startY: number; viewX: number; viewY: number } | null>(null)
  const pinchRef = useRef<{ distance: number; scale: number; midX: number; midY: number; viewX: number; viewY: number } | null>(null)
  const adjustedRef = useRef(false)
  const viewRef = useRef<ViewState>({ scale: 1, x: 0, y: 0 })

  const [natural, setNatural] = useState<{ width: number; height: number } | null>(null)
  const [viewport, setViewport] = useState({ width: 0, height: 0 })
  const [view, setView] = useState<ViewState>({ scale: 1, x: 0, y: 0 })
  const [dragging, setDragging] = useState(false)
  const [failed, setFailed] = useState(false)
  const [attempt, setAttempt] = useState(0)

  viewRef.current = view

  const fitScale = useMemo(() => {
    if (!natural || viewport.width <= 0 || viewport.height <= 0) return 1
    const width = Math.max(1, viewport.width - VIEWPORT_PADDING * 2)
    const height = Math.max(1, viewport.height - VIEWPORT_PADDING * 2)
    return Math.min(1, width / natural.width, height / natural.height)
  }, [natural, viewport])

  const minScale = Math.max(0.02, fitScale * 0.2)

  const applyFit = useCallback(() => {
    if (!natural) return
    setView({
      scale: fitScale,
      x: (viewport.width - natural.width * fitScale) / 2,
      y: (viewport.height - natural.height * fitScale) / 2,
    })
  }, [natural, fitScale, viewport.width, viewport.height])

  /** 限制平移范围：小图居中，大图不留空白，避免把图片拖出可视区 */
  const constrainView = useCallback((next: ViewState): ViewState => {
    if (!natural || viewport.width <= 0 || viewport.height <= 0) return next
    const limit = (value: number, size: number, viewSize: number) => (
      size <= viewSize ? (viewSize - size) / 2 : clamp(value, viewSize - size, 0)
    )
    return {
      scale: next.scale,
      x: limit(next.x, natural.width * next.scale, viewport.width),
      y: limit(next.y, natural.height * next.scale, viewport.height),
    }
  }, [natural, viewport.width, viewport.height])

  // 图片加载完成时重置为适应窗口；容器尺寸变化时保留用户已手动调整的视角
  const naturalRef = useRef(natural)
  useEffect(() => {
    if (!natural) return
    if (naturalRef.current === natural && adjustedRef.current) return
    naturalRef.current = natural
    adjustedRef.current = false
    applyFit()
  }, [natural, applyFit])

  // 容器尺寸监听
  useEffect(() => {
    const el = viewportRef.current
    if (!el) return
    const update = () => setViewport({ width: el.clientWidth, height: el.clientHeight })
    update()
    const observer = new ResizeObserver(update)
    observer.observe(el)
    return () => observer.disconnect()
  }, [])

  // 滚轮缩放：React 合成事件为 passive，需原生非 passive 监听才能阻止页面滚动
  useEffect(() => {
    const el = viewportRef.current
    if (!el) return
    const onWheel = (event: WheelEvent) => {
      if (failed || !natural) return
      event.preventDefault()
      const rect = el.getBoundingClientRect()
      const anchorX = event.clientX - rect.left
      const anchorY = event.clientY - rect.top
      const delta = event.deltaMode === 1 ? event.deltaY * 16 : event.deltaMode === 2 ? event.deltaY * el.clientHeight : event.deltaY
      const factor = Math.exp(-delta * 0.0015)
      adjustedRef.current = true
      setView((prev) => {
        const next = clamp(prev.scale * factor, minScale, MAX_SCALE)
        const ratio = next / prev.scale
        return constrainView({
          scale: next,
          x: anchorX - (anchorX - prev.x) * ratio,
          y: anchorY - (anchorY - prev.y) * ratio,
        })
      })
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [failed, natural, minScale, constrainView])

  const zoomBy = useCallback((factor: number, anchorX?: number, anchorY?: number) => {
    const anchor = {
      x: anchorX ?? viewport.width / 2,
      y: anchorY ?? viewport.height / 2,
    }
    adjustedRef.current = true
    setView((prev) => {
      const next = clamp(prev.scale * factor, minScale, MAX_SCALE)
      const ratio = next / prev.scale
      return constrainView({
        scale: next,
        x: anchor.x - (anchor.x - prev.x) * ratio,
        y: anchor.y - (anchor.y - prev.y) * ratio,
      })
    })
  }, [viewport.width, viewport.height, minScale, constrainView])

  const handleDoubleClick = useCallback((event: React.MouseEvent) => {
    if (!natural) return
    const rect = event.currentTarget.getBoundingClientRect()
    const anchorX = event.clientX - rect.left
    const anchorY = event.clientY - rect.top
    if (Math.abs(viewRef.current.scale - 1) > 0.01) {
      zoomBy(1 / viewRef.current.scale, anchorX, anchorY)
    } else {
      adjustedRef.current = false
      applyFit()
    }
  }, [natural, zoomBy, applyFit])

  const handlePointerDown = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    if (failed || !natural || event.button !== 0) return
    event.currentTarget.setPointerCapture(event.pointerId)
    pointersRef.current.set(event.pointerId, { x: event.clientX, y: event.clientY })
    if (pointersRef.current.size === 1) {
      dragRef.current = { startX: event.clientX, startY: event.clientY, viewX: view.x, viewY: view.y }
      setDragging(true)
      return
    }
    if (pointersRef.current.size === 2) {
      dragRef.current = null
      const [first, second] = Array.from(pointersRef.current.values())
      const rect = event.currentTarget.getBoundingClientRect()
      pinchRef.current = {
        distance: Math.max(1, Math.hypot(first.x - second.x, first.y - second.y)),
        scale: view.scale,
        midX: (first.x + second.x) / 2 - rect.left,
        midY: (first.y + second.y) / 2 - rect.top,
        viewX: view.x,
        viewY: view.y,
      }
    }
  }, [failed, natural, view])

  const handlePointerMove = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    if (!pointersRef.current.has(event.pointerId)) return
    pointersRef.current.set(event.pointerId, { x: event.clientX, y: event.clientY })

    if (pointersRef.current.size >= 2 && pinchRef.current) {
      const [first, second] = Array.from(pointersRef.current.values())
      const pinch = pinchRef.current
      const distance = Math.max(1, Math.hypot(first.x - second.x, first.y - second.y))
      const next = clamp(pinch.scale * (distance / pinch.distance), minScale, MAX_SCALE)
      const ratio = next / pinch.scale
      adjustedRef.current = true
      setView(constrainView({
        scale: next,
        x: pinch.midX - (pinch.midX - pinch.viewX) * ratio,
        y: pinch.midY - (pinch.midY - pinch.viewY) * ratio,
      }))
      return
    }

    const drag = dragRef.current
    if (!drag) return
    adjustedRef.current = true
    setView((prev) => constrainView({
      ...prev,
      x: drag.viewX + (event.clientX - drag.startX),
      y: drag.viewY + (event.clientY - drag.startY),
    }))
  }, [minScale, constrainView])

  const endPointer = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    pointersRef.current.delete(event.pointerId)
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }
    if (pointersRef.current.size === 0) {
      dragRef.current = null
      pinchRef.current = null
      setDragging(false)
      return
    }
    if (pointersRef.current.size === 1) {
      // 双指结束后单指继续拖拽：以当前视角重新起算
      pinchRef.current = null
      const [remaining] = Array.from(pointersRef.current.values())
      dragRef.current = {
        startX: remaining.x,
        startY: remaining.y,
        viewX: viewRef.current.x,
        viewY: viewRef.current.y,
      }
    }
  }, [])

  const zoomPercent = Math.round(view.scale * 100)

  return (
    <div
      ref={viewportRef}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={endPointer}
      onPointerCancel={endPointer}
      onDoubleClick={handleDoubleClick}
      style={{
        position: 'relative',
        height: '100%',
        width: '100%',
        overflow: 'hidden',
        background: token.colorBgLayout,
        touchAction: 'none',
        cursor: failed || !natural ? 'default' : dragging ? 'grabbing' : 'grab',
        userSelect: 'none',
      }}
    >
      {!failed && (
        <img
          key={`${fileUrl}#${attempt}`}
          src={fileUrl}
          alt={fileName || ''}
          draggable={false}
          onLoad={(event) => {
            setNatural({
              width: event.currentTarget.naturalWidth,
              height: event.currentTarget.naturalHeight,
            })
          }}
          onError={() => setFailed(true)}
          style={{
            position: 'absolute',
            top: 0,
            left: 0,
            width: natural ? natural.width : undefined,
            height: natural ? natural.height : undefined,
            maxWidth: 'none',
            opacity: natural ? 1 : 0,
            transform: `translate3d(${view.x}px, ${view.y}px, 0) scale(${view.scale})`,
            transformOrigin: '0 0',
            imageRendering: 'auto',
            pointerEvents: 'none',
          }}
        />
      )}

      {!natural && !failed && (
        <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <Spin size="large" />
        </div>
      )}

      {failed && (
        <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24 }}>
          <Result
            status="warning"
            title={t('workbench.imageLoadFailed')}
            extra={[
              <Button key="retry" icon={<ReloadOutlined />} onClick={() => { setFailed(false); setNatural(null); setAttempt((value) => value + 1) }}>
                {t('workbench.codeRetry')}
              </Button>,
              onOpenWithSystem && (
                <Button key="system" type="primary" onClick={onOpenWithSystem}>
                  {t('workbench.openWithSystem')}
                </Button>
              ),
            ]}
          />
        </div>
      )}

      {natural && !failed && (
        <div
          onPointerDown={(event) => event.stopPropagation()}
          onDoubleClick={(event) => event.stopPropagation()}
          style={{
            position: 'absolute',
            top: 10,
            left: '50%',
            transform: 'translateX(-50%)',
            zIndex: 10,
            display: 'flex',
            alignItems: 'center',
            gap: 2,
            padding: '2px 4px',
            borderRadius: 9,
            background: token.colorBgElevated,
            border: `1px solid ${token.colorBorderSecondary}`,
            boxShadow: token.boxShadowSecondary,
          }}
        >
          <Tooltip title={t('workbench.imageZoomOut')}>
            <Button
              type="text"
              size="small"
              icon={<ZoomOutOutlined style={{ fontSize: 13 }} />}
              onClick={() => zoomBy(1 / 1.25)}
              style={{ width: 24, height: 24, minWidth: 24, color: token.colorTextSecondary }}
            />
          </Tooltip>
          <Tooltip title={t('workbench.imageFit')}>
            <div
              onClick={() => { adjustedRef.current = false; applyFit() }}
              style={{
                minWidth: 44,
                textAlign: 'center',
                fontSize: 11,
                fontVariantNumeric: 'tabular-nums',
                color: token.colorTextSecondary,
                cursor: 'pointer',
                padding: '0 2px',
              }}
            >
              {zoomPercent}%
            </div>
          </Tooltip>
          <Tooltip title={t('workbench.imageZoomIn')}>
            <Button
              type="text"
              size="small"
              icon={<ZoomInOutlined style={{ fontSize: 13 }} />}
              onClick={() => zoomBy(1.25)}
              style={{ width: 24, height: 24, minWidth: 24, color: token.colorTextSecondary }}
            />
          </Tooltip>
          <div style={{ width: 1, height: 14, background: token.colorSplit, margin: '0 2px' }} />
          <Tooltip title={t('workbench.imageFit')}>
            <Button
              type="text"
              size="small"
              icon={<ExpandOutlined style={{ fontSize: 13 }} />}
              onClick={() => { adjustedRef.current = false; applyFit() }}
              style={{ width: 24, height: 24, minWidth: 24, color: token.colorTextSecondary }}
            />
          </Tooltip>
          <Tooltip title={t('workbench.imageActualSize')}>
            <Button
              type="text"
              size="small"
              icon={<OneToOneOutlined style={{ fontSize: 13 }} />}
              onClick={() => zoomBy(1 / view.scale)}
              style={{ width: 24, height: 24, minWidth: 24, color: token.colorTextSecondary }}
            />
          </Tooltip>
        </div>
      )}
    </div>
  )
}

export default ImagePreview
