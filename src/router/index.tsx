import { createHashRouter, Navigate } from 'react-router-dom'
import App from '../App'
import Dashboard from '../pages/Dashboard'
import ProjectManager from '../pages/ProjectManager'
import ProjectDetail from '../pages/ProjectDetail'
import CreationWizard from '../pages/CreationWizard'
import DocumentViewer from '../pages/DocumentViewer'
import EmployeeManager from '../pages/EmployeeManager'
import EmployeeWorkbench from '../pages/EmployeeWorkbench'
import EmployeeSettings from '../pages/EmployeeSettings'
import Settings from '../pages/Settings'
import KnowledgeBasePage from '../pages/KnowledgeBase'

const router = createHashRouter([
  {
    path: '/',
    element: <App />,
    children: [
      {
        index: true,
        element: <Navigate to="/dashboard" replace />,
      },
      {
        path: 'dashboard',
        element: <Dashboard />,
      },
      {
        path: 'projects',
        element: <ProjectManager />,
      },
      {
        path: 'project/:id',
        element: <ProjectDetail />,
      },
      {
        path: 'project/:id/wizard',
        element: <CreationWizard />,
      },
      {
        path: 'project/:id/file/:fileId',
        element: <DocumentViewer />,
      },
      {
        path: 'employees',
        element: <EmployeeManager />,
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
