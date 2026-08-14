import { useState, useEffect, useRef } from 'react'
import { useNavigate } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import {
  Card,
  Button,
  Steps,
  Typography,
  Space,
  Input,
  Alert,
  Collapse,
  Modal,
  theme,
  App,
} from 'antd'
import {
  DatabaseOutlined,
  RobotOutlined,
  ArrowLeftOutlined,
  ArrowRightOutlined,
  CheckOutlined,
  UserOutlined,
  ThunderboltOutlined,
} from '@ant-design/icons'
import PageHeader from '../components/common/PageHeader'
import LLMSelector from '../components/llm/LLMSelector'
import type { LLMProvider } from '../types'
import { getCachedSceneDefaultModel } from '../utils/default-model'
import {
  CollectionSelector,
  AnalysisProgress,
  AnalysisStreaming,
  ProfileDisplay,
  ToolCheckboxes,
  type EmployeeProfile,
  STAGE_PROGRESS_MAP,
  DEFAULT_TOOL_NAMES,
  matchSuggestedToolIds,
  mergeToolIds,
} from './creation-wizard'

const { Text, Paragraph } = Typography
const { TextArea } = Input

const CreationWizard: React.FC = () => {
  const { t } = useTranslation()
  const { message } = App.useApp()
  const navigate = useNavigate()
  const { token } = theme.useToken()
  const [currentStep, setCurrentStep] = useState(0)
  const [allCollections, setAllCollections] = useState<any[]>([])
  const [selectedCollectionIds, setSelectedCollectionIds] = useState<string[]>([])
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
  const [businessDescription, setBusinessDescription] = useState<string>('')
  const [analysisMessages, setAnalysisMessages] = useState<Array<{ role: string; content: string }>>([])
  const [refineModalOpen, setRefineModalOpen] = useState(false)
  const [refineFeedback, setRefineFeedback] = useState('')
  const [builtinTools, setBuiltinTools] = useState<any[]>([])
  const [selectedToolIds, setSelectedToolIds] = useState<string[]>([])

  const handleLlmChange = (pId: string, mId: string) => {
    setSelectedProviderId(pId)
    setSelectedModelId(mId)
  }

  useEffect(() => {
    localStorage.setItem('creationWizard:selectedProviderId', selectedProviderId)
    localStorage.setItem('creationWizard:selectedModelId', selectedModelId)
  }, [selectedProviderId, selectedModelId])

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
    loadAllCollections()
    loadBuiltinTools()
  }, [])

  const loadAllCollections = async () => {
    try {
      const result = await window.electronAPI.kms.listCollections()
      // safeHandle 异常时返回 { error }（truthy 但非数组），需 Array.isArray 兜底
      setAllCollections(Array.isArray(result) ? result : [])
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
        .filter((tool: any) => DEFAULT_TOOL_NAMES.includes(tool.name))
        .map((tool: any) => tool.id)
      setSelectedToolIds(defaultToolIds)
    } catch {}
  }

  /** 设置进度回调，返回清理函数 */
  const setupProgressCallback = () => {
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
      setAnalyzeProgress(STAGE_PROGRESS_MAP[data.stage] ?? 50)
    })
  }

  /** 重置分析状态 */
  const resetAnalyzeState = () => {
    setAnalyzeStage('')
    setAnalyzeDetail('')
    setAnalyzeChunks([])
    setAnalyzeThinkChunks([])
    setAnalyzeProgress(0)
  }

  /** 处理分析结果：更新 profile、消息、工具匹配 */
  const handleAnalysisResult = (result: any) => {
    if (result.success && result.profile) {
      setProfile(result.profile)
      if (result.messages) {
        setAnalysisMessages(result.messages)
      }
      const matchedIds = matchSuggestedToolIds(result.profile.suggestedTools || [], builtinTools)
      if (matchedIds.length > 0) {
        setSelectedToolIds((prev) => mergeToolIds(prev, matchedIds))
      }
      return true
    }
    message.error(result.error || t('creationWizard.analysisFailed'))
    return false
  }

  /** 清理进度回调 */
  const cleanupProgress = () => {
    if (progressCleanupRef.current) {
      progressCleanupRef.current()
      progressCleanupRef.current = null
    }
  }

  const analyzeKBs = async () => {
    setLoading(true)
    resetAnalyzeState()
    setupProgressCallback()

    try {
      const result = await window.electronAPI.employee.analyzeProfile({
        collection_ids: selectedCollectionIds,
        provider_id: selectedProviderId || undefined,
        model_id: selectedModelId || undefined,
        additional_context: businessDescription || undefined,
      })

      if (handleAnalysisResult(result)) {
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
      }
    } catch {
      message.error(t('creationWizard.analyzeKbFailed'))
    } finally {
      setLoading(false)
      cleanupProgress()
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
    resetAnalyzeState()
    setupProgressCallback()

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

      if (handleAnalysisResult(result)) {
        if (result.error) {
          message.warning(result.error)
        } else {
          message.success(t('creationWizard.refineComplete'))
        }
      }
    } catch {
      message.error(t('creationWizard.refineFailed'))
    } finally {
      setLoading(false)
      setRefineFeedback('')
      cleanupProgress()
    }
  }

  /** 创建员工并分配工具 */
  const createEmployeeWithTools = async (name: string, description: string, profileJson?: string) => {
    const employee = await window.electronAPI.employee.create({
      name,
      description,
      profile_json: profileJson,
    })

    for (const toolId of selectedToolIds) {
      try {
        await window.electronAPI.tool.assignToEmployee({
          employee_id: employee.id,
          tool_id: toolId,
          is_enabled: true,
        })
      } catch {}
    }

    return employee
  }

  const handleQuickCreate = async () => {
    setCreating(true)
    try {
      await createEmployeeWithTools(
        t('creationWizard.quickCreateDefaultName'),
        '',
      )
      navigate('/employees')
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
      const profileJson = profile ? JSON.stringify({
        roleName: profile.roleName,
        roleDescription: profile.roleDescription,
        suggestedTools: profile.suggestedTools,
      }) : undefined
      const description = profile?.roleDescription || businessDescription || ''

      await createEmployeeWithTools(employeeName, description, profileJson)
      navigate('/employees')
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
          <CollectionSelector
            collections={allCollections}
            selectedIds={selectedCollectionIds}
            onChange={setSelectedCollectionIds}
          />

          <div>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
              <Text strong>{t('creationWizard.llmModelLabel')}</Text>
              <Space>
                <LLMSelector
                  providerId={selectedProviderId}
                  modelId={selectedModelId}
                  onChange={handleLlmChange}
                />
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
          <AnalysisProgress progress={analyzeProgress} stage={analyzeStage} detail={analyzeDetail} />
          <AnalysisStreaming thinkChunks={analyzeThinkChunks} contentChunks={analyzeChunks} />
        </div>
      ) : profile ? (
        <ProfileDisplay
          profile={profile}
          builtinTools={builtinTools}
          hasAnalysisMessages={analysisMessages.length > 0}
          onReAnalyze={analyzeKBs}
          onRefine={() => setRefineModalOpen(true)}
        />
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
            children: <ToolCheckboxes
              tools={builtinTools}
              selectedIds={selectedToolIds}
              onChange={setSelectedToolIds}
            />,
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
    { title: t('creationWizard.breadcrumbDigitalEmployees'), onClick: () => navigate('/employees') },
    { title: t('creationWizard.breadcrumbCreate') },
  ]

  return (
    <div style={{ padding: 16, height: '100%', overflow: 'auto' }}>
      <PageHeader
        title={t('creationWizard.title')}
        onBack={() => navigate('/employees')}
        breadcrumb={breadcrumbItems}
      />

      <Card style={{ marginBottom: 16 }}>
        <Steps current={currentStep} items={steps} />
      </Card>

      <Card style={{ marginBottom: 12, minHeight: 400 }}>
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
