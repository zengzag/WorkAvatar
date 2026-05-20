import { useCallback, useEffect, useState } from 'react'
import { Button, Input, Select, Typography, Divider, theme, Radio, Checkbox, Space } from 'antd'
import { CloseOutlined, UserOutlined, PlayCircleOutlined, CheckCircleOutlined, ForkOutlined, MergeCellsOutlined, PlusOutlined, DeleteOutlined, FileOutlined, ScissorOutlined, ArrowUpOutlined, ArrowDownOutlined } from '@ant-design/icons'
import { useTranslation } from 'react-i18next'
import { useWorkflowStore, type InputNodeData, type EmployeeNodeData, type BranchNodeData, type MergeNodeData, type ExtractNodeData, type BranchRule, type ExtractField } from '../../stores/workflow.store'
import LLMSelector from '../llm/LLMSelector'
import type { LLMProvider } from '../../types'

const { Text } = Typography
const { TextArea } = Input

const NodeConfigPanel: React.FC = () => {
  const { token } = theme.useToken()
  const { t } = useTranslation()
  const selectedNodeId = useWorkflowStore((s) => s.selectedNodeId)
  const nodes = useWorkflowStore((s) => s.nodes)
  const edges = useWorkflowStore((s) => s.edges)
  const updateNodeData = useWorkflowStore((s) => s.updateNodeData)
  const setSelectedNodeId = useWorkflowStore((s) => s.setSelectedNodeId)

  const [employees, setEmployees] = useState<any[]>([])
  const [providers, setProviders] = useState<LLMProvider[]>([])
  const [localPrompt, setLocalPrompt] = useState('')
  const [localLabel, setLocalLabel] = useState('')
  const [localEmployeeId, setLocalEmployeeId] = useState<string | undefined>()
  const [localProviderId, setLocalProviderId] = useState<string | undefined>()
  const [localModelId, setLocalModelId] = useState<string | undefined>()
  const [localInputType, setLocalInputType] = useState<'fixed' | 'runtime' | 'file'>('fixed')
  const [localFilePath, setLocalFilePath] = useState('')
  const [localSourceNodeId, setLocalSourceNodeId] = useState<string | undefined>()
  const [localRules, setLocalRules] = useState<BranchRule[]>([])
  const [localSelectedUpstreamIds, setLocalSelectedUpstreamIds] = useState<string[]>([])
  const [localUpstreamOrder, setLocalUpstreamOrder] = useState<string[]>([])
  const [localMergeMode, setLocalMergeMode] = useState<'concat'>('concat')
  const [localSeparator, setLocalSeparator] = useState('')
  const [localPrefix, setLocalPrefix] = useState('')
  const [localSuffix, setLocalSuffix] = useState('')
  const [localExtractSourceNodeId, setLocalExtractSourceNodeId] = useState<string | undefined>()
  const [localExtractFields, setLocalExtractFields] = useState<ExtractField[]>([])

  const selectedNode = nodes.find((n) => n.id === selectedNodeId)

  useEffect(() => {
    if (selectedNode) {
      const data = selectedNode.data as any
      setLocalPrompt(data.prompt || '')
      setLocalLabel(data.label || '')
      setLocalEmployeeId(data.employee_id)
      setLocalProviderId(data.provider_id)
      setLocalModelId(data.model_id)
      setLocalInputType(data.inputType || 'fixed')
      setLocalFilePath(data.filePath || '')
      setLocalSourceNodeId(data.sourceNodeId || undefined)
      setLocalRules(data.rules || [])
      setLocalSelectedUpstreamIds(data.selectedUpstreamIds || [])
      setLocalUpstreamOrder(data.upstreamOrder || [])
      setLocalMergeMode(data.mergeMode || 'concat')
      setLocalSeparator(data.separator || '')
      setLocalPrefix(data.prefix || '')
      setLocalSuffix(data.suffix || '')
      setLocalExtractSourceNodeId(data.sourceNodeId || undefined)
      setLocalExtractFields(data.fields || [])
    }
  }, [selectedNodeId, selectedNode])

  useEffect(() => {
    loadProviders()
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

  const loadProviders = async () => {
    try {
      const result = await window.electronAPI.llm.getProviders()
      setProviders(result as LLMProvider[])
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
          provider_id: emp.llm_provider_id || undefined,
          model_id: emp.llm_model || undefined,
        } as Partial<EmployeeNodeData>)
        setLocalEmployeeId(emp.id)
        setLocalLabel(emp.name)
        setLocalProviderId(emp.llm_provider_id || undefined)
        setLocalModelId(emp.llm_model || undefined)
      }
    },
    [selectedNodeId, employees, updateNodeData]
  )

  const handleLlmChange = useCallback(
    (providerId: string, modelId: string) => {
      if (!selectedNodeId) return
      updateNodeData(selectedNodeId, {
        provider_id: providerId,
        model_id: modelId,
      } as Partial<EmployeeNodeData>)
      setLocalProviderId(providerId)
      setLocalModelId(modelId)
    },
    [selectedNodeId, updateNodeData]
  )

  const handleInputTypeChange = useCallback(
    (type: 'fixed' | 'runtime' | 'file') => {
      if (!selectedNodeId) return
      setLocalInputType(type)
      updateNodeData(selectedNodeId, { inputType: type } as Partial<InputNodeData>)
    },
    [selectedNodeId, updateNodeData]
  )

  const handleFilePathChange = useCallback(
    (path: string) => {
      if (!selectedNodeId) return
      setLocalFilePath(path)
      updateNodeData(selectedNodeId, { filePath: path } as Partial<InputNodeData>)
    },
    [selectedNodeId, updateNodeData]
  )

  const handleSelectFile = useCallback(async () => {
    try {
      const result = await window.electronAPI.app.showOpenDialog({
        properties: ['openFile'],
        title: t('workflow.selectFile'),
      })
      if (result && !result.canceled && result.filePaths.length > 0) {
        handleFilePathChange(result.filePaths[0])
      }
    } catch {}
  }, [handleFilePathChange, t])

  const handleSourceNodeChange = useCallback(
    (nodeId: string) => {
      if (!selectedNodeId) return
      setLocalSourceNodeId(nodeId)
      updateNodeData(selectedNodeId, { sourceNodeId: nodeId } as Partial<BranchNodeData>)
    },
    [selectedNodeId, updateNodeData]
  )

  const handleAddRule = useCallback(() => {
    if (!selectedNodeId) return
    const newRules = [...localRules, { type: 'keyword' as const, keywords: '' }]
    setLocalRules(newRules)
    updateNodeData(selectedNodeId, { rules: newRules } as Partial<BranchNodeData>)
  }, [selectedNodeId, localRules, updateNodeData])

  const handleRemoveRule = useCallback(
    (index: number) => {
      if (!selectedNodeId) return
      const newRules = localRules.filter((_, i) => i !== index)
      setLocalRules(newRules)
      updateNodeData(selectedNodeId, { rules: newRules } as Partial<BranchNodeData>)
    },
    [selectedNodeId, localRules, updateNodeData]
  )

  const handleRuleChange = useCallback(
    (index: number, field: string, value: string) => {
      if (!selectedNodeId) return
      const newRules = [...localRules]
      newRules[index] = { ...newRules[index], [field]: value }
      setLocalRules(newRules)
      updateNodeData(selectedNodeId, { rules: newRules } as Partial<BranchNodeData>)
    },
    [selectedNodeId, localRules, updateNodeData]
  )

  const handleRuleTypeChange = useCallback(
    (index: number, type: 'json_key' | 'keyword') => {
      if (!selectedNodeId) return
      const newRules = [...localRules]
      newRules[index] = { type, ...(type === 'json_key' ? { jsonKey: '', jsonValue: '' } : { keywords: '' }) }
      setLocalRules(newRules)
      updateNodeData(selectedNodeId, { rules: newRules } as Partial<BranchNodeData>)
    },
    [selectedNodeId, localRules, updateNodeData]
  )

  const handleUpstreamSelect = useCallback(
    (upstreamIds: string[]) => {
      if (!selectedNodeId) return
      const newOrder = upstreamIds.filter(id => localUpstreamOrder.includes(id))
      for (const id of upstreamIds) {
        if (!newOrder.includes(id)) newOrder.push(id)
      }
      setLocalSelectedUpstreamIds(upstreamIds)
      setLocalUpstreamOrder(newOrder)
      updateNodeData(selectedNodeId, { selectedUpstreamIds: upstreamIds, upstreamOrder: newOrder } as Partial<MergeNodeData>)
    },
    [selectedNodeId, updateNodeData, localUpstreamOrder]
  )

  const handleMoveUpstreamUp = useCallback(
    (index: number) => {
      if (!selectedNodeId || index <= 0) return
      const newOrder = [...localUpstreamOrder]
      ;[newOrder[index - 1], newOrder[index]] = [newOrder[index], newOrder[index - 1]]
      setLocalUpstreamOrder(newOrder)
      updateNodeData(selectedNodeId, { upstreamOrder: newOrder } as Partial<MergeNodeData>)
    },
    [selectedNodeId, localUpstreamOrder, updateNodeData]
  )

  const handleMoveUpstreamDown = useCallback(
    (index: number) => {
      if (!selectedNodeId || index >= localUpstreamOrder.length - 1) return
      const newOrder = [...localUpstreamOrder]
      ;[newOrder[index], newOrder[index + 1]] = [newOrder[index + 1], newOrder[index]]
      setLocalUpstreamOrder(newOrder)
      updateNodeData(selectedNodeId, { upstreamOrder: newOrder } as Partial<MergeNodeData>)
    },
    [selectedNodeId, localUpstreamOrder, updateNodeData]
  )

  const handleMergeConfigChange = useCallback(
    (field: string, value: string) => {
      if (!selectedNodeId) return
      const update: any = { [field]: value }
      if (field === 'separator') setLocalSeparator(value)
      if (field === 'prefix') setLocalPrefix(value)
      if (field === 'suffix') setLocalSuffix(value)
      updateNodeData(selectedNodeId, update as Partial<MergeNodeData>)
    },
    [selectedNodeId, updateNodeData]
  )

  const handleExtractSourceNodeChange = useCallback(
    (nodeId: string) => {
      if (!selectedNodeId) return
      setLocalExtractSourceNodeId(nodeId)
      updateNodeData(selectedNodeId, { sourceNodeId: nodeId } as Partial<ExtractNodeData>)
    },
    [selectedNodeId, updateNodeData]
  )

  const handleAddExtractField = useCallback(() => {
    if (!selectedNodeId) return
    const newFields = [...localExtractFields, { name: '', path: '', defaultValue: '' }]
    setLocalExtractFields(newFields)
    updateNodeData(selectedNodeId, { fields: newFields } as Partial<ExtractNodeData>)
  }, [selectedNodeId, localExtractFields, updateNodeData])

  const handleRemoveExtractField = useCallback(
    (index: number) => {
      if (!selectedNodeId) return
      const newFields = localExtractFields.filter((_, i) => i !== index)
      setLocalExtractFields(newFields)
      updateNodeData(selectedNodeId, { fields: newFields } as Partial<ExtractNodeData>)
    },
    [selectedNodeId, localExtractFields, updateNodeData]
  )

  const handleExtractFieldChange = useCallback(
    (index: number, field: string, value: string) => {
      if (!selectedNodeId) return
      const newFields = [...localExtractFields]
      newFields[index] = { ...newFields[index], [field]: value }
      setLocalExtractFields(newFields)
      updateNodeData(selectedNodeId, { fields: newFields } as Partial<ExtractNodeData>)
    },
    [selectedNodeId, localExtractFields, updateNodeData]
  )

  if (!selectedNode) return null

  const nodeData = selectedNode.data as any
  const nodeType = selectedNode.type

  const getIcon = () => {
    if (nodeType === 'input') return <PlayCircleOutlined style={{ color: '#52c41a' }} />
    if (nodeType === 'output') return <CheckCircleOutlined style={{ color: '#1677ff' }} />
    if (nodeType === 'employee') return <UserOutlined style={{ color: '#722ed1' }} />
    if (nodeType === 'branch') return <ForkOutlined style={{ color: '#fa8c16' }} />
    if (nodeType === 'merge') return <MergeCellsOutlined style={{ color: '#13c2c2' }} />
    if (nodeType === 'extract') return <ScissorOutlined style={{ color: '#eb2f96' }} />
    return null
  }

  const getTypeLabel = () => {
    if (nodeType === 'input') return t('workflow.inputNode')
    if (nodeType === 'output') return t('workflow.outputNode')
    if (nodeType === 'employee') return t('workflow.employeeNode')
    if (nodeType === 'branch') return t('workflow.branchNode')
    if (nodeType === 'merge') return t('workflow.mergeNode')
    if (nodeType === 'extract') return t('workflow.extractNode')
    return ''
  }

  const upstreamNodes = nodes.filter((n) =>
    edges.some((e) => e.target === selectedNodeId && e.source === n.id)
  )

  const orderedUpstreamNodes = localUpstreamOrder
    .map(id => upstreamNodes.find(n => n.id === id))
    .filter(Boolean) as typeof upstreamNodes
  const unorderedUpstreamNodes = upstreamNodes.filter(n => !localUpstreamOrder.includes(n.id))
  const displayUpstreamNodes = [...orderedUpstreamNodes, ...unorderedUpstreamNodes]

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
          <Typography.Title level={5} style={{ margin: 0 }}>
            {getTypeLabel()}
          </Typography.Title>
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
            <div style={{ marginBottom: 16 }}>
              <Text strong style={{ display: 'block', marginBottom: 4 }}>
                {t('workflow.inputTypeLabel')}
              </Text>
              <Radio.Group
                value={localInputType}
                onChange={(e) => handleInputTypeChange(e.target.value)}
                style={{ display: 'flex', flexDirection: 'column', gap: 4 }}
              >
                <Radio value="fixed">{t('workflow.inputTypeFixed')}</Radio>
                <Radio value="runtime">{t('workflow.inputTypeRuntime')}</Radio>
                <Radio value="file">{t('workflow.inputTypeFile')}</Radio>
              </Radio.Group>
            </div>
            {localInputType === 'fixed' && (
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
            )}
            {localInputType === 'runtime' && (
              <div>
                <Text type="secondary" style={{ fontSize: 12 }}>
                  {t('workflow.inputTypeRuntimeDesc')}
                </Text>
              </div>
            )}
            {localInputType === 'file' && (
              <div>
                <Text strong style={{ display: 'block', marginBottom: 4 }}>
                  {t('workflow.filePathLabel')}
                </Text>
                <Space.Compact style={{ width: '100%' }}>
                  <Input
                    value={localFilePath}
                    onChange={(e) => handleFilePathChange(e.target.value)}
                    placeholder={t('workflow.filePathPlaceholder')}
                  />
                  <Button icon={<FileOutlined />} onClick={handleSelectFile} />
                </Space.Compact>
              </div>
            )}
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
              <div style={{ marginBottom: 16 }}>
                <Text strong style={{ display: 'block', marginBottom: 4 }}>
                  {t('common.description')}
                </Text>
                <Text type="secondary" style={{ fontSize: 12 }}>
                  {nodeData.description}
                </Text>
              </div>
            )}
            <Divider style={{ margin: '12px 0' }} />
            <div>
              <Text strong style={{ display: 'block', marginBottom: 8 }}>
                {t('workflow.modelConfig')}
              </Text>
              <LLMSelector
                providerId={localProviderId}
                modelId={localModelId}
                onChange={handleLlmChange}
                providers={providers}
              />
              <Text type="secondary" style={{ fontSize: 11, display: 'block', marginTop: 4 }}>
                {t('workflow.modelConfigHint')}
              </Text>
            </div>
          </>
        )}

        {nodeType === 'branch' && (
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
            <div style={{ marginBottom: 16 }}>
              <Text strong style={{ display: 'block', marginBottom: 4 }}>
                {t('workflow.branchSourceLabel')}
              </Text>
              <Select
                value={localSourceNodeId}
                onChange={handleSourceNodeChange}
                style={{ width: '100%' }}
                placeholder={t('workflow.branchSourcePlaceholder')}
                allowClear
                options={upstreamNodes.map((n) => ({
                  value: n.id,
                  label: (n.data as any).label || n.id,
                }))}
              />
              <Text type="secondary" style={{ fontSize: 11, display: 'block', marginTop: 4 }}>
                {t('workflow.branchSourceHint')}
              </Text>
            </div>
            <Divider style={{ margin: '12px 0' }} />
            <div>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
                <Text strong>{t('workflow.branchRulesLabel')}</Text>
                <Button size="small" icon={<PlusOutlined />} onClick={handleAddRule}>
                  {t('workflow.addRule')}
                </Button>
              </div>
              <Text type="secondary" style={{ fontSize: 11, display: 'block', marginBottom: 8 }}>
                {t('workflow.branchRulesHint')}
              </Text>
              {localRules.length === 0 && (
                <Text type="secondary" style={{ fontSize: 12 }}>
                  {t('workflow.noBranchRules')}
                </Text>
              )}
              {localRules.map((rule, index) => (
                <div
                  key={index}
                  style={{
                    marginBottom: 12,
                    padding: 8,
                    border: `1px solid ${token.colorBorderSecondary}`,
                    borderRadius: 6,
                    background: token.colorBgLayout,
                  }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
                    <Select
                      value={rule.type}
                      onChange={(val) => handleRuleTypeChange(index, val)}
                      style={{ width: 140 }}
                      size="small"
                      options={[
                        { value: 'json_key', label: t('workflow.ruleTypeJsonKey') },
                        { value: 'keyword', label: t('workflow.ruleTypeKeyword') },
                      ]}
                    />
                    <Button
                      type="text"
                      danger
                      size="small"
                      icon={<DeleteOutlined />}
                      onClick={() => handleRemoveRule(index)}
                    />
                  </div>
                  {rule.type === 'json_key' && (
                    <>
                      <Input
                        size="small"
                        value={rule.jsonKey || ''}
                        onChange={(e) => handleRuleChange(index, 'jsonKey', e.target.value)}
                        placeholder={t('workflow.jsonKeyPlaceholder')}
                        style={{ marginBottom: 4 }}
                      />
                      <Input
                        size="small"
                        value={rule.jsonValue || ''}
                        onChange={(e) => handleRuleChange(index, 'jsonValue', e.target.value)}
                        placeholder={t('workflow.jsonValuePlaceholder')}
                      />
                    </>
                  )}
                  {rule.type === 'keyword' && (
                    <Input
                      size="small"
                      value={rule.keywords || ''}
                      onChange={(e) => handleRuleChange(index, 'keywords', e.target.value)}
                      placeholder={t('workflow.keywordsPlaceholder')}
                    />
                  )}
                </div>
              ))}
            </div>
          </>
        )}

        {nodeType === 'merge' && (
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
            <div style={{ marginBottom: 16 }}>
              <Text strong style={{ display: 'block', marginBottom: 4 }}>
                {t('workflow.mergeUpstreamLabel')}
              </Text>
              {upstreamNodes.length === 0 ? (
                <Text type="secondary" style={{ fontSize: 12 }}>
                  {t('workflow.noMergeUpstream')}
                </Text>
              ) : (
                <Checkbox.Group
                  value={localSelectedUpstreamIds}
                  onChange={(vals) => handleUpstreamSelect(vals as string[])}
                  style={{ display: 'flex', flexDirection: 'column', gap: 4 }}
                >
                  {upstreamNodes.map((n) => (
                    <Checkbox key={n.id} value={n.id}>
                      {(n.data as any).label || n.id}
                    </Checkbox>
                  ))}
                </Checkbox.Group>
              )}
            </div>
            {localSelectedUpstreamIds.length > 1 && (
              <div style={{ marginBottom: 16 }}>
                <Text strong style={{ display: 'block', marginBottom: 4 }}>
                  {t('workflow.mergeOrderLabel')}
                </Text>
                <Text type="secondary" style={{ fontSize: 11, display: 'block', marginBottom: 8 }}>
                  {t('workflow.mergeOrderHint')}
                </Text>
                {displayUpstreamNodes
                  .filter(n => localSelectedUpstreamIds.includes(n.id))
                  .map((n, index) => {
                    const orderIndex = localUpstreamOrder.indexOf(n.id)
                    return (
                      <div
                        key={n.id}
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          gap: 4,
                          marginBottom: 4,
                          padding: '4px 8px',
                          background: token.colorBgLayout,
                          borderRadius: 4,
                          border: `1px solid ${token.colorBorderSecondary}`,
                        }}
                      >
                        <span style={{ fontSize: 11, color: token.colorTextQuaternary, width: 16, textAlign: 'center' }}>
                          {index + 1}
                        </span>
                        <Text style={{ flex: 1, fontSize: 12 }}>{(n.data as any).label || n.id}</Text>
                        <Button
                          type="text"
                          size="small"
                          icon={<ArrowUpOutlined />}
                          disabled={index === 0}
                          onClick={() => handleMoveUpstreamUp(orderIndex >= 0 ? orderIndex : index)}
                          style={{ padding: '0 4px', minWidth: 24 }}
                        />
                        <Button
                          type="text"
                          size="small"
                          icon={<ArrowDownOutlined />}
                          disabled={index === localSelectedUpstreamIds.length - 1}
                          onClick={() => handleMoveUpstreamDown(orderIndex >= 0 ? orderIndex : index)}
                          style={{ padding: '0 4px', minWidth: 24 }}
                        />
                      </div>
                    )
                  })}
              </div>
            )}
            <Divider style={{ margin: '12px 0' }} />
            <div style={{ marginBottom: 12 }}>
              <Text strong style={{ display: 'block', marginBottom: 4 }}>
                {t('workflow.mergeModeLabel')}
              </Text>
              <Radio.Group value={localMergeMode} onChange={() => {}} disabled>
                <Radio value="concat">{t('workflow.mergeModeConcat')}</Radio>
              </Radio.Group>
            </div>
            <div style={{ marginBottom: 12 }}>
              <Text strong style={{ display: 'block', marginBottom: 4 }}>
                {t('workflow.mergeSeparatorLabel')}
              </Text>
              <Input
                value={localSeparator}
                onChange={(e) => handleMergeConfigChange('separator', e.target.value)}
                placeholder={t('workflow.mergeSeparatorPlaceholder')}
              />
            </div>
            <div style={{ marginBottom: 12 }}>
              <Text strong style={{ display: 'block', marginBottom: 4 }}>
                {t('workflow.mergePrefixLabel')}
              </Text>
              <Input
                value={localPrefix}
                onChange={(e) => handleMergeConfigChange('prefix', e.target.value)}
                placeholder={t('workflow.mergePrefixPlaceholder')}
              />
            </div>
            <div>
              <Text strong style={{ display: 'block', marginBottom: 4 }}>
                {t('workflow.mergeSuffixLabel')}
              </Text>
              <Input
                value={localSuffix}
                onChange={(e) => handleMergeConfigChange('suffix', e.target.value)}
                placeholder={t('workflow.mergeSuffixPlaceholder')}
              />
            </div>
          </>
        )}

        {nodeType === 'extract' && (
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
            <div style={{ marginBottom: 16 }}>
              <Text strong style={{ display: 'block', marginBottom: 4 }}>
                {t('workflow.extractSourceLabel')}
              </Text>
              <Select
                value={localExtractSourceNodeId}
                onChange={handleExtractSourceNodeChange}
                style={{ width: '100%' }}
                placeholder={t('workflow.extractSourcePlaceholder')}
                allowClear
                options={upstreamNodes.map((n) => ({
                  value: n.id,
                  label: (n.data as any).label || n.id,
                }))}
              />
              <Text type="secondary" style={{ fontSize: 11, display: 'block', marginTop: 4 }}>
                {t('workflow.extractSourceHint')}
              </Text>
            </div>
            <Divider style={{ margin: '12px 0' }} />
            <div>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
                <Text strong>{t('workflow.extractFieldsLabel')}</Text>
                <Button size="small" icon={<PlusOutlined />} onClick={handleAddExtractField}>
                  {t('workflow.addExtractField')}
                </Button>
              </div>
              <Text type="secondary" style={{ fontSize: 11, display: 'block', marginBottom: 8 }}>
                {t('workflow.extractFieldsHint')}
              </Text>
              {localExtractFields.length === 0 && (
                <Text type="secondary" style={{ fontSize: 12 }}>
                  {t('workflow.noExtractFields')}
                </Text>
              )}
              {localExtractFields.map((field, index) => (
                <div
                  key={index}
                  style={{
                    marginBottom: 12,
                    padding: 8,
                    border: `1px solid ${token.colorBorderSecondary}`,
                    borderRadius: 6,
                    background: token.colorBgLayout,
                  }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 4 }}>
                    <Input
                      size="small"
                      value={field.name}
                      onChange={(e) => handleExtractFieldChange(index, 'name', e.target.value)}
                      placeholder={t('workflow.extractFieldNamePlaceholder')}
                      style={{ flex: 1, marginRight: 4 }}
                    />
                    <Button
                      type="text"
                      danger
                      size="small"
                      icon={<DeleteOutlined />}
                      onClick={() => handleRemoveExtractField(index)}
                    />
                  </div>
                  <Input
                    size="small"
                    value={field.path}
                    onChange={(e) => handleExtractFieldChange(index, 'path', e.target.value)}
                    placeholder={t('workflow.extractPathPlaceholder')}
                    style={{ marginBottom: 4 }}
                  />
                  <Input
                    size="small"
                    value={field.defaultValue || ''}
                    onChange={(e) => handleExtractFieldChange(index, 'defaultValue', e.target.value)}
                    placeholder={t('workflow.extractDefaultPlaceholder')}
                  />
                </div>
              ))}
            </div>
          </>
        )}
      </div>
    </div>
  )
}

export default NodeConfigPanel
