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
} from '@ant-design/icons'
import type { TabsProps } from 'antd'
import type { LLMProvider, LLMModelConfig } from '../types'

const { Text, Title } = Typography

const PROVIDER_TYPES = [
  { value: 'openai', label: 'OpenAI' },
  { value: 'openai-compatible', label: 'OpenAI 兼容接口' },
  { value: 'groq', label: 'Groq' },
  { value: 'mistral', label: 'Mistral AI' },
  { value: 'azure', label: 'Azure OpenAI' },
  { value: 'vertex', label: 'Google Vertex AI' },
  { value: 'bedrock', label: 'AWS Bedrock' },
  { value: 'xai', label: 'xAI' },
]

const Settings: React.FC = () => {
  const [providers, setProviders] = useState<LLMProvider[]>([])
  const [modalVisible, setModalVisible] = useState(false)
  const [editingProvider, setEditingProvider] = useState<LLMProvider | null>(null)
  const [testingId, setTestingId] = useState<string | null>(null)
  const [form] = Form.useForm()
  const [llmEnabled, setLlmEnabled] = useState(true)
  const [previewData, setPreviewData] = useState(false)
  const [models, setModels] = useState<LLMModelConfig[]>([])
  const [modelModalVisible, setModelModalVisible] = useState(false)
  const [editingModel, setEditingModel] = useState<LLMModelConfig | null>(null)
  const [modelForm] = Form.useForm()

  useEffect(() => {
    loadProviders()
    loadSettings()
  }, [])

  const loadProviders = async () => {
    try {
      const result = await window.electronAPI.llm.getProviders()
      setProviders(result as LLMProvider[])
    } catch (error) {
      console.error('加载LLM提供商失败:', error)
    }
  }

  const loadSettings = async () => {
    try {
      const send = await window.electronAPI.settings.get({ key: 'llm_data_send_enabled' })
      const preview = await window.electronAPI.settings.get({ key: 'llm_preview_before_send' })
      setLlmEnabled(send !== '0')
      setPreviewData(preview === '1')
    } catch {}
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

  const handleSettingsChange = async (key: string, value: string) => {
    await window.electronAPI.settings.set({ key, value })
  }

  const handleAddModel = () => {
    setEditingModel(null)
    modelForm.resetFields()
    modelForm.setFieldsValue({
      temperature: 0.3,
      max_tokens: 4096,
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
    { title: '名称', dataIndex: 'name', key: 'name' },
    { title: '模型 ID', dataIndex: 'model', key: 'model' },
    { title: '温度', dataIndex: 'temperature', key: 'temperature' },
    { title: '最大 Token', dataIndex: 'max_tokens', key: 'max_tokens' },
    { 
      title: '默认', 
      dataIndex: 'is_default', 
      key: 'is_default',
      render: (isDefault: boolean) => isDefault ? <CheckCircleOutlined style={{ color: '#52c41a' }} /> : null,
    },
    {
      title: '操作',
      key: 'actions',
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
    },
    {
      title: '类型',
      dataIndex: 'provider_type',
      key: 'provider_type',
      render: (type: string) => {
        const info = PROVIDER_TYPES.find((p) => p.value === type)
        return <Tag>{info?.label || type}</Tag>
      },
    },
    {
      title: '默认模型',
      dataIndex: 'model',
      key: 'model',
    },
    {
      title: '嵌入模型',
      dataIndex: 'embedding_model',
      key: 'embedding_model',
      render: (model: string) => model || 'text-embedding-3-small',
    },
    {
      title: '模型数量',
      key: 'model_count',
      render: (_: any, record: LLMProvider) => {
        const count = record.models_json 
          ? JSON.parse(record.models_json).length 
          : 0
        return <Tag>{count}</Tag>
      },
    },
    {
      title: '端点',
      dataIndex: 'base_url',
      key: 'base_url',
      ellipsis: true,
      render: (url: string) => url || '默认',
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
        locale={{ emptyText: '暂无提供商，点击上方按钮添加' }}
      />

      <Divider />

      <Title level={5}>数据发送控制</Title>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <div>
            <Text strong>允许发送文本到 LLM</Text>
            <br />
            <Text type="secondary">关闭后所有需要LLM的技能降级为仅本地规则执行</Text>
          </div>
          <Switch
            checked={llmEnabled}
            onChange={(v) => {
              setLlmEnabled(v)
              handleSettingsChange('llm_data_send_enabled', v ? '1' : '0')
            }}
          />
        </div>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <div>
            <Text strong>预览即将发送的数据</Text>
            <br />
            <Text type="secondary">开启后，每次LLM调用前弹窗展示将发送的prompt和上下文</Text>
          </div>
          <Switch
            checked={previewData}
            onChange={(v) => {
              setPreviewData(v)
              handleSettingsChange('llm_preview_before_send', v ? '1' : '0')
            }}
          />
        </div>
      </div>
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
        <Button block>检查更新</Button>
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
        width={700}
        okText="保存"
        cancelText="取消"
      >
        <Form form={form} layout="vertical" style={{ marginTop: 16 }}>
          <Form.Item name="name" label="名称" rules={[{ required: true, message: '请输入名称' }]}>
            <Input placeholder="例如：我的 OpenAI" />
          </Form.Item>

          <Form.Item name="provider_type" label="提供商类型" rules={[{ required: true }]}>
            <Select options={PROVIDER_TYPES} />
          </Form.Item>

          <Form.Item name="base_url" label="API 端点 (Base URL)" extra="包含完整路径，例如 https://api.openai.com/v1，留空使用默认端点">
            <Input placeholder="https://api.openai.com/v1" />
          </Form.Item>

          <Form.Item name="api_key" label="API Key" extra="仅输入时更新，留空保持不变">
            <Input.Password placeholder="sk-..." />
          </Form.Item>

          <Form.Item name="embedding_model" label="嵌入模型" extra="用于 RAG 知识库的向量嵌入">
            <Input placeholder="text-embedding-3-small" />
          </Form.Item>

          <Divider>模型配置</Divider>
          
          <div style={{ marginBottom: 16 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
              <Text strong>已配置模型</Text>
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
            />
          </div>

          <Divider>默认参数 (适用于未配置的模型)</Divider>
          
          <Space style={{ width: '100%' }} size="middle" wrap>
            <Form.Item name="model" label="默认模型" rules={[{ required: true, message: '请输入模型名称' }]}>
              <Input placeholder="gpt-4o-mini" />
            </Form.Item>
            <Form.Item name="temperature" label="温度">
              <InputNumber min={0} max={2} step={0.1} style={{ width: 120 }} />
            </Form.Item>
            <Form.Item name="max_tokens" label="最大 Token">
              <InputNumber min={1} max={128000} step={1024} style={{ width: 160 }} />
            </Form.Item>
            <Form.Item name="timeout_ms" label="超时(ms)">
              <InputNumber min={1000} max={300000} step={1000} style={{ width: 140 }} />
            </Form.Item>
          </Space>

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
        width={500}
        okText="保存"
        cancelText="取消"
      >
        <Form form={modelForm} layout="vertical" style={{ marginTop: 16 }}>
          <Form.Item name="name" label="显示名称" rules={[{ required: true, message: '请输入名称' }]}>
            <Input placeholder="例如：GPT-4o" />
          </Form.Item>
          <Form.Item name="model" label="模型 ID" rules={[{ required: true, message: '请输入模型 ID' }]}>
            <Input placeholder="gpt-4o" />
          </Form.Item>
          <Form.Item name="temperature" label="温度">
            <InputNumber min={0} max={2} step={0.1} style={{ width: '100%' }} />
          </Form.Item>
          <Form.Item name="max_tokens" label="最大 Token">
            <InputNumber min={1} max={128000} step={1024} style={{ width: '100%' }} />
          </Form.Item>
          <Form.Item name="is_default" valuePropName="checked" label="设为该提供商的默认模型">
            <Switch />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  )
}

export default Settings
