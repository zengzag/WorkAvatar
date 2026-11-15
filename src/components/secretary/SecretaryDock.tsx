import { ExclamationCircleOutlined, LoadingOutlined, RightOutlined } from '@ant-design/icons'
import { theme } from 'antd'
import type { SecretaryDockEdge } from '../../../electron/shared/channels/secretary'
import {
  SECRETARY_DOCK_ISLAND_HEIGHT,
  SECRETARY_DOCK_ISLAND_WIDTH,
  SECRETARY_DOCK_STRIP_LENGTH,
  SECRETARY_DOCK_STRIP_THICKNESS,
} from '../../../electron/shared/channels/secretary'

interface Props {
  edge: SecretaryDockEdge
  expanded: boolean
  pressed: boolean
  /** 与挂件一致的状态名：idle / running / done / error / confirm */
  statusClass: string
  title: string
  opacity: number
  unreadCount: number
  rootRef: React.RefObject<HTMLDivElement | null>
  onPointerDown: React.PointerEventHandler<HTMLDivElement>
  onPointerMove: React.PointerEventHandler<HTMLDivElement>
  onPointerUp: React.PointerEventHandler<HTMLDivElement>
  onPointerCancel: React.PointerEventHandler<HTMLDivElement>
  onContextMenu: React.MouseEventHandler<HTMLDivElement>
}

/** 状态色：等待确认 / 失败 / 完成优先于默认主色 */
function dockAccent(statusClass: string, primary: string, warning: string, error: string, success: string): string {
  if (statusClass === 'confirm') return warning
  if (statusClass === 'error') return error
  if (statusClass === 'done') return success
  return primary
}

/**
 * 贴边模式：贴边条收起时是一条贴边的细条，悬停 / 有新提醒时展开为「灵动岛」卡片。
 * 尺寸常量与主进程命中区共用（electron/shared/channels/secretary.ts）。
 */
const SecretaryDock: React.FC<Props> = ({
  edge, expanded, pressed, statusClass, title, opacity, unreadCount, rootRef,
  onPointerDown, onPointerMove, onPointerUp, onPointerCancel, onContextMenu,
}) => {
  const { token } = theme.useToken()
  const horizontalEdge = edge === 'left' || edge === 'right'
  const accentColor = dockAccent(statusClass, token.colorPrimary, token.colorWarning, token.colorError, token.colorSuccess)
  const width = expanded
    ? SECRETARY_DOCK_ISLAND_WIDTH
    : horizontalEdge ? SECRETARY_DOCK_STRIP_THICKNESS : SECRETARY_DOCK_STRIP_LENGTH
  const height = expanded
    ? SECRETARY_DOCK_ISLAND_HEIGHT
    : horizontalEdge ? SECRETARY_DOCK_STRIP_LENGTH : SECRETARY_DOCK_STRIP_THICKNESS

  return (
    <div
      ref={rootRef}
      className={[
        'dock-anchor',
        expanded ? 'is-expanded' : '',
        pressed ? 'is-pressed' : '',
        statusClass === 'running' ? 'is-running' : '',
        statusClass === 'confirm' ? 'is-confirm' : '',
      ].filter(Boolean).join(' ')}
      data-edge={edge}
      style={{
        width,
        height,
        opacity,
        color: token.colorText,
        ['--dock-accent' as any]: accentColor,
        ['--dock-surface' as any]: token.colorBgElevated,
        ['--dock-border' as any]: token.colorBorder,
      }}
      role="button"
      aria-label={title}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerCancel}
      onContextMenu={onContextMenu}
    >
      {/* 收起态：贴边细条 + 状态灯，展开时淡出 */}
      <span className="dock-strip" aria-hidden="true">
        <span className="dock-strip-handle" />
        {unreadCount > 0 && <span className="dock-strip-dot" style={{ background: token.colorError }} />}
      </span>

      {/* 展开态：灵动岛卡片（固定内部尺寸，避免根元素缩放时文字重排跳动） */}
      <span
        className="dock-island"
        style={{ width: SECRETARY_DOCK_ISLAND_WIDTH, height: SECRETARY_DOCK_ISLAND_HEIGHT }}
      >
        <span className="dock-text">
          <span className="dock-title">{title}</span>
        </span>
        <span className="dock-trailing">
          {statusClass === 'running' && <LoadingOutlined spin style={{ color: accentColor, fontSize: 13 }} />}
          {statusClass === 'confirm' && <ExclamationCircleOutlined style={{ color: accentColor, fontSize: 13 }} />}
          {unreadCount > 0 && (
            <span className="dock-count" style={{ background: token.colorError }}>
              {unreadCount > 99 ? '99+' : unreadCount}
            </span>
          )}
          {unreadCount === 0 && statusClass !== 'running' && statusClass !== 'confirm' && (
            <RightOutlined style={{ fontSize: 10, opacity: .38 }} />
          )}
        </span>
      </span>
    </div>
  )
}

export default SecretaryDock
