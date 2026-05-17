import { createHashRouter, Navigate } from 'react-router-dom'
import App from '../App'
import CreationWizard from '../pages/CreationWizard'
import DigitalEmployeeCenter from '../pages/DigitalEmployeeCenter'
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
        element: <Navigate to="/digital-employees" replace />,
      },
      {
        path: 'digital-employees',
        element: <DigitalEmployeeCenter />,
      },
      {
        path: 'dashboard',
        element: <Navigate to="/digital-employees" replace />,
      },
      {
        path: 'conversation-center',
        element: <Navigate to="/digital-employees" replace />,
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
