import { useState, useEffect } from 'react'
import {
  Form,
  Input,
  Button,
  Select,
  Switch,
  InputNumber,
  Table,
  Space,
  Tag,
  Modal,
  Popconfirm,
  Divider,
  Typography,
  Collapse,
  Tooltip,
  App,
} from 'antd'
import {
  PlusOutlined,
  EditOutlined,
  DeleteOutlined,
  ApiOutlined,
  CheckCircleOutlined,
  SyncOutlined,
  SettingOutlined,
  QuestionCircleOutlined,
  GlobalOutlined,
} from '@ant-design/icons'
import type { LLMProvider, LLMModelConfig, LLMProviderType } from '../../types'
import { useTranslation } from 'react-i18next'

const { Text, Title } = Typography

const PROVIDER_TYPES: { value: LLMProviderType; label: string; group: string; icon?: string }[] = [
  { value: 'openai', label: 'OpenAI', group: 'international' },
  { value: 'groq', label: 'Groq', group: 'international' },
  { value: 'mistral', label: 'Mistral AI', group: 'international' },
  { value: 'xai', label: 'xAI (Grok)', group: 'international' },
  { value: 'azure', label: 'Azure OpenAI', group: 'international' },
  { value: 'vertex', label: 'Google Vertex AI', group: 'international' },
  { value: 'bedrock', label: 'AWS Bedrock', group: 'international' },
  { value: 'deepseek', label: 'DeepSeek (深度求索)', group: 'domestic' },
  { value: 'qwen', label: '通义千问 (Qwen)', group: 'domestic' },
  { value: 'zhipu', label: '智谱 AI (GLM)', group: 'domestic' },
  { value: 'volcengine', label: '火山引擎 (豆包)', group: 'domestic' },
  { value: 'moonshot', label: 'Moonshot (Kimi)', group: 'domestic' },
  { value: 'yi', label: '零一万物 (Yi)', group: 'domestic' },
  { value: 'openai-compatible', label: 'OpenAI 兼容接口', group: 'local' },
  { value: 'lmstudio', label: 'LM Studio', group: 'local' },
]

