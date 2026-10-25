import { useState } from 'react'
import { Form, Input, Select, Button, Alert, Typography, theme, App } from 'antd'
import { CheckCircleFilled, PlusOutlined } from '@ant-design/icons'
import { useTranslation } from 'react-i18next'
import { PROVIDER_TYPES, PROVIDER_DEFAULTS } from '../../components/settings/LLMSettings'
import { invalidateProvidersCache } from '../../hooks/useLlmSettings'
import { setSceneDefaultModel } from '../../utils/default-model'
import { generateId } from '../../utils/format'
import type { LLMProvider } from '../../types'

const { Text, Title } = Typography

interface ModelStepProps {
  providers: LLMProvider[]
  onConfigured: () => void
}

const ModelStep: React.FC<ModelStepProps> = ({ providers, onConfigured }) => {
  const { t } = useTranslation()
  const { message } = App.useApp()
  const { token } = theme.useToken()
  const [form] = Form.useForm()
  const [providerType, setProviderType] = useState('deepseek')
  const [saving, setSaving] = useState(false)
  const [errorText, setErrorText] = useState('')
  const [success, setSuccess] = useState(false)
  const [createdProviderId, setCreatedProviderId] = useState<string | null>(null)
  const [modelEntryId, setModelEntryId] = useState<string | null>(null)
  const [showForm, setShowForm] = useState(false)

  const hasProvider = providers.length > 0
  const needsBaseUrl = providerType === 'openai-compatible'

  const groupLabel = (group: string) => {
    switch (group) {
      case 'international': return t('onboarding.model.groupInternational')
      case 'domestic': return t('onboarding.model.groupDomestic')
      default: return t('onboarding.model.groupLocal')
    }
  }

  const typeOptions = ['international', 'domestic', 'local'].map((group) => ({
    label: groupLabel(group),
    title: groupLabel(group),
    options: PROVIDER_TYPES.filter((p) => p.group === group).map((p) => ({
      value: p.value,
      label: p.labelKey ? t(p.labelKey) : p.label,
    })),
  }))

  const typeLabel = (value: string) => {
    const info = PROVIDER_TYPES.find((p) => p.value === value)
    return info ? (info.labelKey ? t(info.labelKey) : info.label) : value
  }

  const handleTypeChange = (type: string) => {
    setProviderType(type)
    form.setFieldsValue({ base_url: PROVIDER_DEFAULTS[type]?.baseURL || '' })
  }

  const validateBaseUrl = (_: unknown, value: string) => {
    if (!value && form.getFieldValue('provider_type') === 'openai-compatible') {
      return Promise.reject(new Error(t('onboarding.model.baseUrlRequired')))
    }
    return Promise.resolve()
  }

  const openNewForm = () => {
    setCreatedProviderId(null)
    setModelEntryId(null)
    setSuccess(false)
    setErrorText('')
    form.resetFields()
    setProviderType('deepseek')
    setShowForm(true)
  }

  const handleSaveAndTest = async () => {
    let values: { provider_type: string; base_url?: string; api_key?: string; model: string }
    try {
      values = await form.validateFields()
    } catch {
      return
    }
    setSaving(true)
    setErrorText('')
    try {
      const entryId = modelEntryId || `model_${generateId()}`
      const models = [{
        id: entryId,
        name: values.model,
        model: values.model,
        category: 'chat' as const,
        temperature: 0.7,
        max_tokens: 32 * 1024,
        context_window: 256 * 1024,
      }]
      const payload: any = {
        name: typeLabel(values.provider_type),
        provider_type: values.provider_type,
        base_url: values.base_url || undefined,
        model: values.model,
        models_json: JSON.stringify(models),
        is_default: true,
      }
      if (values.api_key) payload.api_key = values.api_key

      let providerId: string
      if (!createdProviderId) {
        const res: any = await window.electronAPI.llm.createProvider(payload)
        if (res?.error) throw new Error(res.error)
        providerId = res.id
        setCreatedProviderId(providerId)
        setModelEntryId(entryId)
      } else {
        providerId = createdProviderId
        const res: any = await window.electronAPI.llm.updateProvider({ id: providerId, ...payload })
        if (res?.error) throw new Error(res.error)
      }

      const test = await window.electronAPI.llm.testConnection({ provider_id: providerId })
      if (!test?.success) throw new Error(test?.error || t('onboarding.model.testFailed'))

      invalidateProvidersCache()
      await setSceneDefaultModel('workbench', { provider_id: providerId, model_id: entryId })
      setSuccess(true)
      setShowForm(false)
      onConfigured()
      message.success(t('onboarding.model.testSuccess'))
    } catch (e: any) {
      setErrorText(e?.message || String(e))
    } finally {
      setSaving(false)
    }
  }

  const renderForm = () => (
    <Form
      form={form}
      layout="vertical"
      initialValues={{
        provider_type: 'deepseek',
        base_url: PROVIDER_DEFAULTS.deepseek?.baseURL || '',
      }}
    >
      <Form.Item
        name="provider_type"
        label={t('onboarding.model.type')}
        rules={[{ required: true }]}
      >
        <Select options={typeOptions} showSearch optionFilterProp="label" onChange={handleTypeChange} placeholder={t('onboarding.model.typePlaceholder')} />
      </Form.Item>
      <Form.Item name="api_key" label={t('onboarding.model.apiKey')}>
        <Input.Password placeholder={t('onboarding.model.apiKeyPlaceholder')} autoComplete="new-password" />
      </Form.Item>
      <Form.Item
        name="model"
        label={t('onboarding.model.modelId')}
        rules={[{ required: true, message: t('onboarding.model.modelIdRequired') }]}
      >
        <Input placeholder={t('onboarding.model.modelIdPlaceholder')} />
      </Form.Item>
      {needsBaseUrl && (
        <Form.Item
          name="base_url"
          label={t('onboarding.model.baseUrl')}
          rules={[{ validator: validateBaseUrl }]}
        >
          <Input placeholder={t('onboarding.model.baseUrlPlaceholder')} />
        </Form.Item>
      )}
      <Button type="primary" loading={saving} onClick={handleSaveAndTest}>
        {t('onboarding.model.saveAndTest')}
      </Button>
    </Form>
  )

  return (
    <div>
      <Title level={4} style={{ marginBottom: 8 }}>{t('onboarding.model.title')}</Title>
      <Text type="secondary" style={{ display: 'block', marginBottom: 20 }}>
        {t('onboarding.model.desc')}
      </Text>

      {success && (
        <Alert
          type="success"
          showIcon
          icon={<CheckCircleFilled />}
          message={t('onboarding.model.successTitle')}
          description={t('onboarding.model.successDesc')}
          style={{ marginBottom: 16 }}
        />
      )}

      {errorText && (
        <Alert
          type="error"
          showIcon
          message={t('onboarding.model.failedTitle')}
          description={
            <div>
              <div style={{ wordBreak: 'break-all' }}>{errorText}</div>
              <Text type="secondary" style={{ fontSize: 12 }}>{t('onboarding.model.retryHint')}</Text>
            </div>
          }
          style={{ marginBottom: 16 }}
        />
      )}

      {hasProvider && !showForm ? (
        <div
          style={{
            display: 'flex', alignItems: 'center', gap: 10, padding: '12px 14px',
            borderRadius: 8, background: token.colorSuccessBg,
            border: `1px solid ${token.colorSuccessBorder}`,
          }}
        >
          <CheckCircleFilled style={{ fontSize: 16, color: token.colorSuccess }} />
          <div style={{ flex: 1, minWidth: 0 }}>
            <Text style={{ display: 'block' }}>{t('onboarding.model.configuredTitle')}</Text>
            <Text type="secondary" style={{ fontSize: 12 }}>
              {t('onboarding.model.configuredDesc', { total: providers.length })}
            </Text>
          </div>
          <Button size="small" icon={<PlusOutlined />} onClick={openNewForm}>
            {t('onboarding.model.addAnother')}
          </Button>
        </div>
      ) : (
        renderForm()
      )}
    </div>
  )
}

export default ModelStep
