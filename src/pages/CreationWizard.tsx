import { useState, useEffect, useRef } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
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
  message,
  Empty,
  Divider,
  Alert,
  Descriptions,
  Badge,
  Progress,
  Timeline,
} from 'antd'
import {
  DatabaseOutlined,
  RobotOutlined,
  ArrowLeftOutlined,
  ArrowRightOutlined,
  CheckOutlined,
  BulbOutlined,
  UserOutlined,
  EditOutlined,
  ToolOutlined,
} from '@ant-design/icons'
import PageHeader from '../components/common/PageHeader'
import type { LLMProvider, LLMModelConfig } from '../types'

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
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const [currentStep, setCurrentStep] = useState(0)
  const [project, setProject] = useState<any>(null)
  const [linkedKBs, setLinkedKBs] = useState<any[]>([])
  const [selectedKBIds, setSelectedKBIds] = useState<string[]>([])
  const [profile, setProfile] = useState<EmployeeProfile | null>(null)
  const [providers, setProviders] = useState<LLMProvider[]>([])
  const [loading, setLoading] = useState(false)
  const [creating, setCreating] = useState(false)
  const [selectedProviderId, setSelectedProviderId] = useState<string>('')
  const [selectedModelId, setSelectedModelId] = useState<string>('')
  const [businessDescription, setBusinessDescription] = useState<string>('')
  const [additionalResponsibilities, setAdditionalResponsibilities] = useState<string>('')
  const [step5ProviderId, setStep5ProviderId] = useState<string>('')
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
      message.error('加载项目失败')
    }
  }

  const loadLinkedKBs = async () => {
    try {
      const result = await window.electronAPI.kb.getKBsForProject(id!)
      setLinkedKBs(result)
      setSelectedKBIds(result.map((kb: any) => kb.id))
    } catch {
      message.error('加载知识库失败')
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

  const getProviderModels = (providerId: string): LLMModelConfig[] => {
    const provider = providers.find(p => p.id === providerId)
    if (!provider?.models_json) return []
    try {
      return JSON.parse(provider.models_json)
    } catch {
      return []
    }
  }

  const getProviderModelOptions = (providerId: string) => {
    return getProviderModels(providerId).map((m) => ({ value: m.model, label: m.name }))
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
        additionalResponsibilities ? `额外职责要求: ${additionalResponsibilities}` : '',
      ].filter(Boolean).join('\n\n')

      const result = await window.electronAPI.employee.analyzeProfile({
        project_id: id!,
        kb_ids: selectedKBIds,
        provider_id: selectedProviderId || undefined,
        model_id: selectedModelId || undefined,
        additional_context: enhancedDescription || undefined,
      })

      if (result.success && result.profile) {
        setProfile(result.profile)
        form.setFieldsValue({
          name: result.profile.roleName,
          description: result.profile.roleDescription,
        })

        if (result.analysisMethod === 'llm') {
          message.success('LLM 智能分析完成')
        } else if (result.analysisMethod === 'heuristic') {
          if (result.error) {
            message.warning(result.error)
          } else {
            message.info('已使用启发式规则完成分析')
          }
        } else {
          message.info('使用默认配置完成')
        }
      } else {
        message.error(result.error || '分析失败')
      }
    } catch {
      message.error('分析知识库失败')
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
        for (const toolName of profile.suggestedTools) {
          try {
            const builtinTools = await window.electronAPI.tool.listBuiltin()
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
      }

      navigate(`/employee/${employee.id}`)
    } catch (error) {
      message.error('创建失败')
      console.error(error)
    } finally {
      setCreating(false)
    }
  }

  const steps = [
    { title: '选择知识库', icon: <DatabaseOutlined /> },
    { title: '业务描述', icon: <BulbOutlined /> },
    { title: '智能分析', icon: <RobotOutlined /> },
    { title: '完成创建', icon: <CheckOutlined /> },
  ]

  const renderStep1 = () => (
    <div>
      {providers.length === 0 && (
        <Alert
          title="未配置 LLM 提供商"
          description="系统将使用启发式规则进行分析，质量可能较低。建议在设置中配置 LLM 提供商以获得更好的分析效果。"
          type="warning"
          showIcon
          style={{ marginBottom: 16 }}
        />
      )}
      <Alert
        title="选择用于创建数字员工的知识库"
        description="系统将调用 LLM 深度分析选中的知识库内容，自动理解业务场景、识别职责。只有项目已关联的知识库可供选择。"
        type="info"
        showIcon
        style={{ marginBottom: 16 }}
      />

      <Card
        title={`项目关联的知识库 (${linkedKBs.length})`}
        extra={
          <Space>
            <Select
              placeholder="选择 LLM 提供商"
              style={{ width: 200 }}
              value={selectedProviderId || undefined}
              onChange={(value) => {
                setSelectedProviderId(value)
                setSelectedModelId('')
              }}
              options={providers.map((p) => ({ value: p.id, label: `${p.name} (${p.model})` }))}
              allowClear
            />
            {selectedProviderId && getProviderModels(selectedProviderId).length > 0 && (
              <Select
                placeholder="选择模型"
                style={{ width: 180 }}
                value={selectedModelId || undefined}
                onChange={setSelectedModelId}
                options={getProviderModelOptions(selectedProviderId)}
                allowClear
              />
            )}
            <Button
              size="small"
              onClick={() => setSelectedKBIds(linkedKBs.map((kb: any) => kb.id))}
            >
              全选
            </Button>
            <Button size="small" onClick={() => setSelectedKBIds([])}>
              清空
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
                  background: isSelected ? '#f9f0ff' : 'transparent',
                  borderBottom: '1px solid #f0f0f0',
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
                      <Tag>{kb.doc_count || 0} 文档</Tag>
                    </Space>
                  </div>
                  <Text type="secondary" style={{ fontSize: 12 }}>
                    {kb.description || '暂无描述'}
                  </Text>
                </div>
              </div>
            )
          })}
        </div>
        {linkedKBs.length === 0 && (
          <Empty description="暂无关联的知识库，请先在项目中关联知识库">
            <Button type="primary" onClick={() => navigate(`/project/${id}`)}>
              前往关联知识库
            </Button>
          </Empty>
        )}
      </Card>
    </div>
  )

  const renderStep2 = () => (
    <div>
      <Alert
        title="描述您的业务场景"
        description="提供更多信息可以让 LLM 更准确地理解您的需求，生成更贴合实际的数字员工角色。"
        type="info"
        showIcon
        style={{ marginBottom: 24 }}
      />

      <Card title="业务场景补充描述" style={{ marginBottom: 24 }}>
        <Paragraph type="secondary">请描述一下您的业务场景、工作流程或对这个数字员工的具体期望。</Paragraph>
        <TextArea
          placeholder="例如：这是一个电商平台的客服知识库，包含产品信息、退换货政策、常见问题等。希望这个数字员工能够：1. 准确回答客户咨询；2. 语气友好专业；3. 遇到复杂问题能引导人工客服..."
          value={businessDescription}
          onChange={(e) => setBusinessDescription(e.target.value)}
          rows={6}
        />
      </Card>

      <Card title="额外职责要求（可选）">
        <TextArea
          placeholder="列出您希望这个数字员工承担的额外职责，每行一条，或用逗号分隔"
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
          <Card title="智能分析进度" style={{ marginBottom: 16 }}>
            <Progress percent={analyzeProgress} status={analyzeStage === 'error' ? 'exception' : 'active'} />
            <Timeline
              items={[
                { color: analyzeProgress >= 10 ? 'green' : 'gray', children: '准备分析知识库' },
                { color: analyzeProgress >= 30 ? 'green' : 'gray', children: '调用 LLM 进行智能分析' },
                { color: analyzeProgress >= 45 ? 'green' : 'gray', children: 'LLM 思考中' },
                { color: analyzeProgress >= 60 ? 'green' : 'gray', children: '接收 LLM 流式响应' },
                { color: analyzeProgress >= 90 ? 'green' : 'gray', children: '解析分析结果' },
              ]}
            />
            {analyzeDetail && (
              <Alert title={analyzeDetail} type="info" showIcon style={{ marginTop: 12 }} />
            )}
          </Card>
          {analyzeThinkChunks.length > 0 && (
            <Card title="LLM 思考过程" size="small" style={{ marginBottom: 16, maxHeight: 200, overflow: 'auto' }}>
              <pre style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word', fontSize: 12, margin: 0, color: '#8c8c8c' }}>
                {analyzeThinkChunks.join('')}
              </pre>
            </Card>
          )}
          {analyzeChunks.length > 0 && (
            <Card title="LLM 实时输出" size="small" style={{ maxHeight: 300, overflow: 'auto' }}>
              <pre style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word', fontSize: 12, margin: 0 }}>
                {analyzeChunks.join('')}
              </pre>
            </Card>
          )}
        </div>
      ) : profile ? (
        <>
          <Alert
            title={`分析完成：识别出 "${profile.roleName}" 角色`}
            type="success"
            showIcon
            style={{ marginBottom: 16 }}
            action={
              <Button size="small" onClick={analyzeKBs} icon={<EditOutlined />}>
                重新分析
              </Button>
            }
          />

          <Card style={{ marginBottom: 16 }}>
            <Descriptions title="员工画像" bordered column={1} size="small">
              <Descriptions.Item label="角色名称">
                <Space>
                  <UserOutlined />
                  <Text strong>{profile.roleName}</Text>
                </Space>
              </Descriptions.Item>
              <Descriptions.Item label="角色描述">{profile.roleDescription}</Descriptions.Item>
              <Descriptions.Item label="工作风格">
                <Badge status="processing" text={profile.workingStyle} />
              </Descriptions.Item>
              <Descriptions.Item label="职责">
                <Space orientation="vertical" size={4}>
                  {profile.responsibilities.map((r, i) => (
                    <Text key={i}>· {r}</Text>
                  ))}
                </Space>
              </Descriptions.Item>
              <Descriptions.Item label="特质">
                <Space wrap>
                  {profile.personalityTraits.map((t, i) => (
                    <Tag key={i} color="blue">{t}</Tag>
                  ))}
                </Space>
              </Descriptions.Item>
              {profile.suggestedTools.length > 0 && (
                <Descriptions.Item label="建议工具">
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
          <RobotOutlined style={{ fontSize: 48, marginBottom: 16, color: '#1677ff' }} />
          <Paragraph>点击下方按钮开始分析知识库</Paragraph>
          <Button type="primary" size="large" onClick={analyzeKBs} icon={<RobotOutlined />}>
            开始智能分析
          </Button>
        </div>
      )}
    </div>
  )

  const renderStep5 = () => (
    <div>
      <Alert
        message="最后确认"
        description="确认数字员工的基本信息，完成创建后即可开始使用。"
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
          label="数字员工名称"
          rules={[{ required: true, message: '请输入名称' }]}
        >
          <Input placeholder="例如：合同审核专员" prefix={<UserOutlined />} />
        </Form.Item>

        <Form.Item name="description" label="描述">
          <TextArea rows={3} placeholder="描述这个数字员工的职责和能力..." />
        </Form.Item>

        <Form.Item name="llm_provider_id" label="LLM 提供商">
          <Select
            placeholder="选择 LLM 提供商"
            options={providers.map((p) => ({ value: p.id, label: `${p.name} (${p.model})` }))}
            allowClear
            onChange={(value) => {
              setStep5ProviderId(value || '')
              form.setFieldValue('llm_model', undefined)
            }}
          />
        </Form.Item>

        <Form.Item name="llm_model" label="模型名称">
          {step5ProviderId && getProviderModels(step5ProviderId).length > 0 ? (
            <Select
              placeholder="选择模型"
              allowClear
              options={getProviderModelOptions(step5ProviderId)}
            />
          ) : (
            <Input placeholder="留空使用提供商默认模型" />
          )}
        </Form.Item>

        <Form.Item name="review_mode" valuePropName="checked" label="人工复核模式">
          <Switch />
        </Form.Item>
        <Text type="secondary" style={{ display: 'block', marginTop: -16, marginBottom: 16 }}>
          开启后，数字员工的输出需要人工确认后方可发送
        </Text>

        <Divider />

        <Title level={5}>创建摘要</Title>
        <Space orientation="vertical" style={{ width: '100%' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between' }}>
            <Text type="secondary">选中知识库</Text>
            <Text>{selectedKBIds.length} 个</Text>
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between' }}>
            <Text type="secondary">识别角色</Text>
            <Text strong>{profile?.roleName || '-'}</Text>
          </div>
          {profile?.suggestedTools && profile.suggestedTools.length > 0 && (
            <div style={{ display: 'flex', justifyContent: 'space-between' }}>
              <Text type="secondary">建议工具</Text>
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
        message.warning('请至少选择一个知识库')
        return
      }
    }
    if (currentStep === 2 && !profile) {
      message.warning('请先完成分析')
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
        title="创建数字员工"
        subTitle={project?.name}
        onBack={() => navigate(`/project/${id}`)}
        breadcrumb={[{ title: '仪表盘' }, { title: project?.name || '项目' }, { title: '创建数字员工' }]}
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
          上一步
        </Button>

        {currentStep < steps.length - 1 ? (
          <Button
            type="primary"
            icon={<ArrowRightOutlined />}
            onClick={handleNext}
            loading={loading && currentStep === 2}
          >
            下一步
          </Button>
        ) : (
          <Button
            type="primary"
            icon={<CheckOutlined />}
            onClick={handleCreateEmployee}
            loading={creating}
          >
            完成创建
          </Button>
        )}
      </div>
    </div>
  )
}

export default CreationWizard
