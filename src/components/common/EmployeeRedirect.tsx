import { useEffect, useState } from 'react'
import { Navigate } from 'react-router-dom'
import { Spin, App } from 'antd'
import { useTranslation } from 'react-i18next'

const EmployeeRedirect: React.FC = () => {
  const { message } = App.useApp()
  const { t } = useTranslation()
  const [targetPath, setTargetPath] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    const resolveTarget = async () => {
      try {
        const employees = await window.electronAPI.employee.list()
        if (employees && employees.length > 0) {
          setTargetPath('/tasks')
        } else {
          setTargetPath('/employees')
        }
      } catch {
        message.error(t('digitalEmployees.loadEmployeesFailed'))
        setTargetPath('/tasks')
      } finally {
        setLoading(false)
      }
    }
    resolveTarget()
  }, [])

  if (loading) {
    return (
      <div style={{ height: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <Spin size="large" />
      </div>
    )
  }

  if (targetPath) {
    return <Navigate to={targetPath} replace />
  }

  return null
}

export default EmployeeRedirect
