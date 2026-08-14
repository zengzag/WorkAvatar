import { useEffect, useState } from 'react'
import { Button, Tooltip, theme } from 'antd'
import {
  MinusOutlined,
  BorderOutlined,
  BlockOutlined,
  CloseOutlined,
  SunOutlined,
  MoonOutlined,
  ExpandAltOutlined,
} from '@ant-design/icons'
import { useTranslation } from 'react-i18next'
import { useLocation } from 'react-router-dom'
import { useAppearanceStore } from '../../stores/appearance.store'

/** 可分离为独立窗口的 tab key（与后端 DETACHABLE_TABS 对齐，排除 settings） */
const DETACHABLE_TABS = ['tasks', 'employees', 'kms', 'voice', 'calendar', 'notes', 'automation']

/**
 * 自定义窗口标题栏：
 * - 左侧可拖拽区域（WebkitAppRegion: drag）
 * - 右侧窗口控制按钮 + 分离当前 tab + 明暗主题切换（no-drag 区域）
 * - 双击标题栏切换最大化
 */
const TitleBar: React.FC = () => {
  const { t } = useTranslation()
  const { token } = theme.useToken()
  const location = useLocation()
  const [isMaximized, setIsMaximized] = useState(false)

  const themeMode = useAppearanceStore((s) => s.themeMode)
  const setThemeMode = useAppearanceStore((s) => s.setThemeMode)
  const isDark = themeMode === 'dark'

  // 当前已分离为独立窗口的 tab 列表
  const [detachedTabs, setDetachedTabs] = useState<string[]>([])

  useEffect(() => {
    window.electronAPI.window.isMaximized().then(setIsMaximized)
    const dispose = window.electronAPI.window.onMaximizedChange(setIsMaximized)
    window.electronAPI.tabWindow.list().then((tabs) => setDetachedTabs(tabs))
    const disposeDetach = window.electronAPI.tabWindow.onDetachedChanged((tabs) => setDetachedTabs(tabs))
    return () => { dispose(); disposeDetach() }
  }, [])

  // 从当前路由解析 tabKey（如 /tasks/xxx → tasks）
  const currentTabKey = (() => {
    const match = location.pathname.match(/^\/([a-z]+)/)
    return match?.[1] || ''
  })()

  const canDetach = DETACHABLE_TABS.includes(currentTabKey) && !detachedTabs.includes(currentTabKey)

  const handleToggleMaximize = async () => {
    const next = await window.electronAPI.window.toggleMaximize()
    setIsMaximized(next)
  }

  const toggleTheme = () => {
    setThemeMode(isDark ? 'light' : 'dark')
  }

  const handleDetach = async () => {
    if (canDetach) {
      await window.electronAPI.tabWindow.open(currentTabKey)
    }
  }

  const btnStyle: React.CSSProperties = {
    width: 28,
    height: 28,
    minWidth: 28,
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 0,
    border: 'none',
    background: 'transparent',
  }

  const dragStyle: React.CSSProperties = {
    height: 32,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    background: token.colorBgContainer,
    borderBottom: `1px solid ${token.colorBorderSecondary}`,
    flexShrink: 0,
    userSelect: 'none',
    ...({ WebkitAppRegion: 'drag' } as React.CSSProperties),
  }

  return (
    <div
      style={dragStyle}
      onDoubleClick={handleToggleMaximize}
    >
      {/* 左侧：应用名称 */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          paddingLeft: 12,
          fontSize: 12,
          color: token.colorTextSecondary,
          fontWeight: 500,
        }}
      >
        <span>WorkAvatar</span>
      </div>

      {/* 右侧：分离当前 tab + 主题切换 + 窗口控制（no-drag 区域）*/}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          height: '100%',
          ...({ WebkitAppRegion: 'no-drag' } as React.CSSProperties),
        }}
      >
        {canDetach && (
          <Tooltip title={t('tabWindow.detach')} placement="bottom">
            <Button
              type="text"
              size="small"
              icon={<ExpandAltOutlined />}
              onClick={handleDetach}
              style={btnStyle}
            />
          </Tooltip>
        )}
        <Tooltip title={isDark ? t('settings.light') : t('settings.dark')} placement="bottom">
          <Button
            type="text"
            size="small"
            icon={isDark ? <SunOutlined /> : <MoonOutlined />}
            onClick={toggleTheme}
            style={btnStyle}
          />
        </Tooltip>
        <Button
          type="text"
          size="small"
          icon={<MinusOutlined />}
          onClick={() => window.electronAPI.window.minimize()}
          style={btnStyle}
        />
        <Button
          type="text"
          size="small"
          icon={isMaximized ? <BlockOutlined /> : <BorderOutlined />}
          onClick={handleToggleMaximize}
          style={btnStyle}
        />
        <Button
          type="text"
          size="small"
          icon={<CloseOutlined />}
          onClick={() => window.electronAPI.window.close()}
          style={{ ...btnStyle, borderRadius: 0 }}
          className="titlebar-close-btn"
        />
      </div>

      <style>{`
        .titlebar-close-btn:hover {
          background: #e81123 !important;
          color: #fff !important;
        }
      `}</style>
    </div>
  )
}

export default TitleBar
