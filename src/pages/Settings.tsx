import { useState, useEffect } from 'react'
import {
  Card,
  Tabs,
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
  message,
  Popconfirm,
  Typography,
  Radio,
  Divider,
  Tooltip,
  Collapse,
} from 'antd'
import {
  PlusOutlined,
  EditOutlined,
  DeleteOutlined,
  ApiOutlined,
  CheckCircleOutlined,
  SyncOutlined,
  SettingOutlined,
  SaveOutlined,
  FolderOutlined,
  QuestionCircleOutlined,
  BulbOutlined,
  GlobalOutlined,
} from '@ant-design/icons'
import type { TabsProps } from 'antd'
import type { LLMProvider, LLMModelConfig, LLMProviderType } from '../types'

const { Text, Title } = Typography

const PROVIDER_TYPES: { value: LLMProviderType; label: string; group: string; icon?: string }[] = [
  { value: 'openai', label: 'OpenAI', group: '国际' },
  { value: 'openai-compatible', label: 'OpenAI 兼容接口', group: '国际' },
  { value: 'groq', label: 'Groq', group: '国际' },
  { value: 'mistral', label: 'Mistral AI', group: '国际' },
  { value: 'xai', label: 'xAI (Grok)', group: '国际' },
  { value: 'azure', label: 'Azure OpenAI', group: '国际' },
  { value: 'vertex', label: 'Google Vertex AI', group: '国际' },
  { value: 'bedrock', label: 'AWS Bedrock', group: '国际' },
  { value: 'deepseek', label: 'DeepSeek (深度求索)', group: '国产' },
  { value: 'qwen', label: '通义千问 (Qwen)', group: '国产' },
  { value: 'zhipu', label: '智谱 AI (GLM)', group: '国产' },
  { value: 'volcengine', label: '火山引擎 (豆包)', group: '国产' },
  { value: 'moonshot', label: 'Moonshot (Kimi)', group: '国产' },
  { value: 'yi', label: '零一万物 (Yi)', group: '国产' },
]

