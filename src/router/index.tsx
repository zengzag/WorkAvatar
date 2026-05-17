import { createHashRouter, Navigate } from 'react-router-dom'
import App from '../App'
import ProjectDetail from '../pages/ProjectDetail'
import CreationWizard from '../pages/CreationWizard'
import DocumentViewer from '../pages/DocumentViewer'
import EmployeeManager from '../pages/EmployeeManager'
import EmployeeWorkbench from '../pages/EmployeeWorkbench'
import EmployeeSettings from '../pages/EmployeeSettings'
import Settings from '../pages/Settings'
import KnowledgeBasePage from '../pages/KnowledgeBase'
import ConversationCenter from '../pages/ConversationCenter'
import WorkflowList from '../pages/WorkflowList'
import WorkflowEditor from '../pages/WorkflowEditor'

const router = createHashRouter([
  {
    path: '/',
    element: <App />,
    children: [
      {
        index: true,
        element: <Navigate to="/conversation-center" replace />,
      },
      {
        path: 'conversation-center',
        element: <ConversationCenter />,
      },
      {
        path: 'dashboard',
        element: <Navigate to="/conversation-center" replace />,
      },
      {
        path: 'projects',
        element: <Navigate to="/settings?tab=projects" replace />,
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
        path: 'wizard',
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
