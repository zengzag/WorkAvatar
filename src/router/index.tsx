import { createHashRouter } from 'react-router-dom'
import { lazy, Suspense, ReactNode } from 'react'
import App from '../App'
import EmployeeRedirect from '../components/common/EmployeeRedirect'

const Tasks = lazy(() => import('../pages/Tasks'))
const Employees = lazy(() => import('../pages/Employees'))
const CreationWizard = lazy(() => import('../pages/CreationWizard'))
const Settings = lazy(() => import('../pages/Settings'))
const KMSPage = lazy(() => import('../pages/KMS'))
const VoicePage = lazy(() => import('../pages/Voice'))
const CalendarPage = lazy(() => import('../pages/Calendar'))
const AutomationPage = lazy(() => import('../pages/Automation'))
const NotesPage = lazy(() => import('../pages/Notes'))

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
        path: 'voice',
        element: lazyElement(<VoicePage />),
      },
      {
        path: 'calendar',
        element: lazyElement(<CalendarPage />),
      },
      {
        path: 'automation',
        element: lazyElement(<AutomationPage />),
      },
      {
        path: 'notes',
        element: lazyElement(<NotesPage />),
      },
    ],
  },
])

export default router
