import { createHashRouter, Navigate } from 'react-router-dom'
import App from '../App'
import CreationWizard from '../pages/CreationWizard'
import EmployeeRedirect from '../components/common/EmployeeRedirect'
import TaskCenter from '../pages/TaskCenter'
import EmployeeWorkbench from '../pages/EmployeeWorkbench'
import EmployeeSettings from '../pages/EmployeeSettings'
import Settings from '../pages/Settings'
import KnowledgeBasePage from '../pages/KnowledgeBase'
import WorkflowList from '../pages/WorkflowList'
import WorkflowEditor from '../pages/WorkflowEditor'

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
        path: 'digital-employees',
        element: <Navigate to="/" replace />,
      },
      {
        path: 'dashboard',
        element: <Navigate to="/" replace />,
      },
      {
        path: 'conversation-center',
        element: <Navigate to="/" replace />,
      },
      {
        path: 'wizard',
        element: <CreationWizard />,
      },
      {
        path: 'task-center',
        element: <TaskCenter />,
      },
      {
        path: 'workflows',
        element: <WorkflowList />,
      },
      {
        path: 'workflow/:id',
        element: <WorkflowEditor />,
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
    ],
  },
])

export default router
