import { useMemo, useCallback, useEffect, useState } from 'react'
import { Layout, Menu, Dropdown, theme } from 'antd'
import type { MenuProps } from 'antd'
import {
  SettingOutlined,
  SearchOutlined,
  AudioOutlined,
  CalendarOutlined,
  FieldTimeOutlined,
  MessageOutlined,
  TeamOutlined,
  ArrowUpOutlined,
  ArrowDownOutlined,
  ExpandAltOutlined,
  HomeOutlined,
  AppstoreOutlined,
} from '@ant-design/icons'
import { useTranslation } from 'react-i18next'
import { useNavigate, useLocation } from 'react-router-dom'
import UnifiedInteractionModal from './components/common/UnifiedInteractionModal'
import KeepAliveOutlet from './components/common/KeepAliveOutlet'
import TitleBar from './components/common/TitleBar'
import { useAppearanceStore, getEffectiveTheme } from './stores/appearance.store'
import { useNavConfigStore, getVisibleNavItems, type NavItemKey } from './stores/nav.store'
import { getPluginNavIcon } from './plugins/loader'
import { useCalendarNotify, useCalendarNotifyClick } from './hooks/useCalendarNotify'
import { useVoiceRecordingStore } from './stores/voice-recording.store'

const { Sider, Content } = Layout

/** 语音导航图标：录音进行中时变色，提示后台语音识别运行中 */
const VoiceNavIcon: React.FC<{ recording: boolean; paused: boolean }> = ({ recording, paused }) => {
  if (!recording) return <AudioOutlined />
  return <AudioOutlined style={{ color: paused ? '#faad14' : '#ff4d4f' }} />
}

