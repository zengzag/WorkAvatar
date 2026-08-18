import React, { ReactNode } from 'react'
import { Typography } from 'antd'

const { Text } = Typography

export interface SettingsItemProps {
  title: ReactNode
  description?: ReactNode
  extra?: ReactNode
  children?: ReactNode
  align?: 'center' | 'start'
  style?: React.CSSProperties
}

/** 设置项（由宿主 src/components/common/SettingsItem 迁入） */
const SettingsItem: React.FC<SettingsItemProps> = ({
  title,
  description,
  extra,
  children,
  align = 'center',
  style,
}) => {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12, ...style }}>
      <div style={{
        display: 'flex',
        alignItems: align === 'start' ? 'flex-start' : 'center',
        justifyContent: 'space-between',
        gap: 12,
      }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <Text strong style={{ display: 'block' }}>{title}</Text>
          {description && (
            <Text type="secondary" style={{ fontSize: 12 }}>{description}</Text>
          )}
        </div>
        {extra && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
            {extra}
          </div>
        )}
      </div>
      {children}
    </div>
  )
}

export default SettingsItem