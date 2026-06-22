import { createHashRouter } from 'react-router-dom'
import App from '../App'
import CreationWizard from '../pages/CreationWizard'
import EmployeeRedirect from '../components/common/EmployeeRedirect'
import EmployeeWorkbench from '../pages/EmployeeWorkbench'
import EmployeeSettings from '../pages/EmployeeSettings'
import Settings from '../pages/Settings'
import KnowledgeBasePage from '../pages/KnowledgeBase'
import KMSPage from '../pages/KMS'

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
        element: <CreationWizard />,
      },
      {
        path: 'employee/:id',
        element: <EmployeeWorkbench />,
      },
      {
        path: 'employee/:id/settings',
        element: <EmployeeSettings />,
      },
      {
        path: 'settings',
        element: <Settings />,
      },
      {
        path: 'knowledge-base',
        element: <KnowledgeBasePage />,
      },
      {
        path: 'kms',
        element: <KMSPage />,
      },
    ],
  },
])

export default router
