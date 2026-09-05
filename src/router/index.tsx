import { createHashRouter } from 'react-router-dom'
import { lazy, Suspense, ReactNode } from 'react'
import App from '../App'
import EmployeeRedirect from '../components/common/EmployeeRedirect'
import TabWindowLayout from '../components/common/TabWindowLayout'
import { PluginRouteHost } from '../plugins/PluginRouteHost'

const Tasks = lazy(() => import('../pages/Tasks'))
const Employees = lazy(() => import('../pages/Employees'))
const CreationWizard = lazy(() => import('../pages/CreationWizard'))
const Settings = lazy(() => import('../pages/Settings'))
const KMSPage = lazy(() => import('../pages/KMS'))

const lazyElement = (node: ReactNode) => (
  <Suspense fallback={<div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', height: '100vh' }} />}>
    {node}
  </Suspense>
)

/** 插件路由：静态占位 /plugin/:pluginId/*，由 PluginRouteHost 按运行时插件 registry 动态分发
 * （插件加载/卸载/升级不再重建 router / 刷新窗口，实现免整页热加载） */
function pluginHostRoutes() {
  return [
    {
      path: 'plugin/:pluginId/*',
      element: lazyElement(<PluginRouteHost />),
    },
  ]
}

/** 装配路由（插件路由为静态占位，插件增删不重建 router） */
export function buildRouter() {
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
        ...pluginHostRoutes(),
      ],
    },
    // Tab 独立窗口：裸路由，不挂 App 壳（无侧边栏）
    // 加载 index.html#/window/:tabKey 时进入此分支（插件 tab → /window/plugin/<id>）
    {
      path: '/window',
      element: <TabWindowLayout />,
      children: [
        { path: 'tasks', element: lazyElement(<Tasks />) },
        { path: 'employees', element: lazyElement(<Employees />) },
        { path: 'kms', element: lazyElement(<KMSPage />) },
        ...pluginHostRoutes(),
      ],
    },
  ])
}