import { useState, useMemo, useCallback } from 'react'
import { Layout, Menu, Typography, theme } from 'antd'
import {
  RobotOutlined,
  SettingOutlined,
  SearchOutlined,
  AudioOutlined,
} from '@ant-design/icons'
import { useTranslation } from 'react-i18next'
import { Outlet, useNavigate, useLocation } from 'react-router-dom'
import UnifiedInteractionModal from './components/common/UnifiedInteractionModal'
import { useAppearanceStore, getEffectiveTheme } from './stores/appearance.store'

const { Sider, Content } = Layout
const { Title } = Typography

const App: React.FC = () => {
  const navigate = useNavigate()
  const location = useLocation()
  const { t } = useTranslation()
  const { token } = theme.useToken()
  const [collapsed, setCollapsed] = useState(true)
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
      onClick: () => navigate('/'),
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

  return (
    <Layout style={{ height: '100vh' }}>
      <Sider
        theme={effectiveTheme === 'dark' ? 'dark' : 'light'}
        collapsible
        collapsed={collapsed}
        onCollapse={setCollapsed}
        width={200}
        collapsedWidth={64}
        style={{ display: 'flex', flexDirection: 'column' }}
      >
        <div
          style={{
            height: 64,
            display: 'flex',
            alignItems: 'center',
            justifyContent: collapsed ? 'center' : 'flex-start',
            padding: collapsed ? '0 16px' : '0 24px',
            borderBottom: effectiveTheme === 'dark' ? '1px solid #303030' : '1px solid #f0f0f0',
          }}
        >
          <RobotOutlined
            style={{
              fontSize: collapsed ? 24 : 20,
              color: token.colorPrimary,
              marginRight: collapsed ? 0 : 8,
            }}
          />
          {!collapsed && <Title level={5} style={{ margin: 0 }}>WorkAvatar</Title>}
        </div>
        <Menu
          mode="inline"
          selectedKeys={[getSelectedKey()]}
          items={menuItems}
          style={{ borderRight: 'none', marginTop: 8, flex: 1 }}
        />
      </Sider>
      <Layout>
        <Content
          style={{
            overflow: 'auto',
          }}
        >
          <Outlet />
        </Content>
      </Layout>
      <UnifiedInteractionModal />
    </Layout>
  )
}

export default App
