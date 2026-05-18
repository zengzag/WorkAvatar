import { useState, useEffect, useRef } from 'react'
import { useNavigate } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import {
  Card,
  Button,
  Steps,
  Checkbox,
  Tag,
  Typography,
  Space,
  Input,
  Empty,
  Alert,
  Descriptions,
  Progress,
  Timeline,
  Tooltip,
  Modal,
  Collapse,
  theme,
  App,
} from 'antd'
import {
  DatabaseOutlined,
  RobotOutlined,
  ArrowLeftOutlined,
  ArrowRightOutlined,
  CheckOutlined,
  BulbOutlined,
  BulbFilled,
  UserOutlined,
  EditOutlined,
  ToolOutlined,
  CommentOutlined,
  ThunderboltOutlined,
} from '@ant-design/icons'
import PageHeader from '../components/common/PageHeader'
import LLMSelector from '../components/llm/LLMSelector'
import type { LLMProvider } from '../types'
import { getCachedSceneDefaultModel } from '../utils/default-model'

const { Text, Paragraph } = Typography
const { TextArea } = Input

interface EmployeeProfile {
  roleName: string
  roleDescription: string
  suggestedTools: string[]
}

const CreationWizard: React.FC = () => {
  const { t } = useTranslation()
  const { message } = App.useApp()
  const navigate = useNavigate()
  const { token } = theme.useToken()
  const [currentStep, setCurrentStep] = useState(0)
  const [allKBs, setAllKBs] = useState<any[]>([])
  const [selectedKBIds, setSelectedKBIds] = useState<string[]>([])
  const [profile, setProfile] = useState<EmployeeProfile | null>(null)
  const [providers, setProviders] = useState<LLMProvider[]>([])
  const [loading, setLoading] = useState(false)
  const [creating, setCreating] = useState(false)
  const [employeeName, setEmployeeName] = useState<string>('')
  const [selectedProviderId, setSelectedProviderId] = useState<string>(() => {
    return localStorage.getItem('creationWizard:selectedProviderId') || getCachedSceneDefaultModel('creation')?.provider_id || ''
  })
  const [selectedModelId, setSelectedModelId] = useState<string>(() => {
    return localStorage.getItem('creationWizard:selectedModelId') || getCachedSceneDefaultModel('creation')?.model_id || ''
  })
  const [enableThinking, setEnableThinking] = useState<boolean>(() => {
    return localStorage.getItem('creationWizard:enableThinking') === 'true'
  })
  const [businessDescription, setBusinessDescription] = useState<string>('')
  const [analysisMessages, setAnalysisMessages] = useState<Array<{ role: string; content: string }>>([])
  const [refineModalOpen, setRefineModalOpen] = useState(false)
  const [refineFeedback, setRefineFeedback] = useState('')
  const [builtinTools, setBuiltinTools] = useState<any[]>([])
  const [selectedToolIds, setSelectedToolIds] = useState<string[]>([])

  useEffect(() => {
    localStorage.setItem('creationWizard:selectedProviderId', selectedProviderId)
  }, [selectedProviderId])
  useEffect(() => {
    localStorage.setItem('creationWizard:selectedModelId', selectedModelId)
  }, [selectedModelId])
  useEffect(() => {
    localStorage.setItem('creationWizard:enableThinking', String(enableThinking))
  }, [enableThinking])

  const [analyzeStage, setAnalyzeStage] = useState<string>('')
  const [analyzeDetail, setAnalyzeDetail] = useState<string>('')
  const [analyzeChunks, setAnalyzeChunks] = useState<string[]>([])
  const [analyzeThinkChunks, setAnalyzeThinkChunks] = useState<string[]>([])
  const [analyzeProgress, setAnalyzeProgress] = useState<number>(0)
  const progressCleanupRef = useRef<(() => void) | null>(null)

  useEffect(() => {
    return () => {
      if (progressCleanupRef.current) {
        progressCleanupRef.current()
        progressCleanupRef.current = null
      }
    }
  }, [])

  useEffect(() => {
    if (currentStep === 1 && profile) {
      setEmployeeName(profile.roleName)
    }
  }, [currentStep, profile])

  useEffect(() => {
    loadProviders()
    loadAllKBs()
    loadBuiltinTools()
  }, [])

  const loadAllKBs = async () => {
    try {
      const result = await window.electronAPI.kb.list()
      setAllKBs(result)
    } catch {
      message.error(t('creationWizard.loadKbFailed'))
    }
  }

  const loadProviders = async () => {
    try {
      const result = await window.electronAPI.llm.getProviders()
      setProviders(result as LLMProvider[])
      const sceneDefault = getCachedSceneDefaultModel('creation')
      if (sceneDefault?.provider_id && !localStorage.getItem('creationWizard:selectedProviderId')) {
        setSelectedProviderId(sceneDefault.provider_id)
        if (sceneDefault.model_id && !localStorage.getItem('creationWizard:selectedModelId')) {
          setSelectedModelId(sceneDefault.model_id)
        }
      } else if (!selectedProviderId) {
        const defaultProvider = (result as LLMProvider[]).find((p) => p.is_default)
        if (defaultProvider) {
          setSelectedProviderId(defaultProvider.id)
        }
      }
    } catch {}
  }

  const loadBuiltinTools = async () => {
    try {
      const result = await window.electronAPI.tool.listBuiltin()
      setBuiltinTools(result)
      const defaultToolIds = result
        .filter((tool: any) =>
          tool.name === 'kb_search' ||
          tool.name === 'read_file' ||
          tool.name === 'write_file'
        )
        .map((tool: any) => tool.id)
      setSelectedToolIds(defaultToolIds)
    } catch {}
  }

  const analyzeKBs = async () => {
    setLoading(true)
    setAnalyzeStage('')
    setAnalyzeDetail('')
    setAnalyzeChunks([])
    setAnalyzeThinkChunks([])
    setAnalyzeProgress(0)

    if (progressCleanupRef.current) {
      progressCleanupRef.current()
    }
    progressCleanupRef.current = window.electronAPI.employee.onProfileProgress((data) => {
      setAnalyzeStage(data.stage)
      if (data.detail) setAnalyzeDetail(data.detail)
      if (data.chunk) {
        if (data.stage === 'thinking') {
          setAnalyzeThinkChunks((prev) => [...prev, data.chunk!])
        } else {
          setAnalyzeChunks((prev) => [...prev, data.chunk!])
        }
      }
      const stageMap: Record<string, number> = {
        preparing: 10,
        llm_calling: 30,
        thinking: 45,
        streaming: 60,
        parsing: 90,
        done: 100,
        error: 100,
      }
      setAnalyzeProgress(stageMap[data.stage] ?? 50)
    })

    try {
      const enhancedDescription = businessDescription || undefined

      const result = await window.electronAPI.employee.analyzeProfile({
        kb_ids: selectedKBIds,
        provider_id: selectedProviderId || undefined,
        model_id: selectedModelId || undefined,
        additional_context: enhancedDescription || undefined,
      })

      if (result.success && result.profile) {
        setProfile(result.profile)
        if (result.messages) {
          setAnalysisMessages(result.messages)
        }

        if (result.profile.suggestedTools && result.profile.suggestedTools.length > 0 && builtinTools.length > 0) {
          const suggestedSet = new Set(result.profile.suggestedTools.map((s: string) => s.toLowerCase()))
          const matchedIds = builtinTools
            .filter((tool: any) => suggestedSet.has((tool.name || '').toLowerCase()))
            .map((tool: any) => tool.id)
          if (matchedIds.length > 0) {
            setSelectedToolIds((prev) => {
              const existing = new Set([...prev, ...matchedIds])
              return Array.from(existing)
            })
          }
        }

        if (result.analysisMethod === 'llm') {
          message.success(t('creationWizard.llmAnalysisComplete'))
        } else if (result.analysisMethod === 'heuristic') {
          if (result.error) {
            message.warning(result.error)
          } else {
            message.info(t('creationWizard.heuristicAnalysis'))
          }
        } else {
          message.info(t('creationWizard.defaultConfig'))
        }
      } else {
        message.error(result.error || t('creationWizard.analysisFailed'))
      }
    } catch {
      message.error(t('creationWizard.analyzeKbFailed'))
    } finally {
      setLoading(false)
      if (progressCleanupRef.current) {
        progressCleanupRef.current()
        progressCleanupRef.current = null
      }
    }
  }

  const handleRefineProfile = async () => {
    if (!refineFeedback.trim()) {
      message.warning(t('creationWizard.enterRefineFeedback'))
      return
    }
    if (!profile) return

    const providerId = selectedProviderId || providers.find((p) => p.is_default)?.id
    if (!providerId) {
      message.warning(t('creationWizard.noProviderForRefine'))
      return
    }

    setRefineModalOpen(false)
    setLoading(true)
    setAnalyzeStage('')
    setAnalyzeDetail('')
    setAnalyzeChunks([])
    setAnalyzeThinkChunks([])
    setAnalyzeProgress(0)

    if (progressCleanupRef.current) {
      progressCleanupRef.current()
    }
    progressCleanupRef.current = window.electronAPI.employee.onProfileProgress((data) => {
      setAnalyzeStage(data.stage)
      if (data.detail) setAnalyzeDetail(data.detail)
      if (data.chunk) {
        if (data.stage === 'thinking') {
          setAnalyzeThinkChunks((prev) => [...prev, data.chunk!])
        } else {
          setAnalyzeChunks((prev) => [...prev, data.chunk!])
        }
      }
      const stageMap: Record<string, number> = {
        preparing: 10,
        llm_calling: 30,
        thinking: 45,
        streaming: 60,
        parsing: 90,
        done: 100,
        error: 100,
      }
      setAnalyzeProgress(stageMap[data.stage] ?? 50)
    })

    try {
      const result = await window.electronAPI.employee.refineProfile({
        previous_messages: analysisMessages,
        previous_profile: {
          roleName: profile.roleName,
          roleDescription: profile.roleDescription,
          suggestedTools: profile.suggestedTools,
        },
        feedback: refineFeedback,
        provider_id: providerId,
        model_id: selectedModelId || undefined,
      })

      if (result.success && result.profile) {
        setProfile(result.profile)
        if (result.messages) {
          setAnalysisMessages(result.messages)
        }
        if (result.profile.suggestedTools && result.profile.suggestedTools.length > 0 && builtinTools.length > 0) {
          const suggestedSet = new Set(result.profile.suggestedTools.map((s: string) => s.toLowerCase()))
          const matchedIds = builtinTools
            .filter((tool: any) => suggestedSet.has((tool.name || '').toLowerCase()))
            .map((tool: any) => tool.id)
          if (matchedIds.length > 0) {
            setSelectedToolIds((prev) => {
              const existing = new Set([...prev, ...matchedIds])
              return Array.from(existing)
            })
          }
        }
        if (result.error) {
          message.warning(result.error)
        } else {
          message.success(t('creationWizard.refineComplete'))
        }
      } else {
        message.error(result.error || t('creationWizard.refineFailed'))
      }
    } catch {
      message.error(t('creationWizard.refineFailed'))
    } finally {
      setLoading(false)
      setRefineFeedback('')
      if (progressCleanupRef.current) {
        progressCleanupRef.current()
        progressCleanupRef.current = null
      }
    }
  }

  const handleQuickCreate = async () => {
    setCreating(true)
    try {
      const employee = await window.electronAPI.employee.create({
        name: t('creationWizard.quickCreateDefaultName'),
        description: '',
      })

      if (selectedProviderId) {
        await window.electronAPI.employee.update({
          id: employee.id,
          llm_provider_id: selectedProviderId,
          llm_model: selectedModelId,
          status: 'active',
        })
      }

      for (const toolId of selectedToolIds) {
        try {
          await window.electronAPI.tool.assignToEmployee({
            employee_id: employee.id,
            tool_id: toolId,
            is_enabled: true,
          })
        } catch {}
      }

      for (const kbId of selectedKBIds) {
        try {
          await window.electronAPI.employee.linkKB({ employee_id: employee.id, kb_id: kbId })
        } catch {}
      }

      navigate(`/employee/${employee.id}`)
    } catch (error) {
      message.error(t('creationWizard.createFailed'))
      console.error(error)
    } finally {
      setCreating(false)
    }
  }

  const handleCreateEmployee = async () => {
    if (!employeeName.trim()) {
      message.warning(t('creationWizard.enterName'))
      return
    }
    setCreating(true)

    try {
      const employee = await window.electronAPI.employee.create({
        name: employeeName,
        description: profile?.roleDescription || businessDescription || '',
        profile_json: profile ? JSON.stringify({
          roleName: profile.roleName,
          roleDescription: profile.roleDescription,
          suggestedTools: profile.suggestedTools,
        }) : undefined,
      })

      if (selectedProviderId) {
        await window.electronAPI.employee.update({
          id: employee.id,
          llm_provider_id: selectedProviderId,
          llm_model: selectedModelId,
          status: 'active',
        })
      }

      for (const toolId of selectedToolIds) {
        try {
          await window.electronAPI.tool.assignToEmployee({
            employee_id: employee.id,
            tool_id: toolId,
            is_enabled: true,
          })
        } catch {}
      }

      for (const kbId of selectedKBIds) {
        try {
          await window.electronAPI.employee.linkKB({ employee_id: employee.id, kb_id: kbId })
        } catch {}
      }

      navigate(`/employee/${employee.id}`)
    } catch (error) {
      message.error(t('creationWizard.createFailed'))
      console.error(error)
    } finally {
      setCreating(false)
    }
  }

  const steps = [
    { title: t('creationWizard.stepBasicConfig'), icon: <DatabaseOutlined /> },
    { title: t('creationWizard.stepConfirmCreate'), icon: <CheckOutlined /> },
  ]

  const displayKBs = allKBs

  const renderStep1 = () => (
    <div>
      {providers.length === 0 && (
        <Alert
          title={t('creationWizard.noLlmAlert')}
          description={t('creationWizard.noLlmAlertDesc')}
          type="warning"
          showIcon
          style={{ marginBottom: 16 }}
        />
      )}

      <Card style={{ marginBottom: 16 }}>
        <Space orientation="vertical" size={16} style={{ width: '100%' }}>
          <div>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
              <Text strong>{t('creationWizard.linkedKbLabel')}</Text>
              <Space>
                <Button
                  size="small"
                  onClick={() => setSelectedKBIds(displayKBs.map((kb: any) => kb.id))}
                >
                  {t('common.selectAll')}
                </Button>
                <Button size="small" onClick={() => setSelectedKBIds([])}>
                  {t('common.clearAll')}
                </Button>
              </Space>
            </div>
            {displayKBs.length > 0 ? (
              <div style={{ border: `1px solid ${token.colorBorderSecondary}`, borderRadius: token.borderRadius }}>
                {displayKBs.map((kb: any) => {
                  const isSelected = selectedKBIds.includes(kb.id)
                  return (
                    <div
                      key={kb.id}
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        padding: '10px 16px',
                        background: isSelected ? token.colorPrimaryBg : 'transparent',
                        borderBottom: `1px solid ${token.colorBorderSecondary}`,
                      }}
                    >
                      <Checkbox
                        checked={isSelected}
                        onChange={(e) => {
                          if (e.target.checked) {
                            setSelectedKBIds((prev) => [...prev, kb.id])
                          } else {
                            setSelectedKBIds((prev) => prev.filter((i) => i !== kb.id))
                          }
                        }}
                        style={{ marginRight: 12 }}
                      />
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ marginBottom: 2 }}>
                          <Space>
                            <DatabaseOutlined style={{ color: token.colorPrimary }} />
                            <Text strong>{kb.name}</Text>
                            <Tag>{t('common.documents', { count: kb.doc_count || 0 })}</Tag>
                          </Space>
                        </div>
                        <Text type="secondary" style={{ fontSize: 12 }}>
                          {kb.description || t('common.noDescription')}
                        </Text>
                      </div>
                    </div>
                  )
                })}
              </div>
            ) : (
              <Empty description={t('creationWizard.noKbAvailable')} />
            )}
          </div>

          <div>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
              <Text strong>{t('creationWizard.llmModelLabel')}</Text>
              <Space>
                <LLMSelector
                  providerId={selectedProviderId}
                  modelId={selectedModelId}
                  onProviderChange={setSelectedProviderId}
                  onModelChange={setSelectedModelId}
                />
                <Tooltip title={enableThinking ? t('llmSelector.thinkingEnabled') : t('llmSelector.thinkingDisabled')}>
                  <Button
                    type={enableThinking ? 'primary' : 'text'}
                    icon={enableThinking ? <BulbFilled /> : <BulbOutlined />}
                    size="small"
                    onClick={() => setEnableThinking(!enableThinking)}
                    style={enableThinking ? {} : { color: token.colorTextSecondary }}
                  />
                </Tooltip>
              </Space>
            </div>
          </div>

          <div>
            <Text strong style={{ display: 'block', marginBottom: 8 }}>
              {t('creationWizard.businessSceneDesc')}
            </Text>
            <TextArea
              placeholder={t('creationWizard.businessScenePlaceholder')}
              value={businessDescription}
              onChange={(e) => setBusinessDescription(e.target.value)}
              rows={4}
            />
          </div>
        </Space>
      </Card>
    </div>
  )

  const renderAnalysisProgress = () => (
    <Card title={t('creationWizard.analysisProgress')} style={{ marginBottom: 16 }}>
      <Progress percent={analyzeProgress} status={analyzeStage === 'error' ? 'exception' : 'active'} />
      <Timeline
        items={[
          { color: analyzeProgress >= 10 ? 'green' : 'gray', content: t('creationWizard.stepPrepare') },
          { color: analyzeProgress >= 30 ? 'green' : 'gray', content: t('creationWizard.stepCallLlm') },
          { color: analyzeProgress >= 45 ? 'green' : 'gray', content: t('creationWizard.stepLlmThinking') },
          { color: analyzeProgress >= 60 ? 'green' : 'gray', content: t('creationWizard.stepReceiveStream') },
          { color: analyzeProgress >= 90 ? 'green' : 'gray', content: t('creationWizard.stepParseResult') },
        ]}
      />
      {analyzeDetail && (
        <Alert title={analyzeDetail} type="info" showIcon style={{ marginTop: 12 }} />
      )}
    </Card>
  )

  const renderAnalysisStreaming = () => (
    <>
      {analyzeThinkChunks.length > 0 && (
        <Card title={t('creationWizard.llmThinkingProcess')} size="small" style={{ marginBottom: 16, maxHeight: 200, overflow: 'auto' }}>
          <pre style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word', fontSize: 12, margin: 0, color: '#8c8c8c' }}>
            {analyzeThinkChunks.join('')}
          </pre>
        </Card>
      )}
      {analyzeChunks.length > 0 && (
        <Card title={t('creationWizard.llmRealtimeOutput')} size="small" style={{ marginBottom: 16, maxHeight: 300, overflow: 'auto' }}>
          <pre style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word', fontSize: 12, margin: 0 }}>
            {analyzeChunks.join('')}
          </pre>
        </Card>
      )}
    </>
  )

  const renderProfileDisplay = () => (
    <>
      <Alert
        title={t('creationWizard.analysisComplete', { roleName: profile!.roleName })}
        type="success"
        showIcon
        style={{ marginBottom: 16 }}
        action={
          <Space>
            <Button size="small" onClick={analyzeKBs} icon={<EditOutlined />}>
              {t('creationWizard.reAnalyze')}
            </Button>
            {analysisMessages.length > 0 && (
              <Button size="small" onClick={() => setRefineModalOpen(true)} icon={<CommentOutlined />}>
                {t('creationWizard.refineProfile')}
              </Button>
            )}
          </Space>
        }
      />

      <Card style={{ marginBottom: 16 }}>
        <Descriptions title={t('creationWizard.employeeProfile')} bordered column={1} size="small">
          <Descriptions.Item label={t('creationWizard.roleName')}>
            <Space>
              <UserOutlined />
              <Text strong>{profile!.roleName}</Text>
            </Space>
          </Descriptions.Item>
          <Descriptions.Item label={t('creationWizard.roleDesc')}>{profile!.roleDescription}</Descriptions.Item>
          {profile!.suggestedTools.length > 0 && (
            <Descriptions.Item label={t('creationWizard.suggestedTools')}>
              <Space wrap>
                {profile!.suggestedTools.map((tool, i) => {
                  const found = builtinTools.find((bt: any) => bt.name === tool)
                  return (
                    <Tag key={i} icon={<ToolOutlined />} color="orange">
                      {found ? (found.title || found.name) : tool}
                    </Tag>
                  )
                })}
              </Space>
            </Descriptions.Item>
          )}
        </Descriptions>
      </Card>
    </>
  )

  const renderToolCheckboxes = () => (
    <div>
      <Text strong style={{ display: 'block', marginBottom: 8 }}>
        <ToolOutlined style={{ marginRight: 4 }} />
        {t('creationWizard.toolsHint')}
      </Text>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
        {builtinTools.map((tool: any) => (
          <Checkbox
            key={tool.id}
            checked={selectedToolIds.includes(tool.id)}
            onChange={(e) => {
              if (e.target.checked) {
                setSelectedToolIds((prev) => [...prev, tool.id])
              } else {
                setSelectedToolIds((prev) => prev.filter((id) => id !== tool.id))
              }
            }}
          >
            {tool.title || tool.name}
          </Checkbox>
        ))}
      </div>
    </div>
  )

  const renderStep2 = () => (
    <div>
      <Alert
        title={t('creationWizard.confirmCreateDesc')}
        type="info"
        showIcon
        style={{ marginBottom: 16 }}
      />

      <div style={{ marginBottom: 16 }}>
        <Text strong style={{ display: 'block', marginBottom: 8 }}>
          {t('creationWizard.employeeNameLabel')} <Text type="danger">*</Text>
        </Text>
        <Input
          placeholder={t('creationWizard.employeeNamePlaceholder')}
          prefix={<UserOutlined />}
          value={employeeName}
          onChange={(e) => setEmployeeName(e.target.value)}
        />
      </div>

      {loading ? (
        <div style={{ padding: '0 0 16px' }}>
          {renderAnalysisProgress()}
          {renderAnalysisStreaming()}
        </div>
      ) : profile ? (
        renderProfileDisplay()
      ) : (
        <div style={{ textAlign: 'center', padding: 40 }}>
          <RobotOutlined style={{ fontSize: 48, marginBottom: 16, color: token.colorPrimary }} />
          <Paragraph>{t('creationWizard.clickToAnalyze')}</Paragraph>
          <Button type="primary" size="large" onClick={analyzeKBs} icon={<RobotOutlined />}>
            {t('creationWizard.startAnalysis')}
          </Button>
        </div>
      )}

      <Collapse
        style={{ marginBottom: 16 }}
        items={[
          {
            key: 'tools',
            label: t('creationWizard.toolSettings'),
            children: renderToolCheckboxes(),
          },
        ]}
      />

      <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
        <Button
          type="primary"
          icon={<CheckOutlined />}
          onClick={handleCreateEmployee}
          loading={creating}
          disabled={!employeeName.trim()}
          size="large"
        >
          {t('creationWizard.createButton')}
        </Button>
      </div>
    </div>
  )

  const handleNext = async () => {
    if (currentStep === 0) {
      setCurrentStep(1)
      analyzeKBs()
    }
  }

  const handlePrev = () => {
    setCurrentStep((prev) => Math.max(prev - 1, 0))
  }

  const breadcrumbItems = [
    { title: t('creationWizard.breadcrumbDigitalEmployees'), onClick: () => navigate('/') },
    { title: t('creationWizard.breadcrumbCreate') },
  ]

  return (
    <div style={{ padding: 24, height: '100%', overflow: 'auto' }}>
      <PageHeader
        title={t('creationWizard.title')}
        onBack={() => navigate('/')}
        breadcrumb={breadcrumbItems}
      />

      <Card style={{ marginBottom: 24 }}>
        <Steps current={currentStep} items={steps} />
      </Card>

      <Card style={{ marginBottom: 16, minHeight: 400 }}>
        {currentStep === 0 && renderStep1()}
        {currentStep === 1 && renderStep2()}
      </Card>

      {currentStep === 0 && (
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <Button
            icon={<ThunderboltOutlined />}
            onClick={handleQuickCreate}
            loading={creating}
          >
            {t('creationWizard.quickCreate')}
          </Button>
          <Button
            type="primary"
            icon={<ArrowRightOutlined />}
            onClick={handleNext}
          >
            {t('common.next')}
          </Button>
        </div>
      )}

      {currentStep === 1 && (
        <div style={{ display: 'flex', justifyContent: 'flex-start' }}>
          <Button
            icon={<ArrowLeftOutlined />}
            onClick={handlePrev}
          >
            {t('common.prev')}
          </Button>
        </div>
      )}

      <Modal
        title={t('creationWizard.refineModalTitle')}
        open={refineModalOpen}
        onOk={handleRefineProfile}
        onCancel={() => { setRefineModalOpen(false); setRefineFeedback('') }}
        okText={t('creationWizard.refineSubmit')}
        cancelText={t('common.cancel')}
        okButtonProps={{ disabled: !refineFeedback.trim() }}
        width={600}
      >
        <Paragraph type="secondary" style={{ marginBottom: 16 }}>
          {t('creationWizard.refineModalDesc')}
        </Paragraph>
        <TextArea
          placeholder={t('creationWizard.refinePlaceholder')}
          value={refineFeedback}
          onChange={(e) => setRefineFeedback(e.target.value)}
          rows={6}
          autoFocus
        />
      </Modal>
    </div>
  )
}

export default CreationWizard
