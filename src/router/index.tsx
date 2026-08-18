import { createHashRouter } from 'react-router-dom'
import { lazy, Suspense, ReactNode } from 'react'
import App from '../App'
import EmployeeRedirect from '../components/common/EmployeeRedirect'
import TabWindowLayout from '../components/common/TabWindowLayout'
import type { LoadedPlugin } from '../plugins/loader'

const Tasks = lazy(() => import('../pages/Tasks'))
const Employees = lazy(() => import('../pages/Employees'))
const CreationWizard = lazy(() => import('../pages/CreationWizard'))
const Settings = lazy(() => import('../pages/Settings'))
const KMSPage = lazy(() => import('../pages/KMS'))
const AutomationPage = lazy(() => import('../pages/Automation'))


const lazyElement = (node: ReactNode) => (
  <Suspense fallback={<div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', height: '100vh' }} />}>
    {node}
  </Suspense>
)

/** 插件路由：挂载到 /plugin/<id>/ 命名空间（主窗口与独立窗口共用同一组路径） */
function pluginRouteItems(plugins: LoadedPlugin[]) {
  return plugins.flatMap(p =>
    p.routes.map(r => ({
      path: `plugin/${p.id}${r.path ? `/${r.path}` : ''}`,
      element: lazyElement(r.element),
    }))
  )
}

/** 启动期装配路由：先加载插件（渲染端入口 + 贡献路由），再建路由表 */
export function buildRouter(plugins: LoadedPlugin[]) {
  return createHashRouter([
    {
      path: '/',
      element: <App />,
      children: [
        {
          index: true,
          element: <EmployeeRedirect />,
        },
        {
          path: 'tasks',
          element: lazyElement(<Tasks />),
        },
        {
          path: 'employees',
          element: lazyElement(<Employees />),
        },
        {
          path: 'wizard',
          element: lazyElement(<CreationWizard />),
        },
        {
          path: 'settings',
          element: lazyElement(<Settings />),
        },
        {
          path: 'kms',
          element: lazyElement(<KMSPage />),
        },
        {
          path: 'automation',
          element: lazyElement(<AutomationPage />),
        },
        ...pluginRouteItems(plugins),
      ],
    },
    // Tab 独立窗口：裸路由，不挂 App 壳（无侧边栏）
    // 加载 index.html#/window/:tabKey 时进入此分支
    {
      path: '/window',
      element: <TabWindowLayout />,
      children: [
        { path: 'tasks', element: lazyElement(<Tasks />) },
        { path: 'employees', element: lazyElement(<Employees />) },
        { path: 'kms', element: lazyElement(<KMSPage />) },
        { path: 'automation', element: lazyElement(<AutomationPage />) },
        ...pluginRouteItems(plugins),
      ],
    },
  ])
}
