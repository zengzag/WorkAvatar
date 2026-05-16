import { useState, useEffect } from 'react'
import { generateId } from '../../utils/format'
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
import type { LLMProvider, LLMModelConfig, LLMModelCategory, LLMProviderType } from '../../types'
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

const PROVIDER_DEFAULTS: Record<string, { baseURL: string }> = {
  openai: { baseURL: 'https://api.openai.com/v1' },
  'openai-compatible': { baseURL: '' },
  lmstudio: { baseURL: 'http://localhost:1234/v1' },
  deepseek: { baseURL: 'https://api.deepseek.com/v1' },
  qwen: { baseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1' },
  zhipu: { baseURL: 'https://open.bigmodel.cn/api/paas/v4' },
  volcengine: { baseURL: 'https://ark.cn-beijing.volces.com/api/v3' },
  moonshot: { baseURL: 'https://api.moonshot.cn/v1' },
  yi: { baseURL: 'https://api.lingyiwanwu.com/v1' },
  groq: { baseURL: 'https://api.groq.com/openai/v1' },
  mistral: { baseURL: 'https://api.mistral.ai/v1' },
  azure: { baseURL: '' },
  vertex: { baseURL: '' },
  bedrock: { baseURL: '' },
  xai: { baseURL: 'https://api.x.ai/v1' },
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

const CATEGORY_TAG_MAP: Record<LLMModelCategory, { color: string }> = {
  chat: { color: 'blue' },
  embedding: { color: 'purple' },
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
  const [modelCategory, setModelCategory] = useState<LLMModelCategory>('chat')
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
      timeout_ms: 60000,
      api_key: '',
    })
    setModalVisible(true)
  }

  const handleProviderTypeChange = (type: string) => {
    const defaults = PROVIDER_DEFAULTS[type]
    if (defaults) {
      const currentBaseUrl = form.getFieldValue('base_url')
      if (!currentBaseUrl && defaults.baseURL) {
        form.setFieldsValue({ base_url: defaults.baseURL })
      }
    }
  }

  const handleEdit = (provider: LLMProvider) => {
    setEditingProvider(provider)
    const loadedModels: LLMModelConfig[] = provider.models_json
      ? JSON.parse(provider.models_json).map((m: any) => ({
          ...m,
          category: m.category || 'chat',
        }))
      : []
    setModels(loadedModels)
    form.resetFields()
    form.setFieldsValue({
      name: provider.name,
      provider_type: provider.provider_type,
      base_url: provider.base_url,
      timeout_ms: provider.timeout_ms,
      extra_headers_json: provider.extra_headers_json || '',
      extra_body_json: (provider as any).extra_body_json || '',
      is_default: provider.is_default,
      api_key: '',
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
      const defaultChatModel = models.find(m => m.category === 'chat' && m.is_default)
      const defaultEmbeddingModel = models.find(m => m.category === 'embedding')
      const providerData = {
        ...values,
        model: defaultChatModel?.model || '',
        embedding_model: defaultEmbeddingModel?.model || '',
        temperature: defaultChatModel?.temperature ?? 0.3,
        max_tokens: defaultChatModel?.max_tokens ?? 4096,
        models_json: JSON.stringify(models),
        extra_headers_json: values.extra_headers_json || null,
        extra_body_json: values.extra_body_json || null,
      }
      if (!providerData.api_key) {
        delete (providerData as any).api_key
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
    setModelCategory('chat')
    modelForm.resetFields()
    modelForm.setFieldsValue({
      category: 'chat',
      temperature: 0.3,
      max_tokens: 4096,
      max_retry: 100,
      is_default: false,
    })
    setModelModalVisible(true)
  }

  const handleEditModel = (model: LLMModelConfig) => {
    setEditingModel(model)
    setModelCategory(model.category || 'chat')
    modelForm.setFieldsValue({
      category: model.category || 'chat',
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

  const handleModelCategoryChange = (category: LLMModelCategory) => {
    setModelCategory(category)
    if (category === 'embedding') {
      modelForm.setFieldsValue({
        is_default: false,
      })
    }
  }

  const handleSaveModel = async () => {
    try {
      const values = await modelForm.validateFields()
      const category = values.category || 'chat'
      const newModel: LLMModelConfig = {
        id: editingModel ? editingModel.id : `model_${generateId()}`,
        name: values.name,
        model: values.model,
        category,
        temperature: category === 'embedding' ? 0 : (values.temperature ?? 0.3),
        max_tokens: category === 'embedding' ? 0 : (values.max_tokens ?? 4096),
        ...(category === 'chat' ? {
          top_p: values.top_p,
          frequency_penalty: values.frequency_penalty,
          presence_penalty: values.presence_penalty,
          max_retry: values.max_retry,
        } : {}),
        is_default: category === 'chat' ? values.is_default : false,
      }

      if (values.is_default && category === 'chat') {
        setModels(prev => prev.map(m => m.category === 'chat' ? { ...m, is_default: false } : m))
      }

      if (editingModel) {
        setModels(prev => prev.map(m => m.id === editingModel.id ? newModel : m))
      } else {
        setModels(prev => [...prev, newModel])
      }
      setModelModalVisible(false)
    } catch (error: any) {
      if (error?.message) {
        message.error(error.message)
      }
    }
  }

  const handleDeleteModel = (modelId: string) => {
    setModels(prev => prev.filter(m => m.id !== modelId))
  }

  const modelColumns = [
    {
      title: t('settings.modelCategory'),
      dataIndex: 'category',
      key: 'category',
      width: 80,
      render: (category: LLMModelCategory) => {
        const cfg = CATEGORY_TAG_MAP[category] || CATEGORY_TAG_MAP.chat
        return <Tag color={cfg.color} style={{ fontSize: 11 }}>{t(`settings.modelCategory_${category}`)}</Tag>
      },
    },
    { title: t('settings.providerName'), dataIndex: 'name', key: 'name', width: 110 },
    { title: t('settings.modelId'), dataIndex: 'model', key: 'model', width: 150 },
    {
      title: t('settings.defaultModel'),
      dataIndex: 'is_default',
      key: 'is_default',
      width: 50,
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
        const allModels: LLMModelConfig[] = record.models_json ? JSON.parse(record.models_json) : []
        const chatCount = allModels.filter((m: any) => (m.category || 'chat') === 'chat').length
        const embeddingCount = allModels.filter((m: any) => m.category === 'embedding').length
        return (
          <Space size={4} orientation="vertical" style={{ lineHeight: 1.4 }}>
            {chatCount > 0 && <Text style={{ fontSize: 12 }}>{t('settings.modelCategory_chat')} {chatCount}</Text>}
            {embeddingCount > 0 && <Text type="secondary" style={{ fontSize: 11 }}>{t('settings.modelCategory_embedding')} {embeddingCount}</Text>}
            {chatCount === 0 && embeddingCount === 0 && <Text type="secondary" style={{ fontSize: 11 }}>{t('settings.noModels')}</Text>}
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
                      scroll={{ x: 500 }}
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
                key: 'advanced',
                label: <span><GlobalOutlined /> {t('settings.advancedConfig')}</span>,
                children: (
                  <>
                    <Form.Item name="timeout_ms" label={t('settings.timeout')}>
                      <InputNumber min={1000} max={300000} step={1000} style={{ width: 180 }} />
                    </Form.Item>
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
            <Form.Item name="category" label={t('settings.modelCategory')} rules={[{ required: true }]} style={{ flex: 1 }}>
              <Select onChange={handleModelCategoryChange}>
                <Select.Option value="chat">{t('settings.modelCategory_chat')}</Select.Option>
                <Select.Option value="embedding">{t('settings.modelCategory_embedding')}</Select.Option>
              </Select>
            </Form.Item>
          </div>

          <div style={{ display: 'flex', gap: 16 }}>
            <Form.Item name="name" label={t('settings.displayName')} rules={[{ required: true, message: t('settings.enterName') }]} style={{ flex: 1 }}>
              <Input placeholder="DeepSeek-V3" />
            </Form.Item>
            <Form.Item name="model" label={t('settings.modelId')} rules={[{ required: true, message: t('settings.enterModelId') }]} style={{ flex: 1 }}>
              <Input placeholder={modelCategory === 'embedding' ? 'text-embedding-3-small' : 'deepseek-chat'} />
            </Form.Item>
          </div>

          {modelCategory === 'chat' && (
            <>
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
            </>
          )}

          {modelCategory === 'embedding' && (
            <div style={{ padding: '12px 0' }}>
              <Text type="secondary">{t('settings.embeddingModelHint')}</Text>
            </div>
          )}
        </Form>
      </Modal>
    </>
  )
}

export default LLMSettings
