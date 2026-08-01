import { useMemo, useCallback } from 'react'
import { Layout, Menu, theme } from 'antd'
import {
  SettingOutlined,
  SearchOutlined,
  AudioOutlined,
  CalendarOutlined,
  BookOutlined,
  FieldTimeOutlined,
  MessageOutlined,
  TeamOutlined,
} from '@ant-design/icons'
import { useTranslation } from 'react-i18next'
import { useNavigate, useLocation } from 'react-router-dom'
import UnifiedInteractionModal from './components/common/UnifiedInteractionModal'
import KeepAliveOutlet from './components/common/KeepAliveOutlet'
import TitleBar from './components/common/TitleBar'
import { useAppearanceStore, getEffectiveTheme } from './stores/appearance.store'
import { useNavConfigStore, getVisibleNavItems, type NavItemKey } from './stores/nav.store'
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

  const getSelectedKey = useCallback(() => {
    const path = location.pathname
    if (path.startsWith('/employees') || path === '/wizard') return 'employees'
    if (path === '/' || path.startsWith('/tasks')) return 'tasks'
    if (path.startsWith('/settings')) return 'settings'
    if (path.startsWith('/kms')) return 'kms'
    if (path.startsWith('/voice')) return 'voice'
    if (path.startsWith('/calendar')) return 'calendar'
    if (path.startsWith('/notes')) return 'notes'
    if (path.startsWith('/automation')) return 'automation'
    return 'tasks'
  }, [location.pathname])

  // 全局监听日历/ask_user/自动化 通知：主窗口激活时由主进程推送，antd notification 显示
  useCalendarNotify((payload) => {
    if (payload.clickTarget === 'automation' && payload.clickId) {
      try {
        const { conversationId, employeeId } = JSON.parse(payload.clickId)
        if (employeeId && conversationId) {
          localStorage.setItem(`employeeWorkbench:activeConvId:${employeeId}`, conversationId)
          navigate('/tasks')
          return
        }
      } catch { /* ignore parse error */ }
    }
    navigate('/calendar')
  })
  // 系统通知点击后由主进程推送 → 按目标跳转
  useCalendarNotifyClick((payload) => {
    if (payload.target === 'automation' && payload.id) {
      try {
        const { conversationId, employeeId } = JSON.parse(payload.id)
        if (employeeId && conversationId) {
          localStorage.setItem(`employeeWorkbench:activeConvId:${employeeId}`, conversationId)
          navigate('/tasks')
          return
        }
      } catch { /* ignore parse error */ }
    }
    navigate('/calendar')
  })

  // 导航菜单配置（从 nav.store 读取显隐与排序）
  const navConfig = useNavConfigStore((s) => s.config)

  // 所有导航项的定义（icon + label + onClick）
  const navItemDefs = useMemo(() => ({
    'tasks': {
      icon: <MessageOutlined />,
      label: t('nav.tasks'),
      onClick: () => navigate('/tasks'),
    },
    'employees': {
      icon: <TeamOutlined />,
      label: t('nav.employees'),
      onClick: () => navigate('/employees'),
    },
    'kms': {
      icon: <SearchOutlined />,
      label: t('nav.kms'),
      onClick: () => navigate('/kms'),
    },
    'voice': {
      icon: <VoiceNavIcon recording={isVoiceRecording} paused={isVoicePaused} />,
      label: isVoiceRecording ? t('nav.voiceRecording') : t('nav.voice'),
      onClick: () => navigate('/voice'),
    },
    'calendar': {
      icon: <CalendarOutlined />,
      label: t('nav.calendar'),
      onClick: () => navigate('/calendar'),
    },
    'notes': {
      icon: <BookOutlined />,
      label: t('nav.notes'),
      onClick: () => navigate('/notes'),
    },
    'automation': {
      icon: <FieldTimeOutlined />,
      label: t('nav.automation'),
      onClick: () => navigate('/automation'),
    },
    'settings': {
      icon: <SettingOutlined />,
      label: t('nav.settings'),
      onClick: () => navigate('/settings'),
    },
  }), [t, navigate, isVoiceRecording, isVoicePaused])

  // 按配置过滤+排序后的菜单项
  const menuItems = useMemo(() => {
    return getVisibleNavItems(navConfig).map((item) => ({
      key: item.key,
      ...navItemDefs[item.key as NavItemKey],
    }))
  }, [navConfig, navItemDefs])

  // 分离 settings 到最底部，其余保持原顺序
  const mainMenuItems = useMemo(() => menuItems.filter(item => item.key !== 'settings'), [menuItems])
  const settingsMenuItem = useMemo(() => menuItems.filter(item => item.key === 'settings'), [menuItems])

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
            <KeepAliveOutlet />
          </Content>
        </Layout>
      </Layout>
      <UnifiedInteractionModal />
    </Layout>
  )
}

export default App
