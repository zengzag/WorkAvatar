// 左侧图标栏：在“数据模型”与“AI 对话”视图间切换（参考 DataModelViewer 布局）

import { Tooltip } from 'antd'
import { ApartmentOutlined, MessageOutlined } from '@ant-design/icons'
import { hostT } from './store'

export type SidebarView = 'explorer' | 'chat'

interface Props {
  active: SidebarView
  onChange: (view: SidebarView) => void
}

const items: { id: SidebarView; icon: React.ReactNode; label: string }[] = [
  { id: 'explorer', icon: <ApartmentOutlined />, label: hostT('explorer.title') },
  { id: 'chat', icon: <MessageOutlined />, label: hostT('page.chat') }
]

export function AppSidebar({ active, onChange }: Props) {
  return (
    <div
      style={{
        width: 44, flexShrink: 0, display: 'flex', flexDirection: 'column',
        alignItems: 'center', gap: 4, padding: '8px 0',
        borderRight: '1px solid var(--dm-border)', background: 'var(--dm-bg)'
      }}
    >
      {items.map((item) => {
        const isActive = active === item.id
        return (
          <Tooltip key={item.id} title={item.label} placement="right">
            <button
              type="button"
              onClick={() => onChange(item.id)}
              title={item.label}
              style={{
                width: 32, height: 32, display: 'flex', alignItems: 'center', justifyContent: 'center',
                borderRadius: 6, cursor: 'pointer', border: 'none', fontSize: 15,
                color: isActive ? 'var(--dm-primary)' : 'var(--dm-muted)',
                background: isActive ? 'var(--dm-primary-soft)' : 'transparent',
                transition: 'background 0.2s, color 0.2s'
              }}
              onMouseEnter={(e) => { if (!isActive) e.currentTarget.style.background = 'var(--dm-hover)' }}
              onMouseLeave={(e) => { if (!isActive) e.currentTarget.style.background = 'transparent' }}
            >
              {item.icon}
            </button>
          </Tooltip>
        )
      })}
    </div>
  )
}
