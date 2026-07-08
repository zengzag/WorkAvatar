import { createHashRouter } from 'react-router-dom'
import { lazy, Suspense, ReactNode } from 'react'
import App from '../App'
import EmployeeRedirect from '../components/common/EmployeeRedirect'

const EmployeeWorkbench = lazy(() => import('../pages/EmployeeWorkbench'))
const CreationWizard = lazy(() => import('../pages/CreationWizard'))
const EmployeeSettings = lazy(() => import('../pages/EmployeeSettings'))
const Settings = lazy(() => import('../pages/Settings'))
const KMSPage = lazy(() => import('../pages/KMS'))

const lazyElement = (node: ReactNode) => (
  <Suspense fallback={<div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', height: '100vh' }} />}>
    {node}
  </Suspense>
)

const router = createHashRouter([
  {
    path: '/',
    element: <App />,
    children: [
      {
        index: true,
        element: <EmployeeRedirect />,
      },
      {
        path: 'wizard',
        element: lazyElement(<CreationWizard />),
      },
      {
        path: 'employee/:id',
        element: lazyElement(<EmployeeWorkbench />),
      },
      {
        path: 'employee/:id/settings',
        element: lazyElement(<EmployeeSettings />),
      },
      {
        path: 'settings',
        element: lazyElement(<Settings />),
      },
      {
        path: 'kms',
        element: lazyElement(<KMSPage />),
      },
    ],
  },
])

export default router
