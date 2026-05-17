import { useEffect, useState, useCallback, useRef } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import {
  Button,
  Space,
  Typography,
  Tag,
  Spin,
  Tooltip,
  Input,
  App,
  theme,
} from 'antd'
import {
  ArrowLeftOutlined,
  SaveOutlined,
  PlayCircleOutlined,
  StopOutlined,
  LayoutOutlined,
} from '@ant-design/icons'
import { FlowCanvas, NodeConfigPanel, ExecutionPanel } from '../components/workflow'
import { useTranslation } from 'react-i18next'
import { useWorkflowStore } from '../stores/workflow.store'

const { Text } = Typography

const WorkflowEditor: React.FC = () => {
  const { message } = App.useApp()
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const { token } = theme.useToken()
  const { t } = useTranslation()

  const [workflow, setWorkflow] = useState<any>(null)
  const [loading, setLoading] = useState(true)
  const [unsaved, setUnsaved] = useState(false)
  const [executionPanelCollapsed, setExecutionPanelCollapsed] = useState(true)
  const [isRunning, setIsRunning] = useState(false)
  const [editingName, setEditingName] = useState(false)
  const [nameValue, setNameValue] = useState('')

  const storeNodes = useWorkflowStore((s) => s.nodes)
  const storeEdges = useWorkflowStore((s) => s.edges)
  const loadFromWorkflow = useWorkflowStore((s) => s.loadFromWorkflow)
  const execution = useWorkflowStore((s) => s.execution)
  const setExecution = useWorkflowStore((s) => s.setExecution)
  const resetExecution = useWorkflowStore((s) => s.resetExecution)

  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    loadWorkflow()
    return () => {
      loadFromWorkflow({ nodes_json: '[]', edges_json: '[]' })
    }
  }, [id])

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 's') {
        e.preventDefault()
        handleSave()
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [storeNodes, storeEdges, workflow])

  useEffect(() => {
    if (!unsaved) return
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current)
    saveTimerRef.current = setTimeout(() => {
      handleSave()
    }, 3000)
    return () => {
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current)
    }
  }, [storeNodes, storeEdges])

  useEffect(() => {
    const cleanup = window.electronAPI.workflow.onExecutionProgress((data) => {
      if (data.status === 'completed' || data.status === 'failed' || data.status === 'aborted') {
        setIsRunning(false)
      }
    })
    return () => { cleanup() }
  }, [])

  const loadWorkflow = async () => {
    if (!id) return
    setLoading(true)
    try {
      const result = await window.electronAPI.workflow.get(id)
      if (!result) {
        message.error(t('workflow.loadFailed'))
        navigate('/workflows')
        return
      }
      setWorkflow(result)
      setNameValue(result.name)
      loadFromWorkflow(result)
      setUnsaved(false)
    } catch (error) {
      console.error('Failed to load workflow:', error)
      message.error(t('workflow.loadFailed'))
      navigate('/workflows')
    } finally {
      setLoading(false)
    }
  }

  const handleSave = useCallback(async () => {
    if (!id || !workflow) return
    try {
      await window.electronAPI.workflow.update({
        id,
        name: workflow.name,
        description: workflow.description,
        nodes: storeNodes,
        edges: storeEdges,
      })
      setUnsaved(false)
      message.success(t('workflow.saveSuccess'))
    } catch (error) {
      console.error('Failed to save workflow:', error)
      message.error(t('workflow.saveFailed'))
    }
  }, [id, workflow, storeNodes, storeEdges])

  const handleRun = async () => {
    if (!id) return
    if (isRunning) {
      if (execution?.id) {
        await window.electronAPI.workflow.abortExecution(execution.id)
      }
      resetExecution()
      setIsRunning(false)
      return
    }
    try {
      setIsRunning(true)
      setExecutionPanelCollapsed(false)
      const result = await window.electronAPI.workflow.execute(id)
      if (result.success) {
        message.success(t('workflow.runSuccess'))
        setExecution({
          id: result.executionId,
          status: 'running',
          nodeExecutions: {},
          startedAt: new Date().toISOString(),
        })
      } else {
        message.error(result.error || t('workflow.runFailed'))
        setIsRunning(false)
      }
    } catch (error) {
      console.error('Failed to run workflow:', error)
      message.error(t('workflow.runFailed'))
      setIsRunning(false)
    }
  }

  const handleNameSave = async () => {
    if (!nameValue.trim() || !id) return
    setEditingName(false)
    if (nameValue !== workflow.name) {
      try {
        await window.electronAPI.workflow.update({ id, name: nameValue })
        setWorkflow({ ...workflow, name: nameValue })
      } catch {
        setNameValue(workflow.name)
      }
    }
  }

  if (loading) {
    return (
      <div style={{ height: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <Spin size="large" />
      </div>
    )
  }

  return (
    <div style={{ height: '100vh', display: 'flex', flexDirection: 'column', background: token.colorBgContainer }}>
      <div style={{
        height: 48,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        padding: '0 20px',
        borderBottom: `1px solid ${token.colorBorderSecondary}`,
        background: token.colorBgContainer,
        flexShrink: 0,
      }}>
        <Space size={12}>
          <Tooltip title={t('workflow.back')}>
            <Button type="text" icon={<ArrowLeftOutlined />}
              onClick={() => navigate('/workflows')} style={{ fontSize: 16 }} />
          </Tooltip>
          {editingName ? (
            <Input
              size="small"
              value={nameValue}
              onChange={(e) => setNameValue(e.target.value)}
              onBlur={handleNameSave}
              onPressEnter={handleNameSave}
              autoFocus
              style={{ width: 200 }}
            />
          ) : (
            <Text
              strong
              style={{ fontSize: 15, cursor: 'pointer' }}
              onClick={() => setEditingName(true)}
            >
              {workflow?.name}
            </Text>
          )}
          {unsaved && (
            <Tag color="orange" style={{ fontSize: 11, lineHeight: '18px', padding: '0 6px' }}>
              {t('workflow.unsaved')}
            </Tag>
          )}
        </Space>
        <Space size={4}>
          <Tooltip title={executionPanelCollapsed ? t('workflow.executionPanel') : t('workflow.executionPanel')}>
            <Button
              type="text"
              icon={<LayoutOutlined />}
              size="small"
              onClick={() => setExecutionPanelCollapsed(!executionPanelCollapsed)}
              style={{ color: execution ? token.colorPrimary : undefined }}
            />
          </Tooltip>
          <Button
            type="primary"
            size="small"
            danger={isRunning}
            icon={isRunning ? <StopOutlined /> : <PlayCircleOutlined />}
            onClick={handleRun}
          >
            {isRunning ? t('workflow.stop') : t('workflow.run')}
          </Button>
          <Tooltip title={`${t('workflow.save')} (Ctrl+S)`}>
            <Button type="text" icon={<SaveOutlined />} size="small" onClick={handleSave} />
          </Tooltip>
        </Space>
      </div>

      <div style={{ flex: 1, display: 'flex', minHeight: 0 }}>
        <FlowCanvas />
        <NodeConfigPanel />
      </div>

      {!executionPanelCollapsed && (
        <div style={{
          borderTop: `1px solid ${token.colorBorderSecondary}`,
          background: token.colorBgContainer,
          maxHeight: 280,
          overflowY: 'auto',
        }}>
          <ExecutionPanel />
        </div>
      )}
    </div>
  )
}

export default WorkflowEditor
