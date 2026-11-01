import React, { useMemo } from 'react'
import { Switch, Button, Space, Typography, Tooltip, theme, Tag } from 'antd'
import {
  ArrowUpOutlined, ArrowDownOutlined, UndoOutlined, LockOutlined, AppstoreOutlined,
  MessageOutlined, TeamOutlined, SearchOutlined, SettingOutlined,
} from '@ant-design/icons'
import { useTranslation } from 'react-i18next'
import {
  useNavConfigStore, LOCKED_KEYS, DEFAULT_NAV_CONFIG, type NavItemKey,
} from '../../stores/nav.store'

const ICON_MAP: Record<string, React.ReactNode> = {
  'tasks': <MessageOutlined />,
  'employees': <TeamOutlined />,
  'kms': <SearchOutlined />,
  'settings': <SettingOutlined />,
}

const LABEL_KEY_MAP: Record<string, string> = {
  'tasks': 'nav.tasks',
  'employees': 'nav.employees',
  'kms': 'nav.kms',
  'settings': 'nav.settings',
}

const NavSettings: React.FC = () => {
  const { t } = useTranslation()
  const { token } = theme.useToken()
  const config = useNavConfigStore((s) => s.config)
  const pluginItems = useNavConfigStore((s) => s.pluginItems)
  const toggleVisible = useNavConfigStore((s) => s.toggleVisible)
  const moveUp = useNavConfigStore((s) => s.moveUp)
  const moveDown = useNavConfigStore((s) => s.moveDown)
  const reset = useNavConfigStore((s) => s.reset)

  const sortedConfig = useMemo(
    () => config
      // 停用插件保留的排序条目（不在当前插件列表中）不展示，避免出现无文案的空行
      .filter((c) => DEFAULT_NAV_CONFIG.some((d) => d.key === c.key) || pluginItems.some((p) => p.key === c.key))
      .slice()
      .sort((a, b) => a.order - b.order),
    [config, pluginItems],
  )

  const isPluginKey = (key: string) => pluginItems.some((p) => p.key === key)
  const firstPluginIndex = sortedConfig.findIndex((c) => isPluginKey(c.key))

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
          borderBottom: `1px solid ${token.colorBorder}`,
          borderRadius: 8,
          overflow: 'hidden',
        }}
      >
        {sortedConfig.map((item, idx) => {
          const isPlugin = isPluginKey(item.key)
          const isLocked = !isPlugin && LOCKED_KEYS.includes(item.key as NavItemKey)
          const isLast = idx === sortedConfig.length - 1
          const prevItem = sortedConfig[idx - 1]
          const nextItem = sortedConfig[idx + 1]
          // 内置项与插件项之间不允许交叉排序
          const canMoveUp = !isLocked && !!prevItem && isPluginKey(prevItem.key) === isPlugin
          const canMoveDown = !isLocked && !!nextItem && isPluginKey(nextItem.key) === isPlugin
          const isFirstPlugin = isPlugin && idx === firstPluginIndex
          return (
            <React.Fragment key={item.key}>
            {isFirstPlugin && (
              <div style={{ height: 1, background: token.colorBorderSecondary }} />
            )}
            <div
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
                  {ICON_MAP[item.key] || <AppstoreOutlined />}
                </span>
                <Typography.Text style={{ fontSize: 13 }}>
                  {isPlugin ? t(pluginItems.find((p) => p.key === item.key)?.label ?? '', { ns: item.key }) : t(LABEL_KEY_MAP[item.key])}
                </Typography.Text>
                {isLocked && (
                  <Tooltip title={t('settings.navLockedHint')}>
                    <Tag icon={<LockOutlined />} style={{ marginInlineEnd: 0, fontSize: 11 }}>
                      {t('settings.navLocked')}
                    </Tag>
                  </Tooltip>
                )}
                {isPlugin && (
                  <Tag style={{ marginInlineEnd: 0, fontSize: 11 }} color="blue">{t('settings.navPlugin')}</Tag>
                )}
                {!item.visible && (
                  <Tag style={{ marginInlineEnd: 0, fontSize: 11 }}>{t('settings.navHidden')}</Tag>
                )}
              </Space>
              <Space size={8}>
                <Tooltip title={canMoveUp ? t('settings.navMoveUp') : t('settings.navCannotMoveUp')}>
                  <Button
                    size="small"
                    type="text"
                    icon={<ArrowUpOutlined />}
                    disabled={!canMoveUp}
                    onClick={() => moveUp(item.key)}
                  />
                </Tooltip>
                <Tooltip title={canMoveDown ? t('settings.navMoveDown') : t('settings.navCannotMoveDown')}>
                  <Button
                    size="small"
                    type="text"
                    icon={<ArrowDownOutlined />}
                    disabled={!canMoveDown}
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
            </React.Fragment>
          )
        })}
      </div>
    </div>
  )
}

export default React.memo(NavSettings)
