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
  Switch,
  Modal,
} from 'antd'
import {
  ArrowLeftOutlined,
  SaveOutlined,
  PlayCircleOutlined,
  StopOutlined,
  LayoutOutlined,
  BugOutlined,
  StepForwardOutlined,
  FastForwardOutlined,
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
  const [runtimeInputValue, setRuntimeInputValue] = useState('')
  const [runtimeInputModalOpen, setRuntimeInputModalOpen] = useState(false)
  const pendingRuntimeResolveRef = useRef<((value: string) => void) | null>(null)

  const storeNodes = useWorkflowStore((s) => s.nodes)
  const storeEdges = useWorkflowStore((s) => s.edges)
  const loadFromWorkflow = useWorkflowStore((s) => s.loadFromWorkflow)
  const execution = useWorkflowStore((s) => s.execution)
  const setExecution = useWorkflowStore((s) => s.setExecution)
  const resetExecution = useWorkflowStore((s) => s.resetExecution)
  const updateNodeExecution = useWorkflowStore((s) => s.updateNodeExecution)
  const debug = useWorkflowStore((s) => s.debug)
  const setDebugEnabled = useWorkflowStore((s) => s.setDebugEnabled)
  const setDebugCurrentNode = useWorkflowStore((s) => s.setDebugCurrentNode)
  const setDebugPaused = useWorkflowStore((s) => s.setDebugPaused)

  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    loadWorkflow()
    return () => {
      loadFromWorkflow({ nodes_json: '[]', edges_json: '[]' })
    }
  }, [id])

  useEffect(() => {
    if (storeNodes.length > 0 || storeEdges.length > 0) {
      setUnsaved(true)
    }
  }, [storeNodes, storeEdges])

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
    const cleanupProgress = window.electronAPI.workflow.onExecutionProgress((data) => {
      if (data.status === 'completed' || data.status === 'failed' || data.status === 'aborted') {
        setIsRunning(false)
        setDebugPaused(false)
      }
      if (execution?.id === data.executionId) {
        const nodeExecutions: Record<string, any> = {}
        if (data.nodeExecutions) {
          for (const [nodeId, exec] of Object.entries(data.nodeExecutions)) {
            nodeExecutions[nodeId] = {
              nodeId,
              status: (exec as any).status,
              input: (exec as any).input || '',
              output: (exec as any).output || '',
              error: (exec as any).error || null,
              startedAt: (exec as any).started_at ? new Date((exec as any).started_at * 1000).toISOString() : null,
              completedAt: (exec as any).completed_at ? new Date((exec as any).completed_at * 1000).toISOString() : null,
            }
          }
        }
        setExecution({
          id: data.executionId,
          status: data.status,
          nodeExecutions,
          startedAt: execution?.startedAt || new Date().toISOString(),
        })
      }
    })
    return () => { cleanupProgress() }
  }, [execution?.id, execution?.startedAt, setExecution])

  useEffect(() => {
    const cleanupNodeUpdate = window.electronAPI.workflow.onNodeExecutionUpdate((data) => {
      if (execution?.id === data.executionId && data.nodeExecution) {
        const ne = data.nodeExecution
        updateNodeExecution(data.nodeId, {
          status: ne.status,
          input: ne.input || '',
          output: ne.output || '',
          error: ne.error || null,
          startedAt: ne.started_at ? new Date(ne.started_at * 1000).toISOString() : null,
          completedAt: ne.completed_at ? new Date(ne.completed_at * 1000).toISOString() : null,
        })
      }
    })
    return () => { cleanupNodeUpdate() }
  }, [execution?.id, updateNodeExecution])

  useEffect(() => {
    const cleanupDebugPaused = (window.electronAPI as any).workflow?.onDebugPaused?.((data: any) => {
      if (execution?.id === data.executionId) {
        setDebugCurrentNode(data.nodeId)
        setDebugPaused(true)
        if (data.nodeExecution) {
          updateNodeExecution(data.nodeId, {
            status: data.nodeExecution.status,
            input: data.nodeExecution.input || '',
            output: data.nodeExecution.output || '',
            error: data.nodeExecution.error || null,
            startedAt: data.nodeExecution.started_at ? new Date(data.nodeExecution.started_at * 1000).toISOString() : null,
            completedAt: data.nodeExecution.completed_at ? new Date(data.nodeExecution.completed_at * 1000).toISOString() : null,
          })
        }
      }
    })
    return () => { if (cleanupDebugPaused) cleanupDebugPaused() }
  }, [execution?.id, setDebugCurrentNode, setDebugPaused, updateNodeExecution])

  useEffect(() => {
    const cleanupRuntimeInput = (window.electronAPI as any).workflow?.onRuntimeInput?.((data: any) => {
      setRuntimeInputValue('')
      setRuntimeInputModalOpen(true)
      const resolve = (value: string) => {
        (window.electronAPI as any).workflow.respondRuntimeInput({
          executionId: data.executionId,
          nodeId: data.nodeId,
          value,
        })
      }
      pendingRuntimeResolveRef.current = resolve
    })
    return () => { if (cleanupRuntimeInput) cleanupRuntimeInput() }
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
      if (debug.enabled && execution?.id) {
        await (window.electronAPI as any).workflow?.debugStop?.(execution.id)
      } else if (execution?.id) {
        await window.electronAPI.workflow.abortExecution(execution.id)
      }
      resetExecution()
      setIsRunning(false)
      return
    }
    try {
      setIsRunning(true)
      setExecutionPanelCollapsed(false)
      let result
      if (debug.enabled) {
        result = await (window.electronAPI as any).workflow?.executeDebug?.(id)
      } else {
        result = await window.electronAPI.workflow.execute(id)
      }
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

  const handleDebugContinue = async () => {
    if (!execution?.id) return
    try {
      await (window.electronAPI as any).workflow?.debugContinue?.(execution.id)
      setDebugPaused(false)
    } catch {}
  }

  const handleDebugSkip = async () => {
    if (!execution?.id) return
    try {
      await (window.electronAPI as any).workflow?.debugSkip?.(execution.id)
      setDebugPaused(false)
    } catch {}
  }

  const handleDebugStop = async () => {
    if (!execution?.id) return
    try {
      await (window.electronAPI as any).workflow?.debugStop?.(execution.id)
      resetExecution()
      setIsRunning(false)
    } catch {}
  }

  const handleRuntimeInputSubmit = () => {
    if (pendingRuntimeResolveRef.current) {
      pendingRuntimeResolveRef.current(runtimeInputValue)
      pendingRuntimeResolveRef.current = null
    }
    setRuntimeInputModalOpen(false)
    setRuntimeInputValue('')
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
          <Tooltip title={debug.enabled ? t('workflow.debugModeOn') : t('workflow.debugModeOff')}>
            <Switch
              checked={debug.enabled}
              onChange={(checked) => setDebugEnabled(checked)}
              checkedChildren={<BugOutlined />}
              unCheckedChildren={<BugOutlined />}
              disabled={isRunning}
            />
          </Tooltip>
          {debug.enabled && isRunning && debug.paused && (
            <>
              <Tooltip title={t('workflow.debugContinue')}>
                <Button
                  type="primary"
                  size="small"
                  icon={<StepForwardOutlined />}
                  onClick={handleDebugContinue}
                >
                  {t('workflow.debugContinueBtn')}
                </Button>
              </Tooltip>
              <Tooltip title={t('workflow.debugSkip')}>
                <Button
                  size="small"
                  icon={<FastForwardOutlined />}
                  onClick={handleDebugSkip}
                >
                  {t('workflow.debugSkipBtn')}
                </Button>
              </Tooltip>
              <Button
                size="small"
                danger
                icon={<StopOutlined />}
                onClick={handleDebugStop}
              >
                {t('workflow.debugStopBtn')}
              </Button>
            </>
          )}
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

      <Modal
        title={t('workflow.runtimeInputTitle')}
        open={runtimeInputModalOpen}
        onOk={handleRuntimeInputSubmit}
        onCancel={() => {
          if (pendingRuntimeResolveRef.current) {
            pendingRuntimeResolveRef.current('')
            pendingRuntimeResolveRef.current = null
          }
          setRuntimeInputModalOpen(false)
          setRuntimeInputValue('')
        }}
        okText={t('workflow.runtimeInputSubmit')}
        cancelText={t('common.cancel')}
      >
        <Input.TextArea
          value={runtimeInputValue}
          onChange={(e) => setRuntimeInputValue(e.target.value)}
          rows={6}
          placeholder={t('workflow.runtimeInputPlaceholder')}
          autoFocus
        />
      </Modal>
    </div>
  )
}

export default WorkflowEditor
