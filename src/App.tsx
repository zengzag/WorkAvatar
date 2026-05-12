import { useState } from 'react'
import { Layout, Menu, Typography } from 'antd'
import {
  RocketOutlined,
  FolderOpenOutlined,
  UserOutlined,
  SettingOutlined,
  BookOutlined,
} from '@ant-design/icons'
import { useTranslation } from 'react-i18next'
import { Outlet, useNavigate, useLocation } from 'react-router-dom'
import TaskProgressPanel from './components/common/TaskProgressPanel'
import { ParseDetailModal } from './components/knowledge-base'
import { useAppearanceStore, getEffectiveTheme } from './stores/appearance.store'
import { useTaskDetailStore } from './stores/task-detail.store'

const { Sider, Content } = Layout
const { Title } = Typography

const App: React.FC = () => {
  const navigate = useNavigate()
  const location = useLocation()
  const { t } = useTranslation()
  const [collapsed, setCollapsed] = useState(true)
  const themeMode = useAppearanceStore((s) => s.themeMode)
  const effectiveTheme = getEffectiveTheme(themeMode)
  const taskDetailOpen = useTaskDetailStore((s) => s.open)
  const taskDetailDocId = useTaskDetailStore((s) => s.docId)
  const taskDetailDocName = useTaskDetailStore((s) => s.docName)
  const closeDetail = useTaskDetailStore((s) => s.closeDetail)

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
      label: t('nav.dashboard'),
      onClick: () => navigate('/dashboard'),
    },
    {
      key: 'projects',
      icon: <FolderOpenOutlined />,
      label: t('nav.projects'),
      onClick: () => navigate('/projects'),
    },
    {
      key: 'employees',
      icon: <UserOutlined />,
      label: t('nav.employees'),
      onClick: () => navigate('/employees'),
    },
    {
      key: 'knowledge-base',
      icon: <BookOutlined />,
      label: t('nav.knowledgeBase'),
      onClick: () => navigate('/knowledge-base'),
    },
    {
      key: 'settings',
      icon: <SettingOutlined />,
      label: t('nav.settings'),
      onClick: () => navigate('/settings'),
    },
  ]

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
        <div style={{ padding: '8px 16px 12px', borderTop: effectiveTheme === 'dark' ? '1px solid #303030' : '1px solid #f0f0f0' }}>
          <TaskProgressPanel />
        </div>
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
      <ParseDetailModal
        open={taskDetailOpen}
        docId={taskDetailDocId}
        docName={taskDetailDocName}
        onClose={closeDetail}
      />
    </Layout>
  )
}

export default App
