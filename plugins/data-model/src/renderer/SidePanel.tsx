// 左侧面板容器：根据视图切换渲染“数据模型”或“AI 对话”，支持展开/收起与宽度拖拽

import { useRef } from 'react'
import { Button, Segmented, Tooltip } from 'antd'
import { LeftOutlined } from '@ant-design/icons'
import { ExplorerPanel } from './ExplorerPanel'
import { ChatPanel } from './chat/ChatPanel'
import { hostT } from './store'

export type SidebarView = 'explorer' | 'chat'

interface Props {
  view: SidebarView
  collapsed: boolean
  width: number
  onViewChange: (view: SidebarView) => void
  onToggleCollapsed: () => void
  onWidthChange: (width: number) => void
}

const MIN_WIDTH = 240
const MAX_WIDTH = 560

export function SidePanel({ view, collapsed, width, onViewChange, onToggleCollapsed, onWidthChange }: Props) {
  const resizeRef = useRef<{ startX: number; startWidth: number } | null>(null)

  const startResize = (e: React.MouseEvent) => {
    e.preventDefault()
    resizeRef.current = { startX: e.clientX, startWidth: width }
    const onMove = (ev: MouseEvent) => {
      if (!resizeRef.current) return
      const delta = ev.clientX - resizeRef.current.startX
      const next = Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, resizeRef.current.startWidth + delta))
      onWidthChange(next)
    }
    const onUp = () => {
      resizeRef.current = null
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }

  // 折叠态：窄条，点击展开
  if (collapsed) {
    return (
      <div
        onClick={onToggleCollapsed}
        title={view === 'chat' ? hostT('page.chat') : hostT('explorer.title')}
        style={{
          width: 28, borderRight: '1px solid var(--dm-border)', cursor: 'pointer',
          display: 'flex', flexDirection: 'column', alignItems: 'center',
          paddingTop: 12, gap: 8, background: 'var(--dm-bg)', flexShrink: 0
        }}
      >
        <span style={{ writingMode: 'vertical-rl', fontSize: 12, color: 'var(--dm-muted)', fontWeight: 600, letterSpacing: 2 }}>
          {view === 'chat' ? hostT('page.chat') : hostT('explorer.title')}
        </span>
      </div>
    )
  }

  return (
    <div style={{ display: 'flex', minHeight: 0, flexShrink: 0 }}>
      <div
        style={{
          width, borderRight: '1px solid var(--dm-border)', background: 'var(--dm-bg)',
          display: 'flex', flexDirection: 'column', minHeight: 0
        }}
      >
        {/* 面板头部：视图切换 + 收起按钮（同一行） */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 4, padding: '4px 8px', borderBottom: '1px solid var(--dm-border)' }}>
          <Segmented
            size="small"
            value={view}
            onChange={(v) => onViewChange(v as SidebarView)}
            options={[
              { value: 'explorer', label: hostT('explorer.title') },
              { value: 'chat', label: hostT('page.chat') }
            ]}
          />
          <div style={{ flex: 1 }} />
          <Tooltip title={hostT('page.collapsePanel')}>
            <Button size="small" type="text" icon={<LeftOutlined />} onClick={onToggleCollapsed} />
          </Tooltip>
        </div>
        <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
          {view === 'chat' ? <ChatPanel /> : <ExplorerPanel />}
        </div>
      </div>
      {/* 拖拽调整宽度手柄 */}
      <div
        onMouseDown={startResize}
        style={{
          width: 5, cursor: 'col-resize', flexShrink: 0,
          borderRight: '1px solid var(--dm-border)',
          background: 'transparent', transition: 'background 0.2s'
        }}
        onMouseEnter={(e) => (e.currentTarget.style.background = 'var(--dm-primary-soft)')}
        onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
      />
    </div>
  )
}
