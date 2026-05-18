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
        const lastId = localStorage.getItem('employeeWorkbench:lastEmployeeId')
        if (lastId) {
          try {
            await window.electronAPI.employee.get(lastId)
            setTargetPath(`/employee/${lastId}`)
            setLoading(false)
            return
          } catch {
            localStorage.removeItem('employeeWorkbench:lastEmployeeId')
          }
        }

        const employees = await window.electronAPI.employee.list()
        if (employees && employees.length > 0) {
          const firstId = employees[0].id
          localStorage.setItem('employeeWorkbench:lastEmployeeId', firstId)
          setTargetPath(`/employee/${firstId}`)
        } else {
          setTargetPath('/employee/_empty')
        }
      } catch {
        message.error(t('digitalEmployees.loadEmployeesFailed'))
        setTargetPath('/employee/_empty')
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
