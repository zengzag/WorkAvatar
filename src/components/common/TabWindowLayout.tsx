import { useEffect, useState } from 'react'
import { Button, Tooltip, theme, App } from 'antd'
import {
  MinusOutlined,
  BorderOutlined,
  BlockOutlined,
  CloseOutlined,
  SunOutlined,
  MoonOutlined,
  ArrowLeftOutlined,
} from '@ant-design/icons'
import { useTranslation } from 'react-i18next'
import { useLocation, Outlet } from 'react-router-dom'
import { useAppearanceStore } from '../../stores/appearance.store'
import { useNotesStore } from '../../stores/notes.store'

/**
 * Tab 独立窗口壳：
 * - 顶部紧凑 TitleBar：左 = tab 名称 + 回到主窗口按钮；右 = 主题切换 + 窗口控制
 * - 主体渲染对应 tab 页面（通过 Outlet / 路由匹配）
 * - 关闭按钮：notes tab 有未保存内容时弹确认框，其他 tab 直接关闭
 * - 关闭独立窗口 = 自动回归主窗口（主进程 TabWindowService 处理）
 */
const TabWindowLayout: React.FC = () => {
  const { t } = useTranslation()
  const { token } = theme.useToken()
  const { modal } = App.useApp()
  const location = useLocation()

  const themeMode = useAppearanceStore((s) => s.themeMode)
  const setThemeMode = useAppearanceStore((s) => s.setThemeMode)
  const isDark = themeMode === 'dark'

  const [isMaximized, setIsMaximized] = useState(false)
  // 当前窗口所属 tabKey（从主进程查询；主窗口渲染进程不会渲染此组件）
  const [ownTab, setOwnTab] = useState<string | null>(null)

  // 直接订阅 notes store 的 tabs（仅在 notes 独立窗口用于脏状态检查）
  const notesTabs = useNotesStore((s) => s.tabs)

  useEffect(() => {
    window.electronAPI.window.isMaximized().then(setIsMaximized)
    const dispose = window.electronAPI.window.onMaximizedChange(setIsMaximized)
    window.electronAPI.tabWindow.getOwnTab().then((tab) => setOwnTab(tab))
    return () => { dispose() }
  }, [])

  const handleToggleMaximize = async () => {
    const next = await window.electronAPI.window.toggleMaximize()
    setIsMaximized(next)
  }

  const toggleTheme = () => {
    setThemeMode(isDark ? 'light' : 'dark')
  }

  /** 关闭窗口：notes 有未保存内容时弹确认框 */
  const handleClose = () => {
    if (ownTab === 'notes') {
      // 检查 notes 是否有脏 tab
      const hasDirty = notesTabs.some((tab) => tab.saveStatus === 'dirty')
      if (hasDirty) {
        modal.confirm({
          title: t('tabWindow.unsavedTitle'),
          content: t('tabWindow.unsavedContent'),
          okText: t('tabWindow.closeAnyway'),
          cancelText: t('common.cancel'),
          okButtonProps: { danger: true },
          onOk: () => window.electronAPI.window.close(),
        })
        return
      }
    }
    window.electronAPI.window.close()
  }

  /** 回到主窗口：关闭独立窗口，主进程会通知主窗口解锁 tab */
  const handleReturnToMain = () => {
    if (ownTab) {
      // 先通知主窗口切换到该 tab，再关闭独立窗口
      window.electronAPI.tabWindow.returnToMain(ownTab)
    }
  }

  // 从 location 解析 tabKey（fallback：用 ownTab）
  const tabKeyFromUrl = location.pathname.match(/^\/window\/([a-z]+)/)?.[1]
  const currentTab = tabKeyFromUrl || ownTab || ''

  // tab 标题映射
  const tabTitle = t(`nav.${currentTab}` as any, { defaultValue: 'WorkAvatar' })

  // 同步到 OS 原生窗口标题（任务栏/Alt-Tab 缩略图），跟随 i18n 语言切换
  useEffect(() => {
    document.title = tabTitle
  }, [tabTitle])

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
    <div style={{ height: '100vh', display: 'flex', flexDirection: 'column' }}>
      <div
        style={dragStyle}
        onDoubleClick={handleToggleMaximize}
      >
        {/* 左侧：回到主窗口按钮 + 当前 tab 名称 */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            paddingLeft: 8,
            fontSize: 12,
            color: token.colorTextSecondary,
            fontWeight: 500,
            ...({ WebkitAppRegion: 'no-drag' } as React.CSSProperties),
          }}
        >
          <Tooltip title={t('tabWindow.returnToMain')} placement="bottom">
            <Button
              type="text"
              size="small"
              icon={<ArrowLeftOutlined />}
              onClick={handleReturnToMain}
              style={{ padding: '2px 6px' }}
            />
          </Tooltip>
          <span>{tabTitle}</span>
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
            onClick={handleClose}
            style={{ ...btnStyle, borderRadius: 0 }}
            className="tabwindow-close-btn"
          />
        </div>

        <style>{`
          .tabwindow-close-btn:hover {
            background: #e81123 !important;
            color: #fff !important;
          }
        `}</style>
      </div>

      {/* 主体内容 */}
      <div style={{ flex: 1, minHeight: 0, overflow: 'hidden' }}>
        <Outlet />
      </div>
    </div>
  )
}

export default TabWindowLayout
