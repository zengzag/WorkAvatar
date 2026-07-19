import React, { useMemo } from 'react'
import { Switch, Button, Space, Typography, Tooltip, theme, Tag } from 'antd'
import {
  ArrowUpOutlined, ArrowDownOutlined, UndoOutlined, LockOutlined,
  RobotOutlined, SearchOutlined, AudioOutlined, CalendarOutlined, FieldTimeOutlined, SettingOutlined,
} from '@ant-design/icons'
import { useTranslation } from 'react-i18next'
import {
  useNavConfigStore, LOCKED_KEYS, type NavItemKey,
} from '../../stores/nav.store'

const ICON_MAP: Record<NavItemKey, React.ReactNode> = {
  'digital-employees': <RobotOutlined />,
  'kms': <SearchOutlined />,
  'voice': <AudioOutlined />,
  'calendar': <CalendarOutlined />,
  'automation': <FieldTimeOutlined />,
  'settings': <SettingOutlined />,
}

const LABEL_KEY_MAP: Record<NavItemKey, string> = {
  'digital-employees': 'nav.digitalEmployees',
  'kms': 'nav.kms',
  'voice': 'nav.voice',
  'calendar': 'nav.calendar',
  'automation': 'nav.automation',
  'settings': 'nav.settings',
}

const NavSettings: React.FC = () => {
  const { t } = useTranslation()
  const { token } = theme.useToken()
  const config = useNavConfigStore((s) => s.config)
  const toggleVisible = useNavConfigStore((s) => s.toggleVisible)
  const moveUp = useNavConfigStore((s) => s.moveUp)
  const moveDown = useNavConfigStore((s) => s.moveDown)
  const reset = useNavConfigStore((s) => s.reset)

  const sortedConfig = useMemo(
    () => config.slice().sort((a, b) => a.order - b.order),
    [config],
  )

  return (
    <div>
      <div style={{ marginBottom: 12, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          {t('settings.navHint')}
        </Typography.Text>
        <Button size="small" icon={<UndoOutlined />} onClick={reset}>
          {t('settings.navReset')}
        </Button>
      </div>
      <div
        style={{
          borderTop: `1px solid ${token.colorBorder}`,
          borderInline: `1px solid ${token.colorBorder}`,
          borderBottom: 'none',
          borderRadius: 8,
          overflow: 'hidden',
        }}
      >
        {sortedConfig.map((item, idx) => {
          const isLocked = LOCKED_KEYS.includes(item.key)
          const isFirst = idx === 0
          const isLast = idx === sortedConfig.length - 1
          return (
            <div
              key={item.key}
              style={{
                padding: '10px 14px',
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
                background: !item.visible ? token.colorFillQuaternary : 'transparent',
                borderBottom: isLast ? 'none' : `1px solid ${token.colorBorderSecondary}`,
              }}
            >
              <Space size={10}>
                <span style={{ color: token.colorTextSecondary, width: 20, textAlign: 'center' }}>
                  {ICON_MAP[item.key]}
                </span>
                <Typography.Text style={{ fontSize: 13 }}>
                  {t(LABEL_KEY_MAP[item.key])}
                </Typography.Text>
                {isLocked && (
                  <Tooltip title={t('settings.navLockedHint')}>
                    <Tag icon={<LockOutlined />} style={{ marginInlineEnd: 0, fontSize: 11 }}>
                      {t('settings.navLocked')}
                    </Tag>
                  </Tooltip>
                )}
                {!item.visible && (
                  <Tag style={{ marginInlineEnd: 0, fontSize: 11 }}>{t('settings.navHidden')}</Tag>
                )}
              </Space>
              <Space size={8}>
                <Tooltip title={isFirst ? t('settings.navCannotMoveUp') : t('settings.navMoveUp')}>
                  <Button
                    size="small"
                    type="text"
                    icon={<ArrowUpOutlined />}
                    disabled={isFirst}
                    onClick={() => moveUp(item.key)}
                  />
                </Tooltip>
                <Tooltip title={isLast ? t('settings.navCannotMoveDown') : t('settings.navMoveDown')}>
                  <Button
                    size="small"
                    type="text"
                    icon={<ArrowDownOutlined />}
                    disabled={isLast}
                    onClick={() => moveDown(item.key)}
                  />
                </Tooltip>
                <Switch
                  size="small"
                  checked={item.visible}
                  disabled={isLocked}
                  onChange={() => toggleVisible(item.key)}
                />
              </Space>
            </div>
          )
        })}
      </div>
    </div>
  )
}

export default React.memo(NavSettings)
