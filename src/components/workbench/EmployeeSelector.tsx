import { useState, useMemo, useCallback } from 'react'
import { Input, Button, Tag } from 'antd'
import { RobotOutlined, PlusOutlined, SearchOutlined, DeleteOutlined } from '@ant-design/icons'
import { useTranslation } from 'react-i18next'
import { theme } from 'antd'
import type { Employee } from '../../types'

const AVATAR_COLORS = [
  '#1677ff', '#52c41a', '#fa8c16', '#722ed1',
  '#eb2f96', '#13c2c2', '#faad14', '#f5222d',
]

interface EmployeeSelectorProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  employees: Employee[]
  activeEmployeeId: string | undefined
  onSelect: (id: string) => void
  onCreateNew: () => void
  onDeleteEmployee: (emp: Employee) => void
}

const EmployeeSelector: React.FC<EmployeeSelectorProps> = ({
  open: _open,
  onOpenChange,
  employees,
  activeEmployeeId,
  onSelect,
  onCreateNew,
  onDeleteEmployee,
}) => {
  const { t } = useTranslation()
  const { token } = theme.useToken()
  const [searchText, setSearchText] = useState('')
  const [contextMenu, setContextMenu] = useState<{ emp: Employee; x: number; y: number } | null>(null)

  const filteredEmployees = useMemo(() => {
    if (!searchText.trim()) return employees
    const search = searchText.toLowerCase()
    return employees.filter(emp => emp.name.toLowerCase().includes(search))
  }, [employees, searchText])

  const handleOpenChange = useCallback((newOpen: boolean) => {
    onOpenChange(newOpen)
    if (!newOpen) {
      setContextMenu(null)
      setSearchText('')
    }
  }, [onOpenChange])

  return (
    <div style={{ width: 260 }}>
      <Input
        placeholder={t('workbench.searchEmployee')}
        prefix={<SearchOutlined style={{ color: token.colorTextQuaternary }} />}
        value={searchText}
        onChange={(e) => setSearchText(e.target.value)}
        allowClear
        variant="borderless"
        style={{ marginBottom: 4, padding: '4px 8px' }}
      />
      {filteredEmployees.length === 0 && (
        <div style={{ padding: '24px 0', textAlign: 'center', color: token.colorTextQuaternary, fontSize: 13 }}>
          {searchText ? t('workbench.noMatchingEmployee') : t('digitalEmployees.noEmployees')}
        </div>
      )}
      <div style={{ maxHeight: 300, overflowY: 'auto' }}>
        {filteredEmployees.map((emp, idx) => {
          const color = AVATAR_COLORS[idx % AVATAR_COLORS.length]
          const isActive = emp.id === activeEmployeeId
          return (
            <div
              key={emp.id}
              onClick={() => {
                handleOpenChange(false)
                onSelect(emp.id)
              }}
              onContextMenu={(e) => {
                if (isActive) return
                e.preventDefault()
                setContextMenu({ emp, x: e.clientX, y: e.clientY })
              }}
              style={{
                display: 'flex', alignItems: 'center', gap: 8,
                padding: '6px 8px', borderRadius: 6,
                cursor: 'pointer',
                background: isActive ? token.colorPrimaryBg : 'transparent',
                transition: 'background 0.2s',
              }}
              onMouseEnter={(e) => {
                if (!isActive) e.currentTarget.style.background = token.colorBgTextHover
              }}
              onMouseLeave={(e) => {
                if (!isActive) e.currentTarget.style.background = 'transparent'
              }}
            >
              <div style={{
                width: 28, height: 28, borderRadius: 6,
                background: `${color}18`,
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                flexShrink: 0,
              }}>
                <RobotOutlined style={{ fontSize: 14, color }} />
              </div>
              <span style={{
                flex: 1,
                fontWeight: isActive ? 600 : 400,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}>
                {emp.name}
              </span>
              {isActive && (
                <Tag color="blue" style={{ fontSize: 10, lineHeight: '16px', padding: '0 4px', margin: 0 }}>
                  {t('workbench.activeEmployee')}
                </Tag>
              )}
            </div>
          )
        })}
      </div>
      <div style={{ borderTop: `1px solid ${token.colorBorderSecondary}`, paddingTop: 4, marginTop: 4 }}>
        <Button
          type="text"
          icon={<PlusOutlined />}
          style={{ width: '100%', justifyContent: 'flex-start', color: token.colorPrimary }}
          onClick={() => {
            handleOpenChange(false)
            onCreateNew()
          }}
        >
          {t('workbench.createEmployee')}
        </Button>
      </div>

      {contextMenu && (
        <>
          <div
            style={{ position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, zIndex: 1050 }}
            onClick={() => setContextMenu(null)}
            onContextMenu={(e) => { e.preventDefault(); setContextMenu(null) }}
          />
          <div style={{
            position: 'fixed',
            left: contextMenu.x,
            top: contextMenu.y,
            zIndex: 1051,
            background: token.colorBgElevated,
            borderRadius: 8,
            boxShadow: token.boxShadowSecondary,
            padding: 4,
            minWidth: 140,
            border: `1px solid ${token.colorBorderSecondary}`,
          }}>
            <div
              style={{
                padding: '6px 12px', borderRadius: 6, cursor: 'pointer',
                color: token.colorError, display: 'flex', alignItems: 'center', gap: 8,
                fontSize: 13,
              }}
              onClick={() => {
                setContextMenu(null)
                onDeleteEmployee(contextMenu.emp)
              }}
              onMouseEnter={(e) => { e.currentTarget.style.background = token.colorErrorBg }}
              onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent' }}
            >
              <DeleteOutlined />
              <span>{t('workbench.deleteEmployee')}</span>
            </div>
          </div>
        </>
      )}
    </div>
  )
}

export default EmployeeSelector
