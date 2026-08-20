// 画布右键菜单

import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { hostT } from '../store'

export type ContextMenuState =
  | { type: 'pane'; x: number; y: number }
  | { type: 'node'; x: number; y: number; nodeId: string }
  | { type: 'edge'; x: number; y: number; edgeId: string }

interface MenuItem {
  key: string
  label: string
  danger?: boolean
  onClick: () => void
}

interface Props {
  state: ContextMenuState | null
  items: MenuItem[]
  onClose: () => void
}

export function CanvasContextMenu({ state, items, onClose }: Props) {
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState({ x: 0, y: 0 })

  useLayoutEffect(() => {
    if (!state || !ref.current) return
    const rect = ref.current.getBoundingClientRect()
    const vw = window.innerWidth
    const vh = window.innerHeight
    let x = state.x
    let y = state.y
    if (x + rect.width > vw) x = vw - rect.width - 8
    if (y + rect.height > vh) y = vh - rect.height - 8
    setPos({ x, y })
  }, [state])

  useEffect(() => {
    if (!state) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    const onClick = () => onClose()
    window.addEventListener('keydown', onKey)
    window.addEventListener('click', onClick)
    return () => {
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('click', onClick)
    }
  }, [state, onClose])

  if (!state) return null

  return (
    <div
      ref={ref}
      style={{
        position: 'fixed', left: pos.x, top: pos.y, zIndex: 1000, minWidth: 160,
        background: 'var(--dm-bg)', border: '1px solid var(--dm-border-strong)', borderRadius: 8,
        boxShadow: '0 4px 16px rgba(0,0,0,0.15)', padding: 4
      }}
      onClick={(e) => e.stopPropagation()}
    >
      {items.map((item) => (
        <div
          key={item.key}
          onClick={(e) => { e.stopPropagation(); item.onClick(); onClose() }}
          style={{
            padding: '6px 12px', borderRadius: 6, cursor: 'pointer', fontSize: 13,
            color: item.danger ? '#ef4444' : 'var(--dm-text)'
          }}
          onMouseEnter={(e) => (e.currentTarget.style.background = 'var(--dm-hover)')}
          onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
        >
          {item.label}
        </div>
      ))}
    </div>
  )
}

export function buildPaneItems(onNewTable: () => void, onLayout: () => void): MenuItem[] {
  return [
    { key: 'new-table', label: hostT('page.newTable'), onClick: onNewTable },
    { key: 'layout', label: hostT('page.autoLayout'), onClick: onLayout }
  ]
}
