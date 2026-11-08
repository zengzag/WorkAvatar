import { useState, useEffect, useRef } from 'react'
import { useNavigate } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { App, Alert, Button, Card, Collapse, Input, Space, Tooltip, Typography, theme } from 'antd'
import {
  BulbOutlined,
  CheckOutlined,
  FileAddOutlined,
  RobotOutlined,
  ThunderboltOutlined,
} from '@ant-design/icons'
import PageHeader from '../components/common/PageHeader'
import LLMSelector from '../components/llm/LLMSelector'
import type { LLMProvider } from '../types'
import { getCachedSceneDefaultModel } from '../utils/default-model'
import {
  CollectionSelector,
  PromptFileSelector,
  GenerationProgress,
  ProfileEditor,
  type EmployeeProfile,
  type ToolCategoryDef,
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

  const [brief, setBrief] = useState('')
  const [contextFile, setContextFile] = useState<{ name: string; content: string } | null>(null)
  const [allCollections, setAllCollections] = useState<any[]>([])
  const [selectedCollectionIds, setSelectedCollectionIds] = useState<string[]>([])

  const [employeeName, setEmployeeName] = useState('')
  const [rules, setRules] = useState('')
  const [description, setDescription] = useState('')
  const [profileReady, setProfileReady] = useState(false)
  const [analysisMessages, setAnalysisMessages] = useState<Array<{ role: string; content: string }>>([])
  const [refineInput, setRefineInput] = useState('')

  const [builtinTools, setBuiltinTools] = useState<any[]>([])
  const [toolCategories, setToolCategories] = useState<ToolCategoryDef[]>([])
  const [selectedToolIds, setSelectedToolIds] = useState<string[]>([])

  const [providers, setProviders] = useState<LLMProvider[]>([])
  const [selectedProviderId, setSelectedProviderId] = useState<string>(() => {
    return localStorage.getItem('creationWizard:selectedProviderId') || getCachedSceneDefaultModel('creation')?.provider_id || ''
  })
  const [selectedModelId, setSelectedModelId] = useState<string>(() => {
    return localStorage.getItem('creationWizard:selectedModelId') || getCachedSceneDefaultModel('creation')?.model_id || ''
  })

  const [loading, setLoading] = useState(false)
  const [creating, setCreating] = useState(false)

  const [analyzeStage, setAnalyzeStage] = useState('')
  const [analyzeChunks, setAnalyzeChunks] = useState<string[]>([])
  const [analyzeProgress, setAnalyzeProgress] = useState(0)
  const progressCleanupRef = useRef<(() => void) | null>(null)

  const handleLlmChange = (pId: string, mId: string) => {
    setSelectedProviderId(pId)
    setSelectedModelId(mId)
  }

  useEffect(() => {
    localStorage.setItem('creationWizard:selectedProviderId', selectedProviderId)
    localStorage.setItem('creationWizard:selectedModelId', selectedModelId)
  }, [selectedProviderId, selectedModelId])

  useEffect(() => {
    loadProviders()
    loadAllCollections()
    loadBuiltinTools()
    return () => { cleanupProgress() }
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
        const defaultProvider = (result as LLMProvider[])[0]
        if (defaultProvider) {
          setSelectedProviderId(defaultProvider.id)
        }
      }
    } catch { /* 无可用 LLM 时后端会降级为启发式生成 */ }
  }

  const loadBuiltinTools = async () => {
    try {
      const result = await window.electronAPI.tool.listBuiltin()
      setBuiltinTools(result)
      const defaultToolIds = result
        .filter((tool: any) => DEFAULT_TOOL_NAMES.includes(tool.name))
        .map((tool: any) => tool.id)
      setSelectedToolIds(defaultToolIds)
    } catch { /* ignore */ }
    try {
      setToolCategories(await window.electronAPI.tool.getCategories())
    } catch { /* ignore */ }
  }

  /** 注册生成进度回调，返回清理函数 */
  const setupProgressCallback = () => {
    cleanupProgress()
    progressCleanupRef.current = window.electronAPI.employee.onProfileProgress((data) => {
      setAnalyzeStage(data.stage)
      if (data.chunk && data.stage !== 'thinking') {
        setAnalyzeChunks((prev) => [...prev, data.chunk!])
      }
      setAnalyzeProgress(STAGE_PROGRESS_MAP[data.stage] ?? 50)
    })
  }

  const cleanupProgress = () => {
    if (progressCleanupRef.current) {
      progressCleanupRef.current()
      progressCleanupRef.current = null
    }
  }

  const resetAnalyzeState = () => {
    setAnalyzeStage('')
    setAnalyzeChunks([])
    setAnalyzeProgress(0)
  }

  /** 用生成的画像填充可编辑方案 */
  const applyProfile = (profile: EmployeeProfile) => {
    setEmployeeName(profile.roleName || '')
    setRules(profile.roleDescription || '')
    setDescription(profile.description || '')
    setProfileReady(true)
    const matchedIds = matchSuggestedToolIds(profile.suggestedTools || [], builtinTools)
    if (matchedIds.length > 0) {
      setSelectedToolIds((prev) => mergeToolIds(prev, matchedIds))
    }
  }

  const handleAnalysisResult = (result: any): boolean => {
    if (!result?.success || !result.profile) {
      message.error(result?.error || t('creationWizard.analysisFailed'))
      return false
    }
    applyProfile(result.profile)
    if (Array.isArray(result.messages)) {
      setAnalysisMessages(result.messages)
    }
    return true
  }

  const canGenerate = !!brief.trim() || !!contextFile || selectedCollectionIds.length > 0

  const handleGenerate = async () => {
    if (!canGenerate) {
      message.warning(t('creationWizard.briefRequired'))
      return
    }
    setLoading(true)
    resetAnalyzeState()
    setupProgressCallback()
    try {
      const result = await window.electronAPI.employee.analyzeProfile({
        collection_ids: selectedCollectionIds,
        provider_id: selectedProviderId || undefined,
        model_id: selectedModelId || undefined,
        additional_context: brief.trim() || undefined,
        context_file: contextFile || undefined,
      })
      if (handleAnalysisResult(result)) {
        if (result.analysisMethod === 'llm') {
          message.success(t('creationWizard.generateComplete'))
        } else {
          message.warning(t('creationWizard.heuristicFallback'))
        }
      }
    } catch {
      message.error(t('creationWizard.analyzeKbFailed'))
    } finally {
      setLoading(false)
      cleanupProgress()
    }
  }

  /** 已选工具 ID → 工具名（回传给画像优化接口） */
  const getSelectedToolNames = (): string[] =>
    selectedToolIds
      .map((id) => builtinTools.find((tool: any) => tool.id === id)?.name)
      .filter((name): name is string => !!name)

  const handleRefine = async () => {
    if (!refineInput.trim() || !profileReady) return
    const providerId = selectedProviderId || providers[0]?.id
    if (!providerId) {
      message.warning(t('creationWizard.noProviderForRefine'))
      return
    }
    setLoading(true)
    resetAnalyzeState()
    setupProgressCallback()
    try {
      const result = await window.electronAPI.employee.refineProfile({
        previous_messages: analysisMessages,
        previous_profile: {
          roleName: employeeName,
          roleDescription: rules,
          description,
          suggestedTools: getSelectedToolNames(),
        },
        feedback: refineInput.trim(),
        provider_id: providerId,
        model_id: selectedModelId || undefined,
      })
      if (handleAnalysisResult(result)) {
        setRefineInput('')
        if (result.warning) {
          message.warning(t('creationWizard.refineFailed'))
        } else {
          message.success(t('creationWizard.refineComplete'))
        }
      }
    } catch {
      message.error(t('creationWizard.refineFailed'))
    } finally {
      setLoading(false)
      cleanupProgress()
    }
  }

  /** 创建员工并分配工具 */
  const createEmployeeWithTools = async (name: string, desc: string, profileJson?: string, employeeRules?: string) => {
    const employee = await window.electronAPI.employee.create({
      name,
      description: desc,
      rules: employeeRules,
      profile_json: profileJson,
    })

    const onDemandMap = new Map(builtinTools.map((tool: any) => [tool.id, !!tool.onDemand]))
    for (const toolId of selectedToolIds) {
      try {
        await window.electronAPI.tool.assignToEmployee({
          employee_id: employee.id,
          tool_id: toolId,
          mode: onDemandMap.get(toolId) ? 'on_demand' : 'on',
        })
      } catch { /* 单个工具分配失败不阻塞创建 */ }
    }
    return employee
  }

  const handleCreateEmployee = async () => {
    const finalRules = rules.trim() || brief.trim()
    if (!employeeName.trim()) {
      message.warning(t('creationWizard.enterName'))
      return
    }
    if (!finalRules) {
      message.warning(t('creationWizard.rulesRequired'))
      return
    }
    setCreating(true)
    try {
      const profileJson = JSON.stringify({
        roleName: employeeName.trim(),
        roleDescription: finalRules,
        description,
        suggestedTools: getSelectedToolNames(),
      })
      await createEmployeeWithTools(employeeName.trim(), description.trim(), profileJson, finalRules)
      navigate('/employees')
    } catch (error) {
      message.error(t('creationWizard.createFailed'))
      console.error(error)
    } finally {
      setCreating(false)
    }
  }

  const handleBlankCreate = async () => {
    setCreating(true)
    try {
      await createEmployeeWithTools(employeeName.trim() || t('creationWizard.quickCreateDefaultName'), '')
      navigate('/employees')
    } catch (error) {
      message.error(t('creationWizard.createFailed'))
      console.error(error)
    } finally {
      setCreating(false)
    }
  }

  /** 跳过 AI 生成，直接在右侧手写系统提示词 */
  const handleManualEdit = () => {
    if (!rules.trim() && brief.trim()) {
      setRules(brief.trim())
    }
    setProfileReady(true)
  }

  const pageStyle = `
    .wizard-grid {
      display: grid;
      grid-template-columns: minmax(320px, 400px) minmax(0, 1fr);
      gap: 16px;
      align-items: start;
    }
    @media (max-width: 1000px) {
      .wizard-grid { grid-template-columns: minmax(0, 1fr); }
    }
  `

  const breadcrumbItems = [
    { title: t('creationWizard.breadcrumbDigitalEmployees'), onClick: () => navigate('/employees') },
    { title: t('creationWizard.breadcrumbCreate') },
  ]

  return (
    <div className="wa-module-page">
      <div className="wa-module-shell">
      {/* 页头：核心操作固定可见 */}
      <div style={{ flexShrink: 0, padding: '16px 20px 0' }}>
        <PageHeader
          title={t('creationWizard.title')}
          subTitle={t('creationWizard.subtitle')}
          onBack={() => navigate('/employees')}
          breadcrumb={breadcrumbItems}
          extra={(
            <Space size={8}>
              <Tooltip title={t('creationWizard.quickCreateHint')}>
                <Button
                  icon={<FileAddOutlined />}
                  onClick={handleBlankCreate}
                  loading={creating}
                  data-testid="wizard-quick-create"
                >
                  {t('creationWizard.quickCreate')}
                </Button>
              </Tooltip>
              <Button
                type="primary"
                icon={<CheckOutlined />}
                onClick={handleCreateEmployee}
                loading={creating}
                data-testid="wizard-create"
              >
                {t('creationWizard.createButton')}
              </Button>
            </Space>
          )}
        />
      </div>

      <div style={{ flex: 1, minHeight: 0, overflow: 'auto', padding: '0 20px 20px' }}>
        <div className="wizard-grid">
          {/* 需求描述 */}
          <Card
            title={<span><BulbOutlined style={{ marginRight: 6 }} />{t('creationWizard.describeTitle')}</span>}
            extra={(
              <LLMSelector
                providerId={selectedProviderId}
                modelId={selectedModelId}
                onChange={handleLlmChange}
              />
            )}
            styles={{ body: { padding: 16 } }}
          >
            {providers.length === 0 && (
              <Alert
                title={t('creationWizard.noLlmAlert')}
                description={t('creationWizard.noLlmAlertDesc')}
                type="warning"
                showIcon
                style={{ marginBottom: 12 }}
              />
            )}

            <TextArea
              value={brief}
              onChange={(e) => setBrief(e.target.value)}
              placeholder={t('creationWizard.briefPlaceholder')}
              rows={4}
              data-testid="wizard-business-desc"
              onKeyDown={(e) => {
                if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
                  e.preventDefault()
                  handleGenerate()
                }
              }}
            />

            <Collapse
              ghost
              style={{ marginTop: 4 }}
              items={[
                {
                  key: 'references',
                  label: (
                    <span>
                      {t('creationWizard.referencesTitle')}
                      {(contextFile ? 1 : 0) + selectedCollectionIds.length > 0 && (
                        <Text type="secondary" style={{ fontSize: 12, marginLeft: 8 }}>
                          {t('creationWizard.referencesSelected', {
                            count: (contextFile ? 1 : 0) + selectedCollectionIds.length,
                          })}
                        </Text>
                      )}
                    </span>
                  ),
                  children: (
                    <Space orientation="vertical" size={16} style={{ width: '100%' }}>
                      <div>
                        <Text type="secondary" style={{ display: 'block', fontSize: 12, marginBottom: 8 }}>
                          {t('creationWizard.referencesHint')}
                        </Text>
                        <PromptFileSelector value={contextFile} onChange={setContextFile} />
                      </div>
                      <CollectionSelector
                        collections={allCollections}
                        selectedIds={selectedCollectionIds}
                        onChange={setSelectedCollectionIds}
                      />
                    </Space>
                  ),
                },
              ]}
            />

            <Button
              type="primary"
              ghost
              block
              icon={<ThunderboltOutlined />}
              onClick={handleGenerate}
              loading={loading}
              disabled={!canGenerate}
              style={{ marginTop: 8 }}
            >
              {profileReady ? t('creationWizard.regenerate') : t('creationWizard.generate')}
            </Button>
          </Card>

          {/* 员工方案 */}
          <Card title={t('creationWizard.planTitle')} style={{ minHeight: 420 }}>
            {loading && (
              <div style={{ marginBottom: profileReady ? 20 : 0 }}>
                <GenerationProgress
                  progress={analyzeProgress}
                  stage={analyzeStage}
                  contentChunks={analyzeChunks}
                />
              </div>
            )}

            {profileReady ? (
              <>
                <ProfileEditor
                  name={employeeName}
                  onNameChange={setEmployeeName}
                  description={description}
                  onDescriptionChange={setDescription}
                  rules={rules}
                  onRulesChange={setRules}
                  builtinTools={builtinTools}
                  toolCategories={toolCategories}
                  selectedToolIds={selectedToolIds}
                  onToolIdsChange={setSelectedToolIds}
                  disabled={loading}
                />

                <div style={{ marginTop: 20, paddingTop: 16, borderTop: `1px solid ${token.colorBorderSecondary}` }}>
                  <Text strong style={{ display: 'block', marginBottom: 8 }}>
                    {t('creationWizard.refineTitle')}
                  </Text>
                  <TextArea
                    value={refineInput}
                    onChange={(e) => setRefineInput(e.target.value)}
                    placeholder={t('creationWizard.refinePlaceholder')}
                    rows={2}
                    disabled={loading}
                  />
                  <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 8 }}>
                    <Button
                      icon={<ThunderboltOutlined />}
                      onClick={handleRefine}
                      loading={loading}
                      disabled={!refineInput.trim()}
                    >
                      {t('creationWizard.applyRefine')}
                    </Button>
                  </div>
                </div>

                <Text type="secondary" style={{ display: 'block', fontSize: 12, marginTop: 12 }}>
                  {t('creationWizard.createHint')}
                </Text>
              </>
            ) : !loading ? (
              <div style={{ padding: '64px 0', textAlign: 'center' }}>
                <RobotOutlined style={{ fontSize: 40, color: 'var(--wa-ink-4)' }} />
                <Paragraph type="secondary" style={{ marginTop: 12, marginBottom: 8 }}>
                  {t('creationWizard.resultEmpty')}
                </Paragraph>
                <Button type="link" onClick={handleManualEdit} data-testid="wizard-manual-edit">
                  {t('creationWizard.manualEdit')}
                </Button>
              </div>
            ) : null}
          </Card>
        </div>

        <style>{pageStyle}</style>
      </div>
      </div>
    </div>
  )
}

export default CreationWizard