const PROVIDER_DEFAULTS: Record<string, { baseURL: string; defaultModel: string; defaultEmbeddingModel: string }> = {
  openai: { baseURL: 'https://api.openai.com/v1', defaultModel: 'gpt-4o-mini', defaultEmbeddingModel: 'text-embedding-3-small' },
  'openai-compatible': { baseURL: '', defaultModel: '', defaultEmbeddingModel: 'text-embedding-3-small' },
  deepseek: { baseURL: 'https://api.deepseek.com/v1', defaultModel: 'deepseek-chat', defaultEmbeddingModel: 'text-embedding-3-small' },
  qwen: { baseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1', defaultModel: 'qwen-plus', defaultEmbeddingModel: 'text-embedding-v3' },
  zhipu: { baseURL: 'https://open.bigmodel.cn/api/paas/v4', defaultModel: 'glm-4-flash', defaultEmbeddingModel: 'embedding-3' },
  volcengine: { baseURL: 'https://ark.cn-beijing.volces.com/api/v3', defaultModel: 'doubao-1-5-pro-32k', defaultEmbeddingModel: 'text-embedding-v3' },
  moonshot: { baseURL: 'https://api.moonshot.cn/v1', defaultModel: 'moonshot-v1-8k', defaultEmbeddingModel: 'text-embedding-3-small' },
  yi: { baseURL: 'https://api.lingyiwanwu.com/v1', defaultModel: 'yi-lightning', defaultEmbeddingModel: 'text-embedding-3-small' },
  groq: { baseURL: 'https://api.groq.com/openai/v1', defaultModel: 'llama-3.3-70b-versatile', defaultEmbeddingModel: 'text-embedding-3-small' },
  mistral: { baseURL: 'https://api.mistral.ai/v1', defaultModel: 'mistral-small-latest', defaultEmbeddingModel: 'mistral-embed' },
  azure: { baseURL: '', defaultModel: 'gpt-4o-mini', defaultEmbeddingModel: 'text-embedding-3-small' },
  vertex: { baseURL: '', defaultModel: 'gpt-4o-mini', defaultEmbeddingModel: 'text-embedding-3-small' },
  bedrock: { baseURL: '', defaultModel: 'gpt-4o-mini', defaultEmbeddingModel: 'text-embedding-3-small' },
  xai: { baseURL: 'https://api.x.ai/v1', defaultModel: 'grok-3-mini', defaultEmbeddingModel: 'text-embedding-3-small' },
}

const getProviderTypeLabel = (type: string): string => {
  const info = PROVIDER_TYPES.find((p) => p.value === type)
  return info?.label || type
}

const getProviderTypeGroup = (type: string): string => {
  const info = PROVIDER_TYPES.find((p) => p.value === type)
  return info?.group || '其他'
}

const Settings: React.FC = () => {
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
      console.error('加载LLM提供商失败:', error)
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
      const currentEmbedding = form.getFieldValue('embedding_model')

      if (!currentBaseUrl && defaults.baseURL) {
        form.setFieldsValue({ base_url: defaults.baseURL })
      }
      if (!currentModel && defaults.defaultModel) {
        form.setFieldsValue({ model: defaults.defaultModel })
      }
      if (!currentEmbedding && defaults.defaultEmbeddingModel) {
        form.setFieldsValue({ embedding_model: defaults.defaultEmbeddingModel })
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
      message.success('已删除')
      loadProviders()
    } catch {
      message.error('删除失败')
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
        message.success('更新成功')
      } else {
        await window.electronAPI.llm.createProvider(providerData)
        message.success('添加成功')
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
        message.success(`连接成功! 延迟: ${result.latency}ms`)
      } else {
        message.error(`连接失败: ${result.error}`)
      }
    } catch {
      message.error('测试连接失败')
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
      is_default: false,
      enable_thinking: false,
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
      enable_thinking: model.enable_thinking || false,
      thinking_budget: model.thinking_budget,
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
        enable_thinking: values.enable_thinking,
        thinking_budget: values.thinking_budget,
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
    { title: '名称', dataIndex: 'name', key: 'name', width: 120 },
    { title: '模型 ID', dataIndex: 'model', key: 'model', width: 160 },
    { title: '温度', dataIndex: 'temperature', key: 'temperature', width: 60 },
    { title: '最大 Token', dataIndex: 'max_tokens', key: 'max_tokens', width: 90 },
    {
      title: '思考模式',
      key: 'thinking',
      width: 80,
      render: (_: any, record: LLMModelConfig) =>
        record.enable_thinking ? <Tag color="blue" icon={<BulbOutlined />}>开启</Tag> : <Tag>关闭</Tag>,
    },
    {
      title: '默认',
      dataIndex: 'is_default',
      key: 'is_default',
      width: 60,
      render: (isDefault: boolean) => isDefault ? <CheckCircleOutlined style={{ color: '#52c41a' }} /> : null,
    },
    {
      title: '操作',
      key: 'actions',
      width: 80,
      render: (_: any, record: LLMModelConfig) => (
        <Space>
          <Button size="small" icon={<EditOutlined />} onClick={() => handleEditModel(record)} />
          <Popconfirm title="确定删除?" onConfirm={() => handleDeleteModel(record.id)}>
            <Button size="small" danger icon={<DeleteOutlined />} />
          </Popconfirm>
        </Space>
      ),
    },
  ]

  const columns = [
    {
      title: '名称',
      dataIndex: 'name',
      key: 'name',
      width: 140,
    },
    {
      title: '类型',
      dataIndex: 'provider_type',
      key: 'provider_type',
      width: 140,
      render: (type: string) => {
        const group = getProviderTypeGroup(type)
        const label = getProviderTypeLabel(type)
        return (
          <Space size={4}>
            <Tag color={group === '国产' ? 'red' : 'blue'} style={{ fontSize: 11 }}>{group}</Tag>
            <span style={{ fontSize: 12 }}>{label}</span>
          </Space>
        )
      },
    },
    {
      title: '模型',
      key: 'model_info',
      render: (_: any, record: LLMProvider) => {
        const modelCount = record.models_json ? JSON.parse(record.models_json).length : 0
        return (
          <Space size={4} orientation="vertical" style={{ lineHeight: 1.4 }}>
            <Text style={{ fontSize: 12 }}>{record.model}</Text>
            {modelCount > 0 && <Text type="secondary" style={{ fontSize: 11 }}>{modelCount} 个模型配置</Text>}
          </Space>
        )
      },
    },
    {
      title: '默认',
      dataIndex: 'is_default',
      key: 'is_default',
      width: 80,
      render: (isDefault: boolean) =>
        isDefault ? <CheckCircleOutlined style={{ color: '#52c41a' }} /> : null,
    },
    {
      title: '操作',
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
            测试
          </Button>
          <Button size="small" icon={<EditOutlined />} onClick={() => handleEdit(record)}>
            编辑
          </Button>
          <Popconfirm title="确定删除?" onConfirm={() => handleDelete(record.id)}>
            <Button size="small" danger icon={<DeleteOutlined />} />
          </Popconfirm>
        </Space>
      ),
    },
  ]

  const providerTypeOptions = [
    {
      label: '国产服务商',
      options: PROVIDER_TYPES.filter(p => p.group === '国产').map(p => ({ value: p.value, label: p.label })),
    },
    {
      label: '国际服务商',
      options: PROVIDER_TYPES.filter(p => p.group === '国际').map(p => ({ value: p.value, label: p.label })),
    },
  ]

  const llmTabContent = (
    <div>
      <div style={{ marginBottom: 16, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <Title level={5} style={{ margin: 0 }}>LLM 提供商</Title>
        <Button type="primary" icon={<PlusOutlined />} onClick={handleAdd}>
          添加提供商
        </Button>
      </div>

      <Table
        dataSource={providers}
        columns={columns}
        rowKey="id"
        pagination={false}
        scroll={{ y: 400 }}
        locale={{ emptyText: '暂无提供商，点击上方按钮添加' }}
      />
    </div>
  )

  const storageTabContent = (
    <div>
      <Title level={5}>数据存储</Title>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <div>
            <Text strong>数据存储目录</Text>
            <br />
            <Text type="secondary">所有项目、员工和对话数据存储位置</Text>
          </div>
          <Button icon={<FolderOutlined />}>选择目录</Button>
        </div>
        <Divider />
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <div>
            <Text strong>自动备份</Text>
            <br />
            <Text type="secondary">定期备份数据库和配置</Text>
          </div>
          <Select defaultValue="manual" style={{ width: 150 }} options={[
            { value: 'manual', label: '手动' },
            { value: 'daily', label: '每天' },
            { value: 'weekly', label: '每周' },
          ]} />
        </div>
        <Divider />
        <Button danger>清除所有数据</Button>
      </div>
    </div>
  )

  const appearanceTabContent = (
    <div>
      <Title level={5}>主题设置</Title>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <Text strong>主题模式</Text>
          <Radio.Group defaultValue="light" optionType="button" buttonStyle="solid">
            <Radio.Button value="light">亮色</Radio.Button>
            <Radio.Button value="dark">暗色</Radio.Button>
            <Radio.Button value="system">跟随系统</Radio.Button>
          </Radio.Group>
        </div>
        <Divider />
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <Text strong>字体大小</Text>
          <Radio.Group defaultValue="medium" optionType="button" buttonStyle="solid">
            <Radio.Button value="small">小</Radio.Button>
            <Radio.Button value="medium">中</Radio.Button>
            <Radio.Button value="large">大</Radio.Button>
          </Radio.Group>
        </div>
        <Divider />
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <Text strong>界面语言</Text>
          <Radio.Group defaultValue="zh-CN" optionType="button" buttonStyle="solid">
            <Radio.Button value="zh-CN">中文</Radio.Button>
            <Radio.Button value="en-US">English</Radio.Button>
          </Radio.Group>
        </div>
      </div>
    </div>
  )

  const aboutTabContent = (
    <div>
      <Title level={5}>关于 WorkAvatar</Title>
      <Space orientation="vertical" style={{ width: '100%' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between' }}>
          <Text type="secondary">版本号</Text>
          <Text>1.0.0-dev</Text>
        </div>
        <div style={{ display: 'flex', justifyContent: 'space-between' }}>
          <Text type="secondary">构建日期</Text>
          <Text>2026-05-06</Text>
        </div>
        <Divider />
        <Button block>导出日志</Button>
      </Space>
    </div>
  )

  const tabItems: TabsProps['items'] = [
    {
      key: 'llm',
      label: (
        <span>
          <ApiOutlined /> LLM 配置
        </span>
      ),
      children: llmTabContent,
    },
    {
      key: 'storage',
      label: (
        <span>
          <SaveOutlined /> 存储
        </span>
      ),
      children: storageTabContent,
    },
    {
      key: 'appearance',
      label: (
        <span>
          <SettingOutlined /> 外观
        </span>
      ),
      children: appearanceTabContent,
    },
    {
      key: 'about',
      label: '关于',
      children: aboutTabContent,
    },
  ]

  return (
    <div style={{ padding: 24, height: '100%', overflow: 'auto' }}>
      <Card>
        <Tabs items={tabItems} style={{ minHeight: 400 }} />
      </Card>

      <Modal
        title={editingProvider ? '编辑 LLM 提供商' : '添加 LLM 提供商'}
        open={modalVisible}
        onOk={handleSave}
        onCancel={() => setModalVisible(false)}
        width={780}
        okText="保存"
        cancelText="取消"
      >
        <Form form={form} layout="vertical" style={{ marginTop: 16 }}>
          <div style={{ display: 'flex', gap: 16 }}>
            <Form.Item name="name" label="名称" rules={[{ required: true, message: '请输入名称' }]} style={{ flex: 1 }}>
              <Input placeholder="例如：我的 DeepSeek" />
            </Form.Item>
            <Form.Item name="provider_type" label="提供商类型" rules={[{ required: true }]} style={{ flex: 1 }}>
              <Select
                options={providerTypeOptions}
                onChange={handleProviderTypeChange}
              />
            </Form.Item>
          </div>

          <div style={{ display: 'flex', gap: 16 }}>
            <Form.Item name="base_url" label={
              <span>API 端点 <Tooltip title="包含完整路径，如 https://api.deepseek.com/v1。选择服务商类型后会自动填充默认端点，也可手动修改"><QuestionCircleOutlined style={{ marginLeft: 4 }} /></Tooltip></span>
            } style={{ flex: 1 }}>
              <Input placeholder="https://api.openai.com/v1" />
            </Form.Item>
            <Form.Item name="api_key" label="API Key" style={{ flex: 1 }}
              extra="仅输入时更新，留空保持不变">
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
                label: <span><SettingOutlined /> 模型配置</span>,
                children: (
                  <>
                    <div style={{ marginBottom: 12, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                      <Text type="secondary">为该提供商配置可用模型，每个模型可独立设置参数和思考模式</Text>
                      <Button type="primary" size="small" icon={<PlusOutlined />} onClick={handleAddModel}>
                        添加模型
                      </Button>
                    </div>
                    <Table
                      dataSource={models}
                      columns={modelColumns}
                      rowKey="id"
                      size="small"
                      pagination={false}
                      locale={{ emptyText: '暂无配置的模型，请先添加' }}
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
                label: <span><SettingOutlined /> 默认参数（适用于未单独配置的模型）</span>,
                children: (
                  <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap' }}>
                    <Form.Item name="model" label="默认模型" rules={[{ required: true, message: '请输入模型名称' }]}>
                      <Input placeholder="gpt-4o-mini" style={{ width: 180 }} />
                    </Form.Item>
                    <Form.Item name="embedding_model" label={
                      <span>嵌入模型 <Tooltip title="用于 RAG 知识库的向量嵌入"><QuestionCircleOutlined style={{ marginLeft: 4 }} /></Tooltip></span>
                    }>
                      <Input placeholder="text-embedding-3-small" style={{ width: 180 }} />
                    </Form.Item>
                    <Form.Item name="temperature" label={
                      <span>温度 <Tooltip title="控制随机性，0=确定性，2=高随机性"><QuestionCircleOutlined style={{ marginLeft: 4 }} /></Tooltip></span>
                    }>
                      <InputNumber min={0} max={2} step={0.1} style={{ width: 120 }} />
                    </Form.Item>
                    <Form.Item name="max_tokens" label="最大 Token">
                      <InputNumber min={1} max={128000} step={1024} style={{ width: 140 }} />
                    </Form.Item>
                    <Form.Item name="timeout_ms" label="超时(ms)">
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
                label: <span><GlobalOutlined /> 高级配置</span>,
                children: (
                  <>
                    <Form.Item name="extra_headers_json" label={
                      <span>额外请求头 (JSON) <Tooltip title={'自定义 HTTP 请求头，如火山引擎的认证头。格式：{"Header-Name": "value"}'}><QuestionCircleOutlined style={{ marginLeft: 4 }} /></Tooltip></span>
                    }>
                      <Input.TextArea rows={2} placeholder='{"X-Custom-Header": "value"}' />
                    </Form.Item>
                    <Form.Item name="extra_body_json" label={
                      <span>额外请求体 (JSON) <Tooltip title="追加到每次 API 请求体中的额外参数，如服务商特有的配置项"><QuestionCircleOutlined style={{ marginLeft: 4 }} /></Tooltip></span>
                    }>
                      <Input.TextArea rows={2} placeholder='{"key": "value"}' />
                    </Form.Item>
                  </>
                ),
              },
            ]}
          />

          <Form.Item name="is_default" valuePropName="checked" label="设为默认提供商">
            <Switch />
          </Form.Item>
        </Form>
      </Modal>

      <Modal
        title={editingModel ? '编辑模型' : '添加模型'}
        open={modelModalVisible}
        onOk={handleSaveModel}
        onCancel={() => setModelModalVisible(false)}
        width={600}
        okText="保存"
        cancelText="取消"
      >
        <Form form={modelForm} layout="vertical" style={{ marginTop: 16 }}>
          <div style={{ display: 'flex', gap: 16 }}>
            <Form.Item name="name" label="显示名称" rules={[{ required: true, message: '请输入名称' }]} style={{ flex: 1 }}>
              <Input placeholder="例如：DeepSeek-V3" />
            </Form.Item>
            <Form.Item name="model" label="模型 ID" rules={[{ required: true, message: '请输入模型 ID' }]} style={{ flex: 1 }}>
              <Input placeholder="deepseek-chat" />
            </Form.Item>
          </div>

          <Divider plain>生成参数</Divider>

          <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap' }}>
            <Form.Item name="temperature" label={
              <span>Temperature <Tooltip title="控制随机性，0=确定性输出，2=高随机性"><QuestionCircleOutlined /></Tooltip></span>
            }>
              <InputNumber min={0} max={2} step={0.1} style={{ width: 120 }} />
            </Form.Item>
            <Form.Item name="max_tokens" label="最大 Token">
              <InputNumber min={1} max={128000} step={1024} style={{ width: 140 }} />
            </Form.Item>
            <Form.Item name="top_p" label={
              <span>Top P <Tooltip title="核采样参数，与 temperature 配合使用，通常二选一"><QuestionCircleOutlined /></Tooltip></span>
            }>
              <InputNumber min={0} max={1} step={0.05} style={{ width: 120 }} />
            </Form.Item>
          </div>

          <div style={{ display: 'flex', gap: 16 }}>
            <Form.Item name="frequency_penalty" label={
              <span>频率惩罚 <Tooltip title="-2~2，正值降低重复用词频率"><QuestionCircleOutlined /></Tooltip></span>
            }>
              <InputNumber min={-2} max={2} step={0.1} style={{ width: 120 }} />
            </Form.Item>
            <Form.Item name="presence_penalty" label={
              <span>存在惩罚 <Tooltip title="-2~2，正值增加话题多样性"><QuestionCircleOutlined /></Tooltip></span>
            }>
              <InputNumber min={-2} max={2} step={0.1} style={{ width: 120 }} />
            </Form.Item>
          </div>

          <Divider plain>
            <BulbOutlined /> 思考模式（Reasoning / Thinking）
          </Divider>

          <div style={{ background: '#f6f8fa', padding: 16, borderRadius: 8, marginBottom: 16 }}>
            <Form.Item name="enable_thinking" valuePropName="checked" label={
              <span>启用思考模式 <Tooltip title="开启后，模型会先进行内部推理再给出回答。DeepSeek Reasoner 通过 reasoning_content 返回思考过程，通义千问通过 enable_thinking 参数开启"><QuestionCircleOutlined style={{ marginLeft: 4 }} /></Tooltip></span>
            } style={{ marginBottom: 8 }}>
              <Switch />
            </Form.Item>
            <Form.Item noStyle shouldUpdate={(prev, cur) => prev.enable_thinking !== cur.enable_thinking}>
              {({ getFieldValue }) =>
                getFieldValue('enable_thinking') ? (
                  <Form.Item name="thinking_budget" label={
                    <span>思考预算 (Token) <Tooltip title="模型思考过程的最大 Token 数，仅部分服务商支持"><QuestionCircleOutlined style={{ marginLeft: 4 }} /></Tooltip></span>
                  }>
                    <InputNumber min={0} max={32768} step={1024} style={{ width: 180 }} placeholder="如 8192" />
                  </Form.Item>
                ) : null
              }
            </Form.Item>
            <Text type="secondary" style={{ fontSize: 12 }}>
              支持思考模式的服务商：DeepSeek (deepseek-reasoner)、通义千问 (Qwen/QwQ)、智谱 GLM (GLM-Z1) 等。
              开启后模型会先输出推理过程，再给出最终回答。
            </Text>
          </div>

          <Form.Item name="is_default" valuePropName="checked" label="设为该提供商的默认模型">
            <Switch />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  )
}

export default Settings