const App: React.FC = () => {
  const navigate = useNavigate()
  const location = useLocation()
  const { t } = useTranslation()
  const { token } = theme.useToken()
  const themeMode = useAppearanceStore((s) => s.themeMode)
  const effectiveTheme = getEffectiveTheme(themeMode)
  const isVoiceRecording = useVoiceRecordingStore((s) => s.isRecording)
  const isVoicePaused = useVoiceRecordingStore((s) => s.isPaused)

  // 当前已分离为独立窗口的 tab key 列表（主进程推送 + 主动查询）
  const [detachedTabs, setDetachedTabs] = useState<string[]>([])
  useEffect(() => {
    window.electronAPI.tabWindow.list().then((tabs) => setDetachedTabs(tabs))
    const dispose = window.electronAPI.tabWindow.onDetachedChanged((tabs) => setDetachedTabs(tabs))
    return () => { dispose() }
  }, [])

  // 监听系统右键"打开方式"或启动参数传入的 .md 文件：导航到笔记插件页
  // 文件消费由 notes 插件经 loader 的 subscribeExternalFiles 能力订阅，这里只负责路由/窗口
  useEffect(() => {
    const unsub = window.electronAPI.app.onOpenExternalFile((absPath) => {
      void absPath
      // 若笔记已分离为独立窗口，聚焦笔记窗口；否则在主窗口导航到笔记插件页
      if (detachedTabs.includes('notes')) {
        window.electronAPI.tabWindow.focus('notes')
      } else {
        navigate('/plugin/notes')
      }
    })
    return () => { unsub() }
  }, [navigate, detachedTabs])

  const getSelectedKey = useCallback((): string => {
    const path = location.pathname
    // 插件页：/plugin/<id>/... → 选中对应插件导航项
    if (path.startsWith('/plugin/')) return path.split('/')[2] || 'tasks'
    if (path.startsWith('/employees') || path === '/wizard') return 'employees'
    if (path === '/' || path.startsWith('/tasks')) return 'tasks'
    if (path.startsWith('/settings')) return 'settings'
    if (path.startsWith('/kms')) return 'kms'
    if (path.startsWith('/voice')) return 'voice'
    if (path.startsWith('/calendar')) return 'calendar'
    if (path.startsWith('/automation')) return 'automation'
    return 'tasks'
  }, [location.pathname])

  // 若主窗口当前路由对应的 tab 被分离了，自动跳转到第一个未分离的 tab（避免主窗口与独立窗口同时渲染同一 tab）
  useEffect(() => {
    const currentKey = getSelectedKey()
    if (!detachedTabs.includes(currentKey)) return
    // 按默认顺序找第一个未分离、可见的 tab（排除 settings，它不适合作为回退目标）
    const fallbackOrder: NavItemKey[] = ['tasks', 'calendar', 'automation', 'kms', 'voice', 'employees']
    const fallback = fallbackOrder.find((k) => !detachedTabs.includes(k))
    if (fallback) {
      navigate(`/${fallback}`)
    }
  }, [detachedTabs, navigate, getSelectedKey])

  /**
   * 通知点击跳转：按来源功能进入对应页面。
   * - automation：携带 conversationId+employeeId 时跳到 /tasks 并定位会话
   * - ask_user：不跳转，主窗口聚焦后 UnifiedInteractionModal 会自动弹出
   * - 其他（calendar/event/todo）：默认进日历页
   */
  const handleNotifyClick = useCallback((target?: string, id?: string) => {
    if (target === 'automation' && id) {
      try {
        const { conversationId, employeeId } = JSON.parse(id)
        if (employeeId && conversationId) {
          localStorage.setItem(`employeeWorkbench:activeConvId:${employeeId}`, conversationId)
          navigate('/tasks')
          return
        }
      } catch { /* ignore parse error */ }
    }
    if (target === 'ask_user') return
    navigate('/calendar')
  }, [navigate])

  // 全局监听日历/ask_user/自动化 通知：主窗口激活时由主进程推送，antd notification 显示
  useCalendarNotify((payload) => {
    handleNotifyClick(payload.clickTarget, payload.clickId)
  })
  // 系统通知点击后由主进程推送 → 按目标跳转
  useCalendarNotifyClick((payload) => {
    handleNotifyClick(payload.target, payload.id)
  })

  // 导航菜单配置（从 nav.store 读取显隐与排序）
  const navConfig = useNavConfigStore((s) => s.config)
  const pluginNavItems = useNavConfigStore((s) => s.pluginItems)
  const moveUp = useNavConfigStore((s) => s.moveUp)
  const moveDown = useNavConfigStore((s) => s.moveDown)

  // 已分离 tab 的图标用半透明 + 右上角小圆点标记，提示用户"已弹窗，点击聚焦"
  // label 保持纯文本，让 antd collapsed Menu 自动生成 tooltip
  const wrapDetachedIcon = (icon: React.ReactNode, detached: boolean): React.ReactNode => {
    if (!detached) return icon
    return (
      <span style={{ position: 'relative', display: 'inline-flex', opacity: 0.5 }}>
        {icon}
        <span
          style={{
            position: 'absolute',
            top: -2,
            right: -4,
            width: 6,
            height: 6,
            borderRadius: '50%',
            background: '#52c41a',
            border: '1px solid var(--ant-color-bg-container, #fff)',
          }}
        />
      </span>
    )
  }

  // 点击导航项：若该 tab 已分离为独立窗口，则聚焦独立窗口；否则在主窗口内导航
  const handleNavClick = useCallback((key: string) => {
    // 插件 tab 分离时记录的是原始插件 id（如 notes），点导航传入的是 plugin/notes
    const detachedId = key.startsWith('plugin/') ? key.slice('plugin/'.length) : key
    if (detachedTabs.includes(detachedId)) {
      window.electronAPI.tabWindow.focus(detachedId)
      return
    }
    // 内置页直接 /<key>，插件页挂 /plugin/<key> 命名空间
    navigate(key.includes('/') ? key : `/${key}`)
  }, [navigate, detachedTabs])

  // 所有导航项的定义（icon + label + onClick）；已分离的 tab 图标视觉降级
  // icon 外层包 data-nav-key，供侧边栏右键菜单识别目标 tab
  const navItemDefs = useMemo(() => {
    const build = (key: NavItemKey, icon: React.ReactNode, label: string) => ({
      icon: <span data-nav-key={key}>{wrapDetachedIcon(icon, detachedTabs.includes(key))}</span>,
      label,
      onClick: () => handleNavClick(key),
    })
    return {
      'tasks': build('tasks', <MessageOutlined />, t('nav.tasks')),
      'employees': build('employees', <TeamOutlined />, t('nav.employees')),
      'kms': build('kms', <SearchOutlined />, t('nav.kms')),
      'voice': build('voice', <VoiceNavIcon recording={isVoiceRecording} paused={isVoicePaused} />, isVoiceRecording ? t('nav.voiceRecording') : t('nav.voice')),
      'calendar': build('calendar', <CalendarOutlined />, t('nav.calendar')),
      'automation': build('automation', <FieldTimeOutlined />, t('nav.automation')),
      'settings': {
        icon: <span data-nav-key="settings"><SettingOutlined /></span>,
        label: t('nav.settings'),
        onClick: () => navigate('/settings'),
      },
    }
  }, [t, navigate, isVoiceRecording, isVoicePaused, handleNavClick, detachedTabs])

  // 按统一配置（config 已含插件项）的完整顺序构建菜单（内置 + 插件混合排序）
  const allMenuItems = useMemo<NonNullable<MenuProps['items']>>(() => {
    const visibleConfig = getVisibleNavItems(navConfig)
    const items: NonNullable<MenuProps['items']> = []
    for (const item of visibleConfig) {
      const def = navItemDefs[item.key as NavItemKey]
      if (def) {
        items.push({ key: item.key, ...def })
        continue
      }
      const plugin = pluginNavItems.find((p) => p.key === item.key)
      if (!plugin) continue
      const NavIconComp = getPluginNavIcon(plugin.key)
      const active = location.pathname.startsWith(`/plugin/${plugin.key}`)
      const baseIcon = NavIconComp
        ? <NavIconComp active={active} />
        : plugin.icon
          ? <span style={{ display: 'inline-flex', width: 16, height: 16 }} dangerouslySetInnerHTML={{ __html: plugin.icon }} />
          : <AppstoreOutlined />
      items.push({
        key: plugin.key,
        icon: <span data-nav-key={plugin.key}>{wrapDetachedIcon(baseIcon, detachedTabs.includes(plugin.key))}</span>,
        label: t(plugin.label, { ns: plugin.key }),
        onClick: () => handleNavClick(`plugin/${plugin.key}`),
      })
    }
    return items
  }, [navConfig, pluginNavItems, navItemDefs, t, location.pathname, handleNavClick, detachedTabs])

  // 分离 settings 到最底部，其余保持统一配置的排序
  const mainMenuItems = useMemo(
    () => allMenuItems.filter((item: any) => item.key !== 'settings'),
    [allMenuItems]
  )
  const settingsMenuItem = useMemo(() => allMenuItems.filter((item: any) => item.key === 'settings'), [allMenuItems])

  // 侧边栏右键菜单：独立窗口打开/回到主窗口 + 上移/下移 tab 顺序（含插件 tab）
  const [navContextMenu, setNavContextMenu] = useState<{ x: number; y: number; key: string } | null>(null)

  const handleNavContextMenu = useCallback((e: React.MouseEvent) => {
    const target = (e.target as HTMLElement).closest('[data-nav-key]') as HTMLElement | null
    const navKey = target?.getAttribute('data-nav-key')
    if (!navKey) return
    e.preventDefault()
    setNavContextMenu({ x: e.clientX, y: e.clientY, key: navKey })
  }, [])

  // 菜单打开时，任意点击/滚轮/再次右键都关闭菜单（trigger={[]} 受控模式下 Dropdown 不会自动关闭）
  useEffect(() => {
    if (!navContextMenu) return
    const close = () => setNavContextMenu(null)
    const opts = { capture: true } as AddEventListenerOptions
    document.addEventListener('click', close, opts)
    document.addEventListener('contextmenu', close, opts)
    document.addEventListener('wheel', close, opts)
    return () => {
      document.removeEventListener('click', close, opts)
      document.removeEventListener('contextmenu', close, opts)
      document.removeEventListener('wheel', close, opts)
    }
  }, [navContextMenu])

  // 排序后的可见 nav key（用于判断上移/下移是否可用，与 NavSettings 逻辑一致）
  const sortedVisibleKeys = useMemo(
    () => getVisibleNavItems(navConfig).map((c) => c.key),
    [navConfig],
  )

  const navContextItems = useMemo<MenuProps['items']>(() => {
    if (!navContextMenu) return []
    const key = navContextMenu.key
    const idx = sortedVisibleKeys.indexOf(key as NavItemKey)
    const isFirst = idx <= 0
    const isLast = idx < 0 || idx >= sortedVisibleKeys.length - 1
    const isDetached = detachedTabs.includes(key)
    // settings 不可分离（无独立窗口）
    const canDetach = key !== 'settings' && !isDetached
    const items: NonNullable<MenuProps['items']>[number][] = []
    if (canDetach) {
      items.push({
        key: 'detach',
        icon: <ExpandAltOutlined />,
        label: t('tabWindow.detach'),
        onClick: () => { window.electronAPI.tabWindow.open(key); setNavContextMenu(null) },
      })
    } else if (isDetached) {
      items.push({
        key: 'return',
        icon: <HomeOutlined />,
        label: t('tabWindow.returnToMain'),
        onClick: () => { window.electronAPI.tabWindow.focus(key); setNavContextMenu(null) },
      })
    }
    if (items.length > 0) items.push({ type: 'divider' })
    items.push({
      key: 'moveUp',
      icon: <ArrowUpOutlined />,
      label: t('tabWindow.moveUp'),
      disabled: isFirst,
      onClick: () => { moveUp(key as NavItemKey); setNavContextMenu(null) },
    })
    items.push({
      key: 'moveDown',
      icon: <ArrowDownOutlined />,
      label: t('tabWindow.moveDown'),
      disabled: isLast,
      onClick: () => { moveDown(key as NavItemKey); setNavContextMenu(null) },
    })
    return items
  }, [navContextMenu, sortedVisibleKeys, detachedTabs, t, moveUp, moveDown])

  const siderBg = effectiveTheme === 'dark' ? '#1a1a1a' : '#ffffff'

  return (
    <Layout style={{ height: '100vh', flexDirection: 'column' }}>
      <TitleBar />
      <Layout style={{ flex: 1, minHeight: 0 }}>
        <Sider
          theme={effectiveTheme === 'dark' ? 'dark' : 'light'}
          width={52}
          collapsedWidth={52}
          collapsed={true}
          collapsible={false}
          trigger={null}
          className="app-sider"
          style={{
            borderRight: `1px solid ${token.colorBorderSecondary}`,
            background: siderBg,
          }}
        >
          <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
            <Menu
              mode="inline"
              selectedKeys={[getSelectedKey()]}
              items={mainMenuItems}
              inlineCollapsed={true}
              onContextMenu={handleNavContextMenu}
              style={{
                borderRight: 'none',
                marginTop: 4,
                flex: 1,
                background: 'transparent',
              }}
              theme={effectiveTheme === 'dark' ? 'dark' : 'light'}
            />
            {settingsMenuItem.length > 0 && (
              <Menu
                mode="inline"
                selectedKeys={[getSelectedKey()]}
                items={settingsMenuItem}
                inlineCollapsed={true}
                onContextMenu={handleNavContextMenu}
                style={{
                  borderRight: 'none',
                  marginBottom: 10,
                  background: 'transparent',
                }}
                theme={effectiveTheme === 'dark' ? 'dark' : 'light'}
              />
            )}
          </div>
        </Sider>
        <Layout>
          <Content
            style={{
              overflow: 'hidden',
            }}
          >
            <KeepAliveOutlet clearKeys={detachedTabs} />
          </Content>
        </Layout>
      </Layout>
      <UnifiedInteractionModal />
      {/* 侧边栏右键菜单浮层：1x1 定位点 + Dropdown 受控 */}
      <Dropdown
        menu={{ items: navContextItems ?? [] }}
        open={!!navContextMenu}
        onOpenChange={(open) => { if (!open) setNavContextMenu(null) }}
        trigger={[]}
      >
        <div style={{
          position: 'fixed',
          left: navContextMenu?.x ?? -100,
          top: navContextMenu?.y ?? -100,
          width: 1,
          height: 1,
          pointerEvents: 'none',
        }} />
      </Dropdown>
    </Layout>
  )
}

export default App
