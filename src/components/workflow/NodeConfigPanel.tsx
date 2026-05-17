import { useCallback, useEffect, useState } from 'react'
import { Button, Input, Select, Typography, Divider, theme } from 'antd'
import { CloseOutlined, UserOutlined, PlayCircleOutlined, CheckCircleOutlined } from '@ant-design/icons'
import { useTranslation } from 'react-i18next'
import { useWorkflowStore, type InputNodeData, type EmployeeNodeData } from '../../stores/workflow.store'

const { Text, Title } = Typography
const { TextArea } = Input

const NodeConfigPanel: React.FC = () => {
  const { token } = theme.useToken()
  const { t } = useTranslation()
  const selectedNodeId = useWorkflowStore((s) => s.selectedNodeId)
  const nodes = useWorkflowStore((s) => s.nodes)
  const updateNodeData = useWorkflowStore((s) => s.updateNodeData)
  const setSelectedNodeId = useWorkflowStore((s) => s.setSelectedNodeId)

  const [employees, setEmployees] = useState<any[]>([])
  const [localPrompt, setLocalPrompt] = useState('')
  const [localLabel, setLocalLabel] = useState('')
  const [localEmployeeId, setLocalEmployeeId] = useState<string | undefined>()

  const selectedNode = nodes.find((n) => n.id === selectedNodeId)

  useEffect(() => {
    if (selectedNode) {
      const data = selectedNode.data as any
      setLocalPrompt(data.prompt || '')
      setLocalLabel(data.label || '')
      setLocalEmployeeId(data.employee_id)
    }
  }, [selectedNodeId, selectedNode])

  useEffect(() => {
    if (selectedNode?.type === 'employee') {
      loadEmployees()
    }
  }, [selectedNode?.type])

  const loadEmployees = async () => {
    try {
      const result = await window.electronAPI.employee.list()
      setEmployees(result || [])
    } catch {}
  }

  const handleSavePrompt = useCallback(() => {
    if (!selectedNodeId) return
    updateNodeData(selectedNodeId, { prompt: localPrompt } as Partial<InputNodeData>)
  }, [selectedNodeId, localPrompt, updateNodeData])

  const handleSaveLabel = useCallback(() => {
    if (!selectedNodeId) return
    updateNodeData(selectedNodeId, { label: localLabel })
  }, [selectedNodeId, localLabel, updateNodeData])

  const handleEmployeeChange = useCallback(
    (employeeId: string) => {
      if (!selectedNodeId) return
      const emp = employees.find((e) => e.id === employeeId)
      if (emp) {
        updateNodeData(selectedNodeId, {
          employee_id: emp.id,
          employee_name: emp.name,
          label: emp.name,
        } as Partial<EmployeeNodeData>)
        setLocalEmployeeId(emp.id)
        setLocalLabel(emp.name)
      }
    },
    [selectedNodeId, employees, updateNodeData]
  )

  if (!selectedNode) return null

  const nodeData = selectedNode.data as any
  const nodeType = selectedNode.type

  const getIcon = () => {
    if (nodeType === 'input') return <PlayCircleOutlined style={{ color: '#52c41a' }} />
    if (nodeType === 'output') return <CheckCircleOutlined style={{ color: '#1677ff' }} />
    if (nodeType === 'employee') return <UserOutlined style={{ color: '#722ed1' }} />
    return null
  }

  const getTypeLabel = () => {
    if (nodeType === 'input') return t('workflow.inputNode')
    if (nodeType === 'output') return t('workflow.outputNode')
    if (nodeType === 'employee') return t('workflow.employeeNode')
    return ''
  }

  return (
    <div
      style={{
        width: 300,
        height: '100%',
        borderLeft: `1px solid ${token.colorBorderSecondary}`,
        background: token.colorBgContainer,
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
      }}
    >
      <div
        style={{
          padding: '12px 16px',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          borderBottom: `1px solid ${token.colorBorderSecondary}`,
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          {getIcon()}
          <Title level={5} style={{ margin: 0 }}>
            {getTypeLabel()}
          </Title>
        </div>
        <Button type="text" icon={<CloseOutlined />} size="small" onClick={() => setSelectedNodeId(null)} />
      </div>

      <div style={{ flex: 1, overflow: 'auto', padding: 16 }}>
        {nodeType === 'input' && (
          <>
            <div style={{ marginBottom: 16 }}>
              <Text strong style={{ display: 'block', marginBottom: 4 }}>
                {t('workflow.labelLabel')}
              </Text>
              <Input
                value={localLabel}
                onChange={(e) => setLocalLabel(e.target.value)}
                onBlur={handleSaveLabel}
                placeholder={t('workflow.labelPlaceholder')}
              />
            </div>
            <Divider style={{ margin: '12px 0' }} />
            <div>
              <Text strong style={{ display: 'block', marginBottom: 4 }}>
                {t('workflow.promptLabel')}
              </Text>
              <TextArea
                value={localPrompt}
                onChange={(e) => setLocalPrompt(e.target.value)}
                onBlur={handleSavePrompt}
                rows={6}
                placeholder={t('workflow.promptPlaceholder')}
              />
            </div>
          </>
        )}

        {nodeType === 'output' && (
          <div>
            <Text strong style={{ display: 'block', marginBottom: 4 }}>
              {t('workflow.labelLabel')}
            </Text>
            <Input
              value={localLabel}
              onChange={(e) => setLocalLabel(e.target.value)}
              onBlur={handleSaveLabel}
              placeholder={t('workflow.labelPlaceholder')}
            />
          </div>
        )}

        {nodeType === 'employee' && (
          <>
            <div style={{ marginBottom: 16 }}>
              <Text strong style={{ display: 'block', marginBottom: 4 }}>
                {t('workflow.employeeLabel')}
              </Text>
              <Select
                value={localEmployeeId}
                onChange={handleEmployeeChange}
                style={{ width: '100%' }}
                placeholder={t('workflow.selectEmployee')}
                options={employees.map((emp) => ({
                  value: emp.id,
                  label: emp.name,
                }))}
              />
            </div>
            {nodeData.employee_name && (
              <div style={{ marginBottom: 16 }}>
                <Text type="secondary" style={{ fontSize: 12 }}>
                  {t('workflow.employeeLabel')}: {nodeData.employee_name}
                </Text>
              </div>
            )}
            {nodeData.description && (
              <div>
                <Text strong style={{ display: 'block', marginBottom: 4 }}>
                  {t('common.description')}
                </Text>
                <Text type="secondary" style={{ fontSize: 12 }}>
                  {nodeData.description}
                </Text>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  )
}

export default NodeConfigPanel
