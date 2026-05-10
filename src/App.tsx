import { useState } from 'react'
import { Layout, Menu, Typography } from 'antd'
import {
  RocketOutlined,
  FolderOpenOutlined,
  UserOutlined,
  SettingOutlined,
  BookOutlined,
} from '@ant-design/icons'
import { Outlet, useNavigate, useLocation } from 'react-router-dom'
import TaskProgressPanel from './components/common/TaskProgressPanel'

const { Sider, Content } = Layout
const { Title } = Typography

const App: React.FC = () => {
  const navigate = useNavigate()
  const location = useLocation()
  const [collapsed, setCollapsed] = useState(true)

  const getSelectedKey = () => {
    const path = location.pathname
    if (path.startsWith('/dashboard')) return 'dashboard'
    if (path === '/projects' || path.startsWith('/project/')) return 'projects'
    if (path === '/employees' || path.startsWith('/employee/')) return 'employees'
    if (path.startsWith('/settings')) return 'settings'
    if (path.startsWith('/knowledge-base')) return 'knowledge-base'
    return 'dashboard'
  }

  const menuItems = [
    {
      key: 'dashboard',
      icon: <RocketOutlined />,
      label: '仪表盘',
      onClick: () => navigate('/dashboard'),
    },
    {
      key: 'projects',
      icon: <FolderOpenOutlined />,
      label: '项目管理',
      onClick: () => navigate('/projects'),
    },
    {
      key: 'employees',
      icon: <UserOutlined />,
      label: '数字员工',
      onClick: () => navigate('/employees'),
    },
    {
      key: 'knowledge-base',
      icon: <BookOutlined />,
      label: '知识库',
      onClick: () => navigate('/knowledge-base'),
    },
    {
      key: 'settings',
      icon: <SettingOutlined />,
      label: '全局设置',
      onClick: () => navigate('/settings'),
    },
  ]

  return (
    <Layout style={{ height: '100vh' }}>
      <Sider
        theme="light"
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
            borderBottom: '1px solid #f0f0f0',
          }}
        >
          <RocketOutlined
            style={{
              fontSize: collapsed ? 24 : 20,
              color: '#1677ff',
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
        <div style={{ padding: '8px 16px 12px', borderTop: '1px solid #f0f0f0' }}>
          <TaskProgressPanel />
        </div>
      </Sider>
      <Layout>
        <Content
          style={{
            background: '#f5f5f5',
            overflow: 'auto',
          }}
        >
          <Outlet />
        </Content>
      </Layout>
    </Layout>
  )
}

export default App
