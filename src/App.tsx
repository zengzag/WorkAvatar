import { useMemo, useCallback } from 'react'
import { Layout, Menu, theme } from 'antd'
import {
  RobotOutlined,
  SettingOutlined,
  SearchOutlined,
  AudioOutlined,
} from '@ant-design/icons'
import { useTranslation } from 'react-i18next'
import { Outlet, useNavigate, useLocation } from 'react-router-dom'
import UnifiedInteractionModal from './components/common/UnifiedInteractionModal'
import TitleBar from './components/common/TitleBar'
import { useAppearanceStore, getEffectiveTheme } from './stores/appearance.store'

const { Sider, Content } = Layout

const App: React.FC = () => {
  const navigate = useNavigate()
  const location = useLocation()
  const { t } = useTranslation()
  const { token } = theme.useToken()
  const themeMode = useAppearanceStore((s) => s.themeMode)
  const effectiveTheme = getEffectiveTheme(themeMode)

  const getSelectedKey = useCallback(() => {
    const path = location.pathname
    if (path === '/' || path.startsWith('/employee')) return 'digital-employees'
    if (path.startsWith('/settings')) return 'settings'
    if (path.startsWith('/kms')) return 'kms'
    if (path.startsWith('/voice')) return 'voice'
    return 'digital-employees'
  }, [location.pathname])

  // memoize menuItems：避免每次路由变化都生成新数组触发 Menu 重渲染
  const menuItems = useMemo(() => [
    {
      key: 'digital-employees',
      icon: <RobotOutlined />,
      label: t('nav.digitalEmployees'),
      // 直接导航到上次使用的员工页面，跳过 EmployeeRedirect 的串行 IPC 延迟
      onClick: () => {
        const lastId = localStorage.getItem('employeeWorkbench:lastEmployeeId')
        navigate(lastId ? `/employee/${lastId}` : '/')
      },
    },
    {
      key: 'kms',
      icon: <SearchOutlined />,
      label: t('nav.kms'),
      onClick: () => navigate('/kms'),
    },
    {
      key: 'voice',
      icon: <AudioOutlined />,
      label: t('nav.voice'),
      onClick: () => navigate('/voice'),
    },
    {
      key: 'settings',
      icon: <SettingOutlined />,
      label: t('nav.settings'),
      onClick: () => navigate('/settings'),
    },
  ], [t, navigate])

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
          style={{
            display: 'flex',
            flexDirection: 'column',
            borderRight: `1px solid ${token.colorBorderSecondary}`,
            background: siderBg,
          }}
        >
          <Menu
            mode="inline"
            selectedKeys={[getSelectedKey()]}
            items={menuItems}
            inlineCollapsed={true}
            style={{
              borderRight: 'none',
              marginTop: 4,
              flex: 1,
              background: 'transparent',
            }}
            theme={effectiveTheme === 'dark' ? 'dark' : 'light'}
          />
        </Sider>
        <Layout>
          <Content
            style={{
              overflow: 'hidden',
            }}
          >
            <Outlet />
          </Content>
        </Layout>
      </Layout>
      <UnifiedInteractionModal />
    </Layout>
  )
}

export default App