const PROVIDER_DEFAULTS: Record<string, { baseURL: string; defaultModel: string }> = {
  openai: { baseURL: 'https://api.openai.com/v1', defaultModel: 'gpt-4o-mini' },
  'openai-compatible': { baseURL: '', defaultModel: '' },
  lmstudio: { baseURL: 'http://localhost:1234/v1', defaultModel: '' },
  deepseek: { baseURL: 'https://api.deepseek.com/v1', defaultModel: 'deepseek-chat' },
  qwen: { baseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1', defaultModel: 'qwen-plus' },
  zhipu: { baseURL: 'https://open.bigmodel.cn/api/paas/v4', defaultModel: 'glm-4-flash' },
  volcengine: { baseURL: 'https://ark.cn-beijing.volces.com/api/v3', defaultModel: 'doubao-1-5-pro-32k' },
  moonshot: { baseURL: 'https://api.moonshot.cn/v1', defaultModel: 'moonshot-v1-8k' },
  yi: { baseURL: 'https://api.lingyiwanwu.com/v1', defaultModel: 'yi-lightning' },
  groq: { baseURL: 'https://api.groq.com/openai/v1', defaultModel: 'llama-3.3-70b-versatile' },
  mistral: { baseURL: 'https://api.mistral.ai/v1', defaultModel: 'mistral-small-latest' },
  azure: { baseURL: '', defaultModel: 'gpt-4o-mini' },
  vertex: { baseURL: '', defaultModel: 'gpt-4o-mini' },
  bedrock: { baseURL: '', defaultModel: 'gpt-4o-mini' },
  xai: { baseURL: 'https://api.x.ai/v1', defaultModel: 'grok-3-mini' },
}

const getProviderTypeLabel = (type: string): string => {
  const info = PROVIDER_TYPES.find((p) => p.value === type)
  return info?.label || type
}

const getProviderTypeGroup = (type: string): string => {
  const info = PROVIDER_TYPES.find((p) => p.value === type)
  return info?.group || 'other'
}

const GROUP_COLOR_MAP: Record<string, string> = {
  domestic: 'red',
  local: 'green',
  international: 'blue',
}

const LLMSettings: React.FC = () => {
  const { t } = useTranslation()
  const { message } = App.useApp()
  const [providers, setProviders] = useState<LLMProvider[]>([])
  const [modalVisible, setModalVisible] = useState(false)
  const [editingProvider, setEditingProvider] = useState<LLMProvider | null>(null)
  const [testingId, setTestingId] = useState<string | null>(null)
  const [form] = Form.useForm()
  const [models, setModels] = useState<LLMModelConfig[]>([])
  const [modelModalVisible, setModelModalVisible] = useState(false)
  const [editingModel, setEditingModel] = useState<LLMModelConfig | null>(null)
  const [modelForm] = Form.useForm()

  useEffect(() => {
    loadProviders()
  }, [])

  const loadProviders = async () => {
    try {
      const result = await window.electronAPI.llm.getProviders()
      setProviders(result as LLMProvider[])
    } catch (error) {
      console.error('Failed to load LLM providers:', error)
    }
  }

  const handleAdd = () => {
    setEditingProvider(null)
    setModels([])
    form.resetFields()
    form.setFieldsValue({
      provider_type: 'openai-compatible',
      temperature: 0.3,
      max_tokens: 4096,
      timeout_ms: 60000,
    })
    setModalVisible(true)
  }

  const handleProviderTypeChange = (type: string) => {
    const defaults = PROVIDER_DEFAULTS[type]
    if (defaults) {
      const currentBaseUrl = form.getFieldValue('base_url')
      const currentModel = form.getFieldValue('model')

      if (!currentBaseUrl && defaults.baseURL) {
        form.setFieldsValue({ base_url: defaults.baseURL })
      }
      if (!currentModel && defaults.defaultModel) {
        form.setFieldsValue({ model: defaults.defaultModel })
      }
    }
  }

  const handleEdit = (provider: LLMProvider) => {
    setEditingProvider(provider)
    const loadedModels = provider.models_json
      ? JSON.parse(provider.models_json)
      : []
    setModels(loadedModels)
    form.setFieldsValue({
      name: provider.name,
      provider_type: provider.provider_type,
      base_url: provider.base_url,
      model: provider.model,
      embedding_model: provider.embedding_model || 'text-embedding-3-small',
      temperature: provider.temperature,
      max_tokens: provider.max_tokens,
      timeout_ms: provider.timeout_ms,
      extra_headers_json: provider.extra_headers_json || '',
      extra_body_json: (provider as any).extra_body_json || '',
      is_default: provider.is_default,
    })
    setModalVisible(true)
  }

  const handleDelete = async (id: string) => {
    try {
      await window.electronAPI.llm.deleteProvider(id)
      message.success(t('settings.deleted'))
      loadProviders()
    } catch {
      message.error(t('settings.deleteFailed'))
    }
  }

  const handleSave = async () => {
    try {
      const values = await form.validateFields()
      const providerData = {
        ...values,
        models_json: JSON.stringify(models),
        extra_headers_json: values.extra_headers_json || null,
        extra_body_json: values.extra_body_json || null,
      }
      if (editingProvider) {
        await window.electronAPI.llm.updateProvider({ id: editingProvider.id, ...providerData })
        message.success(t('settings.updated'))
      } else {
        await window.electronAPI.llm.createProvider(providerData)
        message.success(t('settings.added'))
      }
      setModalVisible(false)
      loadProviders()
    } catch (error: any) {
      if (error?.message) {
        message.error(error.message)
      }
    }
  }

  const handleTestConnection = async (id: string) => {
    setTestingId(id)
    try {
      const result = await window.electronAPI.llm.testConnection({ provider_id: id })
      if (result.success) {
        message.success(t('settings.testSuccess', { latency: result.latency }))
      } else {
        message.error(t('settings.testFailed', { error: result.error }))
      }
    } catch {
      message.error(t('settings.testConnectionFailed'))
    } finally {
      setTestingId(null)
    }
  }

  const handleAddModel = () => {
    setEditingModel(null)
    modelForm.resetFields()
    modelForm.setFieldsValue({
      temperature: 0.3,
      max_tokens: 4096,
      max_retry: 100,
      is_default: false,
    })
    setModelModalVisible(true)
  }

  const handleEditModel = (model: LLMModelConfig) => {
    setEditingModel(model)
    modelForm.setFieldsValue({
      name: model.name,
      model: model.model,
      temperature: model.temperature,
      max_tokens: model.max_tokens,
      top_p: model.top_p,
      frequency_penalty: model.frequency_penalty,
      presence_penalty: model.presence_penalty,
      max_retry: model.max_retry ?? 100,
      is_default: model.is_default,
    })
    setModelModalVisible(true)
  }

  const handleSaveModel = async () => {
    try {
      const values = await modelForm.validateFields()
      const newModel: LLMModelConfig = {
        id: editingModel ? editingModel.id : `model_${Date.now()}`,
        name: values.name,
        model: values.model,
        temperature: values.temperature,
        max_tokens: values.max_tokens,
        top_p: values.top_p,
        frequency_penalty: values.frequency_penalty,
        presence_penalty: values.presence_penalty,
        max_retry: values.max_retry,
        is_default: values.is_default,
      }

      if (values.is_default) {
        setModels(models.map(m => ({ ...m, is_default: false })))
      }

      if (editingModel) {
        setModels(models.map(m => m.id === editingModel.id ? newModel : m))
      } else {
        setModels([...models, newModel])
      }
      setModelModalVisible(false)
    } catch (error: any) {
      if (error?.message) {
        message.error(error.message)
      }
    }
  }

  const handleDeleteModel = (modelId: string) => {
    setModels(models.filter(m => m.id !== modelId))
  }

  const modelColumns = [
    { title: t('settings.providerName'), dataIndex: 'name', key: 'name', width: 120 },
    { title: t('settings.modelId'), dataIndex: 'model', key: 'model', width: 160 },
    { title: t('settings.temperature'), dataIndex: 'temperature', key: 'temperature', width: 60 },
    { title: t('settings.maxToken'), dataIndex: 'max_tokens', key: 'max_tokens', width: 90 },
    { title: t('settings.maxRetry'), dataIndex: 'max_retry', key: 'max_retry', width: 80,
      render: (r: number | undefined) => r ?? 100 },
    {
      title: t('settings.defaultModel'),
      dataIndex: 'is_default',
      key: 'is_default',
      width: 60,
      render: (isDefault: boolean) => isDefault ? <CheckCircleOutlined style={{ color: '#52c41a' }} /> : null,
    },
    {
      title: t('common.edit'),
      key: 'actions',
      width: 80,
      render: (_: any, record: LLMModelConfig) => (
        <Space>
          <Button size="small" icon={<EditOutlined />} onClick={() => handleEditModel(record)} />
          <Popconfirm title={t('common.confirmDelete')} onConfirm={() => handleDeleteModel(record.id)}>
            <Button size="small" danger icon={<DeleteOutlined />} />
          </Popconfirm>
        </Space>
      ),
    },
  ]

  const columns = [
    {
      title: t('settings.providerName'),
      dataIndex: 'name',
      key: 'name',
      width: 140,
    },
    {
      title: t('settings.providerType'),
      dataIndex: 'provider_type',
      key: 'provider_type',
      width: 140,
      render: (type: string) => {
        const group = getProviderTypeGroup(type)
        const label = getProviderTypeLabel(type)
        const groupTranslationMap: Record<string, string> = {
          domestic: t('settings.providerGroupDomestic'),
          local: t('settings.providerGroupLocal'),
          international: t('settings.providerGroupInternational'),
          other: t('settings.providerGroupOther'),
        }
        return (
          <Space size={4}>
            <Tag color={GROUP_COLOR_MAP[group] || 'default'} style={{ fontSize: 11 }}>{groupTranslationMap[group] || group}</Tag>
            <span style={{ fontSize: 12 }}>{label}</span>
          </Space>
        )
      },
    },
    {
      title: t('settings.modelConfig'),
      key: 'model_info',
      render: (_: any, record: LLMProvider) => {
        const modelCount = record.models_json ? JSON.parse(record.models_json).length : 0
        return (
          <Space size={4} orientation="vertical" style={{ lineHeight: 1.4 }}>
            <Text style={{ fontSize: 12 }}>{record.model}</Text>
            {modelCount > 0 && <Text type="secondary" style={{ fontSize: 11 }}>{t('settings.modelCount', { count: modelCount })}</Text>}
          </Space>
        )
      },
    },
    {
      title: t('settings.defaultModel'),
      dataIndex: 'is_default',
      key: 'is_default',
      width: 80,
      render: (isDefault: boolean) =>
        isDefault ? <CheckCircleOutlined style={{ color: '#52c41a' }} /> : null,
    },
    {
      title: t('common.edit'),
      key: 'actions',
      width: 200,
      render: (_: any, record: LLMProvider) => (
        <Space>
          <Button
            size="small"
            icon={testingId === record.id ? <SyncOutlined spin /> : <ApiOutlined />}
            onClick={() => handleTestConnection(record.id)}
            loading={testingId === record.id}
          >
            {t('settings.testConnection')}
          </Button>
          <Button size="small" icon={<EditOutlined />} onClick={() => handleEdit(record)}>
            {t('common.edit')}
          </Button>
          <Popconfirm title={t('common.confirmDelete')} onConfirm={() => handleDelete(record.id)}>
            <Button size="small" danger icon={<DeleteOutlined />} />
          </Popconfirm>
        </Space>
      ),
    },
  ]

  const providerTypeOptions = [
    {
      label: t('settings.localProviders'),
      options: PROVIDER_TYPES.filter(p => p.group === 'local').map(p => ({ value: p.value, label: p.label })),
    },
    {
      label: t('settings.domesticProviders'),
      options: PROVIDER_TYPES.filter(p => p.group === 'domestic').map(p => ({ value: p.value, label: p.label })),
    },
    {
      label: t('settings.internationalProviders'),
      options: PROVIDER_TYPES.filter(p => p.group === 'international').map(p => ({ value: p.value, label: p.label })),
    },
  ]

  return (
    <>
      <div>
        <div style={{ marginBottom: 16, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <Title level={5} style={{ margin: 0 }}>{t('settings.llmProviders')}</Title>
          <Button type="primary" icon={<PlusOutlined />} onClick={handleAdd}>
            {t('settings.addProvider')}
          </Button>
        </div>

        <Table
          dataSource={providers}
          columns={columns}
          rowKey="id"
          pagination={false}
          scroll={{ y: 400 }}
          locale={{ emptyText: t('settings.noProviders') }}
        />
      </div>

      <Modal
        title={editingProvider ? t('settings.editProvider') : t('settings.addProviderModal')}
        open={modalVisible}
        onOk={handleSave}
        onCancel={() => setModalVisible(false)}
        width={780}
        okText={t('common.save')}
        cancelText={t('common.cancel')}
      >
        <Form form={form} layout="vertical" style={{ marginTop: 16 }}>
          <div style={{ display: 'flex', gap: 16 }}>
            <Form.Item name="name" label={t('settings.providerName')} rules={[{ required: true, message: t('settings.enterName') }]} style={{ flex: 1 }}>
              <Input placeholder="DeepSeek" />
            </Form.Item>
            <Form.Item name="provider_type" label={t('settings.providerType')} rules={[{ required: true }]} style={{ flex: 1 }}>
              <Select
                options={providerTypeOptions}
                onChange={handleProviderTypeChange}
              />
            </Form.Item>
          </div>

          <div style={{ display: 'flex', gap: 16 }}>
            <Form.Item name="base_url" label={
              <span>{t('settings.apiEndpoint')} <Tooltip title={t('settings.apiEndpointTooltip')}><QuestionCircleOutlined style={{ marginLeft: 4 }} /></Tooltip></span>
            } style={{ flex: 1 }}>
              <Input placeholder="https://api.openai.com/v1" />
            </Form.Item>
            <Form.Item name="api_key" label={t('settings.apiKey')} style={{ flex: 1 }}
              extra={t('settings.apiKeyHint')}>
              <Input.Password placeholder="sk-..." />
            </Form.Item>
          </div>

          <Collapse
            defaultActiveKey={['models']}
            size="small"
            style={{ marginBottom: 16 }}
            items={[
              {
                key: 'models',
                label: <span><SettingOutlined /> {t('settings.modelConfig')}</span>,
                children: (
                  <>
                    <div style={{ marginBottom: 12, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                      <Text type="secondary">{t('settings.modelConfigHint')}</Text>
                      <Button type="primary" size="small" icon={<PlusOutlined />} onClick={handleAddModel}>
                        {t('settings.addModel')}
                      </Button>
                    </div>
                    <Table
                      dataSource={models}
                      columns={modelColumns}
                      rowKey="id"
                      size="small"
                      pagination={false}
                      locale={{ emptyText: t('settings.noModels') }}
                      scroll={{ x: 650 }}
                    />
                  </>
                ),
              },
            ]}
          />

          <Collapse
            size="small"
            style={{ marginBottom: 16 }}
            items={[
              {
                key: 'defaults',
                label: <span><SettingOutlined /> {t('settings.defaultParams')}</span>,
                children: (
                  <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap' }}>
                    <Form.Item name="model" label={t('settings.defaultModel')} rules={[{ required: true, message: t('settings.enterModelName') }]}>
                      <Input placeholder="gpt-4o-mini" style={{ width: 180 }} />
                    </Form.Item>
                    <Form.Item name="temperature" label={
                      <span>{t('settings.temperature')} <Tooltip title={t('settings.temperatureTooltip')}><QuestionCircleOutlined style={{ marginLeft: 4 }} /></Tooltip></span>
                    }>
                      <InputNumber min={0} max={2} step={0.1} style={{ width: 120 }} />
                    </Form.Item>
                    <Form.Item name="max_tokens" label={t('settings.maxToken')}>
                      <InputNumber min={1} max={128000} step={1024} style={{ width: 140 }} />
                    </Form.Item>
                    <Form.Item name="timeout_ms" label={t('settings.timeout')}>
                      <InputNumber min={1000} max={300000} step={1000} style={{ width: 140 }} />
                    </Form.Item>
                  </div>
                ),
              },
            ]}
          />

          <Collapse
            size="small"
            style={{ marginBottom: 16 }}
            items={[
              {
                key: 'advanced',
                label: <span><GlobalOutlined /> {t('settings.advancedConfig')}</span>,
                children: (
                  <>
                    <Form.Item name="extra_headers_json" label={
                      <span>{t('settings.extraHeaders')} <Tooltip title={t('settings.extraHeadersTooltip')}><QuestionCircleOutlined style={{ marginLeft: 4 }} /></Tooltip></span>
                    }>
                      <Input.TextArea rows={2} placeholder='{"X-Custom-Header": "value"}' />
                    </Form.Item>
                    <Form.Item name="extra_body_json" label={
                      <span>{t('settings.extraBody')} <Tooltip title={t('settings.extraBodyTooltip')}><QuestionCircleOutlined style={{ marginLeft: 4 }} /></Tooltip></span>
                    }>
                      <Input.TextArea rows={2} placeholder='{"key": "value"}' />
                    </Form.Item>
                  </>
                ),
              },
            ]}
          />

          <Form.Item name="is_default" valuePropName="checked" label={t('settings.setAsDefault')}>
            <Switch />
          </Form.Item>
        </Form>
      </Modal>

      <Modal
        title={editingModel ? t('settings.editModel') : t('settings.addModelModal')}
        open={modelModalVisible}
        onOk={handleSaveModel}
        onCancel={() => setModelModalVisible(false)}
        width={600}
        okText={t('common.save')}
        cancelText={t('common.cancel')}
      >
        <Form form={modelForm} layout="vertical" style={{ marginTop: 16 }}>
          <div style={{ display: 'flex', gap: 16 }}>
            <Form.Item name="name" label={t('settings.displayName')} rules={[{ required: true, message: t('settings.enterName') }]} style={{ flex: 1 }}>
              <Input placeholder="DeepSeek-V3" />
            </Form.Item>
            <Form.Item name="model" label={t('settings.modelId')} rules={[{ required: true, message: t('settings.enterModelId') }]} style={{ flex: 1 }}>
              <Input placeholder="deepseek-chat" />
            </Form.Item>
          </div>

          <Divider plain>{t('settings.generateParams')}</Divider>

          <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap' }}>
            <Form.Item name="temperature" label={
              <span>Temperature <Tooltip title={t('settings.temperatureParamTooltip')}><QuestionCircleOutlined /></Tooltip></span>
            }>
              <InputNumber min={0} max={2} step={0.1} style={{ width: 120 }} />
            </Form.Item>
            <Form.Item name="max_tokens" label={t('settings.maxToken')}>
              <InputNumber min={1} max={128000} step={1024} style={{ width: 140 }} />
            </Form.Item>
            <Form.Item name="max_retry" label={
              <span>{t('settings.maxRetry')} <Tooltip title={t('settings.maxRetryTooltip')}><QuestionCircleOutlined /></Tooltip></span>
            }>
              <InputNumber min={1} max={1000} step={10} style={{ width: 140 }} />
            </Form.Item>
            <Form.Item name="top_p" label={
              <span>{t('settings.topP')} <Tooltip title={t('settings.topPTooltip')}><QuestionCircleOutlined /></Tooltip></span>
            }>
              <InputNumber min={0} max={1} step={0.05} style={{ width: 120 }} />
            </Form.Item>
          </div>

          <div style={{ display: 'flex', gap: 16 }}>
            <Form.Item name="frequency_penalty" label={
              <span>{t('settings.frequencyPenalty')} <Tooltip title={t('settings.frequencyPenaltyTooltip')}><QuestionCircleOutlined /></Tooltip></span>
            }>
              <InputNumber min={-2} max={2} step={0.1} style={{ width: 120 }} />
            </Form.Item>
            <Form.Item name="presence_penalty" label={
              <span>{t('settings.presencePenalty')} <Tooltip title={t('settings.presencePenaltyTooltip')}><QuestionCircleOutlined /></Tooltip></span>
            }>
              <InputNumber min={-2} max={2} step={0.1} style={{ width: 120 }} />
            </Form.Item>
          </div>

          <Form.Item name="is_default" valuePropName="checked" label={t('settings.setAsDefaultModel')}>
            <Switch />
          </Form.Item>
        </Form>
      </Modal>
    </>
  )
}

export default LLMSettings
