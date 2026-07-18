import { useEffect, useState } from 'react'
import { Button, Tooltip, theme } from 'antd'
import {
  MinusOutlined,
  BorderOutlined,
  BlockOutlined,
  CloseOutlined,
  SunOutlined,
  MoonOutlined,
} from '@ant-design/icons'
import { useTranslation } from 'react-i18next'
import { useAppearanceStore } from '../../stores/appearance.store'

/**
 * 自定义窗口标题栏：
 * - 左侧可拖拽区域（WebkitAppRegion: drag）
 * - 右侧窗口控制按钮 + 明暗主题切换（no-drag 区域）
 * - 双击标题栏切换最大化
 */
const TitleBar: React.FC = () => {
  const { t } = useTranslation()
  const { token } = theme.useToken()
  const [isMaximized, setIsMaximized] = useState(false)

  const themeMode = useAppearanceStore((s) => s.themeMode)
  const setThemeMode = useAppearanceStore((s) => s.setThemeMode)
  const isDark = themeMode === 'dark'

  useEffect(() => {
    // 初始查询最大化状态
    window.electronAPI.window.isMaximized().then(setIsMaximized)
    // 订阅最大化状态变化
    const dispose = window.electronAPI.window.onMaximizedChange(setIsMaximized)
    return () => { dispose() }
  }, [])

  const handleToggleMaximize = async () => {
    const next = await window.electronAPI.window.toggleMaximize()
    setIsMaximized(next)
  }

  const toggleTheme = () => {
    setThemeMode(isDark ? 'light' : 'dark')
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

      {/* 右侧：主题切换 + 窗口控制（no-drag 区域）*/}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          height: '100%',
          ...({ WebkitAppRegion: 'no-drag' } as React.CSSProperties),
        }}
      >
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
