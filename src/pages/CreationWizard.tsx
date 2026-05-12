import { useState, useEffect, useRef } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import {
  Card,
  Button,
  Steps,
  Checkbox,
  Tag,
  Typography,
  Space,
  Form,
  Input,
  Select,
  Switch,
  Empty,
  Divider,
  Alert,
  Descriptions,
  Badge,
  Progress,
  Timeline,
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
} from '@ant-design/icons'
import PageHeader from '../components/common/PageHeader'
import LLMSelector from '../components/llm/LLMSelector'
import type { LLMProvider } from '../types'
import { getProviderModels, getProviderModelOptions } from '../utils/llm'

const { Text, Title, Paragraph } = Typography
const { TextArea } = Input

interface EmployeeProfile {
  roleName: string
  roleDescription: string
  responsibilities: string[]
  personalityTraits: string[]
  workingStyle: string
  suggestedTools: string[]
}

const CreationWizard: React.FC = () => {
  const { t } = useTranslation()
  const { message } = App.useApp()
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const { token } = theme.useToken()
  const [currentStep, setCurrentStep] = useState(0)
  const [project, setProject] = useState<any>(null)
  const [linkedKBs, setLinkedKBs] = useState<any[]>([])
  const [selectedKBIds, setSelectedKBIds] = useState<string[]>([])
  const [profile, setProfile] = useState<EmployeeProfile | null>(null)
  const [providers, setProviders] = useState<LLMProvider[]>([])
  const [loading, setLoading] = useState(false)
  const [creating, setCreating] = useState(false)
  const [selectedProviderId, setSelectedProviderId] = useState<string>(() => {
    return localStorage.getItem('creationWizard:selectedProviderId') || ''
  })
  const [selectedModelId, setSelectedModelId] = useState<string>(() => {
    return localStorage.getItem('creationWizard:selectedModelId') || ''
  })
  const [enableThinking, setEnableThinking] = useState<boolean>(() => {
    return localStorage.getItem('creationWizard:enableThinking') === 'true'
  })
  const [businessDescription, setBusinessDescription] = useState<string>('')
  const [additionalResponsibilities, setAdditionalResponsibilities] = useState<string>('')
  const [step5ProviderId, setStep5ProviderId] = useState<string>('')

  // Persist selections to localStorage
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

  const [form] = Form.useForm()

  useEffect(() => {
    if (id) {
      loadProject()
      loadLinkedKBs()
      loadProviders()
    }
  }, [id])

  const loadProject = async () => {
    try {
      const result = await window.electronAPI.project.get(id!)
      setProject(result)
    } catch {
      message.error(t('creationWizard.loadProjectFailed'))
    }
  }

  const loadLinkedKBs = async () => {
    try {
      const result = await window.electronAPI.kb.getKBsForProject(id!)
      setLinkedKBs(result)
      setSelectedKBIds(result.map((kb: any) => kb.id))
    } catch {
      message.error(t('creationWizard.loadKbFailed'))
    }
  }

  const loadProviders = async () => {
    try {
      const result = await window.electronAPI.llm.getProviders()
      setProviders(result as LLMProvider[])
      const defaultProvider = (result as LLMProvider[]).find((p) => p.is_default)
      if (defaultProvider) {
        setSelectedProviderId(defaultProvider.id)
      }
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
      const enhancedDescription = [
        businessDescription,
        additionalResponsibilities ? `${t('creationWizard.extraDuties')} ${additionalResponsibilities}` : '',
      ].filter(Boolean).join('\n\n')

      const result = await window.electronAPI.employee.analyzeProfile({
        project_id: id!,
        kb_ids: selectedKBIds,
        provider_id: selectedProviderId || undefined,
        model_id: selectedModelId || undefined,
        additional_context: enhancedDescription || undefined,
        enable_thinking: enableThinking,
      })

      if (result.success && result.profile) {
        setProfile(result.profile)
        form.setFieldsValue({
          name: result.profile.roleName,
          description: result.profile.roleDescription,
        })

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

  const handleCreateEmployee = async () => {
    const values = await form.validateFields()
    setCreating(true)

    try {
      const employee = await window.electronAPI.employee.create({
        project_id: id!,
        name: values.name,
        description: values.description || '',
        profile_json: profile ? JSON.stringify({
          roleName: profile.roleName,
          roleDescription: profile.roleDescription,
          responsibilities: profile.responsibilities,
          personalityTraits: profile.personalityTraits,
          workingStyle: profile.workingStyle,
          suggestedTools: profile.suggestedTools,
        }) : undefined,
      })

      if (values.llm_provider_id) {
        await window.electronAPI.employee.update({
          id: employee.id,
          llm_provider_id: values.llm_provider_id,
          llm_model: values.llm_model,
          status: 'active',
        })
      }

      if (profile?.suggestedTools && profile.suggestedTools.length > 0) {
        try {
          const builtinTools = await window.electronAPI.tool.listBuiltin()
          for (const toolName of profile.suggestedTools) {
            try {
              const matchedTool = builtinTools.find((t: any) =>
                t.name === toolName || t.id === toolName
              )
              if (matchedTool) {
                await window.electronAPI.tool.assignToEmployee({
                  employee_id: employee.id,
                  tool_id: matchedTool.id,
                  is_enabled: true,
                })
              }
            } catch {
            }
          }
        } catch {
        }
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
    { title: t('creationWizard.stepSelectKb'), icon: <DatabaseOutlined /> },
    { title: t('creationWizard.stepBusinessDesc'), icon: <BulbOutlined /> },
    { title: t('creationWizard.stepAnalysis'), icon: <RobotOutlined /> },
    { title: t('creationWizard.stepComplete'), icon: <CheckOutlined /> },
  ]

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
      <Alert
        title={t('creationWizard.selectKbAlert')}
        description={t('creationWizard.selectKbAlertDesc')}
        type="info"
        showIcon
        style={{ marginBottom: 16 }}
      />

      <Card
        title={t('creationWizard.projectLinkedKb', { count: linkedKBs.length })}
        extra={
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
            <Button
              size="small"
              onClick={() => setSelectedKBIds(linkedKBs.map((kb: any) => kb.id))}
            >
              {t('common.selectAll')}
            </Button>
            <Button size="small" onClick={() => setSelectedKBIds([])}>
              {t('common.clearAll')}
            </Button>
          </Space>
        }
      >
        <div>
          {linkedKBs.map((kb: any) => {
            const isSelected = selectedKBIds.includes(kb.id)
            return (
              <div
                key={kb.id}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  padding: '12px 16px',
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
                      <DatabaseOutlined style={{ color: '#722ed1' }} />
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
        {linkedKBs.length === 0 && (
          <Empty description={t('creationWizard.noLinkedKb')}>
            <Button type="primary" onClick={() => navigate(`/project/${id}`)}>
              {t('creationWizard.goToLinkKb')}
            </Button>
          </Empty>
        )}
      </Card>
    </div>
  )

  const renderStep2 = () => (
    <div>
      <Alert
        title={t('creationWizard.businessDescAlert')}
        description={t('creationWizard.businessDescAlertDesc')}
        type="info"
        showIcon
        style={{ marginBottom: 24 }}
      />

      <Card title={t('creationWizard.businessDescCard')} style={{ marginBottom: 24 }}>
        <Paragraph type="secondary">{t('creationWizard.businessDescHint')}</Paragraph>
        <TextArea
          placeholder={t('creationWizard.businessDescPlaceholder')}
          value={businessDescription}
          onChange={(e) => setBusinessDescription(e.target.value)}
          rows={6}
        />
      </Card>

      <Card title={t('creationWizard.extraDutiesCard')}>
        <TextArea
          placeholder={t('creationWizard.extraDutiesPlaceholder')}
          value={additionalResponsibilities}
          onChange={(e) => setAdditionalResponsibilities(e.target.value)}
          rows={3}
        />
      </Card>
    </div>
  )

  const renderStep3 = () => (
    <div>
      {loading ? (
        <div style={{ padding: 24 }}>
          <Card title={t('creationWizard.analysisProgress')} style={{ marginBottom: 16 }}>
            <Progress percent={analyzeProgress} status={analyzeStage === 'error' ? 'exception' : 'active'} />
            <Timeline
              items={[
                { color: analyzeProgress >= 10 ? 'green' : 'gray', children: t('creationWizard.stepPrepare') },
                { color: analyzeProgress >= 30 ? 'green' : 'gray', children: t('creationWizard.stepCallLlm') },
                { color: analyzeProgress >= 45 ? 'green' : 'gray', children: t('creationWizard.stepLlmThinking') },
                { color: analyzeProgress >= 60 ? 'green' : 'gray', children: t('creationWizard.stepReceiveStream') },
                { color: analyzeProgress >= 90 ? 'green' : 'gray', children: t('creationWizard.stepParseResult') },
              ]}
            />
            {analyzeDetail && (
              <Alert title={analyzeDetail} type="info" showIcon style={{ marginTop: 12 }} />
            )}
          </Card>
          {analyzeThinkChunks.length > 0 && (
            <Card title={t('creationWizard.llmThinkingProcess')} size="small" style={{ marginBottom: 16, maxHeight: 200, overflow: 'auto' }}>
              <pre style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word', fontSize: 12, margin: 0, color: '#8c8c8c' }}>
                {analyzeThinkChunks.join('')}
              </pre>
            </Card>
          )}
          {analyzeChunks.length > 0 && (
            <Card title={t('creationWizard.llmRealtimeOutput')} size="small" style={{ maxHeight: 300, overflow: 'auto' }}>
              <pre style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word', fontSize: 12, margin: 0 }}>
                {analyzeChunks.join('')}
              </pre>
            </Card>
          )}
        </div>
      ) : profile ? (
        <>
          <Alert
            title={t('creationWizard.analysisComplete', { roleName: profile.roleName })}
            type="success"
            showIcon
            style={{ marginBottom: 16 }}
            action={
              <Button size="small" onClick={analyzeKBs} icon={<EditOutlined />}>
                {t('creationWizard.reAnalyze')}
              </Button>
            }
          />

          <Card style={{ marginBottom: 16 }}>
            <Descriptions title={t('creationWizard.employeeProfile')} bordered column={1} size="small">
              <Descriptions.Item label={t('creationWizard.roleName')}>
                <Space>
                  <UserOutlined />
                  <Text strong>{profile.roleName}</Text>
                </Space>
              </Descriptions.Item>
              <Descriptions.Item label={t('creationWizard.roleDesc')}>{profile.roleDescription}</Descriptions.Item>
              <Descriptions.Item label={t('creationWizard.workStyle')}>
                <Badge status="processing" text={profile.workingStyle} />
              </Descriptions.Item>
              <Descriptions.Item label={t('creationWizard.duties')}>
                <Space orientation="vertical" size={4}>
                  {profile.responsibilities.map((r, i) => (
                    <Text key={i}>· {r}</Text>
                  ))}
                </Space>
              </Descriptions.Item>
              <Descriptions.Item label={t('creationWizard.traits')}>
                <Space wrap>
                  {profile.personalityTraits.map((t, i) => (
                    <Tag key={i} color="blue">{t}</Tag>
                  ))}
                </Space>
              </Descriptions.Item>
              {profile.suggestedTools.length > 0 && (
                <Descriptions.Item label={t('creationWizard.suggestedTools')}>
                  <Space wrap>
                    {profile.suggestedTools.map((tool, i) => (
                      <Tag key={i} icon={<ToolOutlined />} color="orange">{tool}</Tag>
                    ))}
                  </Space>
                </Descriptions.Item>
              )}
            </Descriptions>
          </Card>
        </>
      ) : (
        <div style={{ textAlign: 'center', padding: 60 }}>
          <RobotOutlined style={{ fontSize: 48, marginBottom: 16, color: token.colorPrimary }} />
          <Paragraph>{t('creationWizard.clickToAnalyze')}</Paragraph>
          <Button type="primary" size="large" onClick={analyzeKBs} icon={<RobotOutlined />}>
            {t('creationWizard.startAnalysis')}
          </Button>
        </div>
      )}
    </div>
  )

  const renderStep5 = () => (
    <div>
      <Alert
        message={t('creationWizard.finalConfirm')}
        description={t('creationWizard.finalConfirmDesc')}
        type="info"
        showIcon
        style={{ marginBottom: 16 }}
      />

      <Form
        form={form}
        layout="vertical"
        initialValues={{
          review_mode: false,
        }}
      >
        <Form.Item
          name="name"
          label={t('creationWizard.employeeName')}
          rules={[{ required: true, message: t('creationWizard.enterName') }]}
        >
          <Input placeholder={t('creationWizard.namePlaceholder')} prefix={<UserOutlined />} />
        </Form.Item>

        <Form.Item name="description" label={t('common.description')}>
          <TextArea rows={3} placeholder={t('creationWizard.descPlaceholder')} />
        </Form.Item>

        <Form.Item name="llm_provider_id" label={t('creationWizard.llmProvider')}>
          <Select
            placeholder={t('creationWizard.selectProvider')}
            options={providers.map((p) => ({ value: p.id, label: p.name }))}
            allowClear
            onChange={(value) => {
              setStep5ProviderId(value || '')
              form.setFieldValue('llm_model', undefined)
            }}
          />
        </Form.Item>

        <Form.Item name="llm_model" label={t('creationWizard.modelName')}>
          {step5ProviderId && getProviderModels(providers.find(p => p.id === step5ProviderId)!).length > 0 ? (
            <Select
              placeholder={t('creationWizard.selectModel')}
              allowClear
              options={getProviderModelOptions(providers.find(p => p.id === step5ProviderId)!)}
            />
          ) : (
            <Input placeholder={t('creationWizard.modelPlaceholder')} />
          )}
        </Form.Item>

        <Form.Item name="review_mode" valuePropName="checked" label={t('creationWizard.manualReview')}>
          <Switch />
        </Form.Item>
        <Text type="secondary" style={{ display: 'block', marginTop: -16, marginBottom: 16 }}>
          {t('creationWizard.manualReviewDesc')}
        </Text>

        <Divider />

        <Title level={5}>{t('creationWizard.createSummary')}</Title>
        <Space orientation="vertical" style={{ width: '100%' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between' }}>
            <Text type="secondary">{t('creationWizard.selectedKb')}</Text>
            <Text>{selectedKBIds.length} {t('common.unit')}</Text>
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between' }}>
            <Text type="secondary">{t('creationWizard.identifiedRole')}</Text>
            <Text strong>{profile?.roleName || '-'}</Text>
          </div>
          {profile?.suggestedTools && profile.suggestedTools.length > 0 && (
            <div style={{ display: 'flex', justifyContent: 'space-between' }}>
              <Text type="secondary">{t('creationWizard.suggestedToolsLabel')}</Text>
              <Text>{profile.suggestedTools.join(', ')}</Text>
            </div>
          )}
        </Space>
      </Form>
    </div>
  )

  const handleNext = async () => {
    if (currentStep === 0) {
      if (selectedKBIds.length === 0) {
        message.warning(t('creationWizard.selectAtLeastOneKb'))
        return
      }
    }
    if (currentStep === 2 && !profile) {
      message.warning(t('creationWizard.completeAnalysisFirst'))
      return
    }
    setCurrentStep((prev) => Math.min(prev + 1, steps.length - 1))
  }

  const handlePrev = () => {
    setCurrentStep((prev) => Math.max(prev - 1, 0))
  }

  return (
    <div style={{ padding: 24, height: '100%', overflow: 'auto' }}>
      <PageHeader
        title={t('creationWizard.title')}
        subTitle={project?.name}
        onBack={() => navigate(`/project/${id}`)}
        breadcrumb={[{ title: t('creationWizard.breadcrumbDashboard') }, { title: project?.name || t('creationWizard.breadcrumbProject') }, { title: t('creationWizard.breadcrumbCreate') }]}
      />

      <Card style={{ marginBottom: 24 }}>
        <Steps current={currentStep} items={steps} />
      </Card>

      <Card style={{ marginBottom: 24, minHeight: 400 }}>
        {currentStep === 0 && renderStep1()}
        {currentStep === 1 && renderStep2()}
        {currentStep === 2 && renderStep3()}
        {currentStep === 3 && renderStep5()}
      </Card>

      <div style={{ display: 'flex', justifyContent: 'space-between' }}>
        <Button
          icon={<ArrowLeftOutlined />}
          onClick={handlePrev}
          disabled={currentStep === 0}
        >
          {t('common.prev')}
        </Button>

        {currentStep < steps.length - 1 ? (
          <Button
            type="primary"
            icon={<ArrowRightOutlined />}
            onClick={handleNext}
            loading={loading && currentStep === 2}
          >
            {t('common.next')}
          </Button>
        ) : (
          <Button
            type="primary"
            icon={<CheckOutlined />}
            onClick={handleCreateEmployee}
            loading={creating}
          >
            {t('common.finish')}
          </Button>
        )}
      </div>
    </div>
  )
}

export default CreationWizard
