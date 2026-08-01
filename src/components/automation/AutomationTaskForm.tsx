import { useEffect, useMemo, useState } from 'react'
import {
  Modal, Form, Input, Switch, DatePicker, Select, InputNumber, Row, Col, Divider, Tag, Space, Tooltip, theme,
} from 'antd'
import { InfoCircleOutlined } from '@ant-design/icons'
import dayjs from 'dayjs'
import { useTranslation } from 'react-i18next'
import type {
  AutomationTask,
  CreateAutomationTaskInput,
  UpdateAutomationTaskInput,
  AutomationRecurrenceRule,
} from '../../types/automation'
import { getProviderModels } from '../../utils/llm'

const MS = 1000

export type TaskFormMode = 'create' | 'edit'

interface AutomationTaskFormProps {
  open: boolean
  mode: TaskFormMode
  task?: AutomationTask | null
  employees: Array<{ id: string; name: string; status: string }>
  providers: any[]
  onClose: () => void
  onSubmit: (input: CreateAutomationTaskInput | UpdateAutomationTaskInput) => Promise<any>
}

type Freq = 'none' | 'daily' | 'weekdays' | 'weekly' | 'monthly' | 'yearly'

const FREQ_OPTIONS: { value: Freq; labelKey: string }[] = [
  { value: 'none', labelKey: 'automation.freqNone' },
  { value: 'daily', labelKey: 'automation.freqDaily' },
  { value: 'weekdays', labelKey: 'automation.freqWeekdays' },
  { value: 'weekly', labelKey: 'automation.freqWeekly' },
  { value: 'monthly', labelKey: 'automation.freqMonthly' },
  { value: 'yearly', labelKey: 'automation.freqYearly' },
]

const compactItem: React.CSSProperties = { marginBottom: 12 }

const AutomationTaskForm: React.FC<AutomationTaskFormProps> = ({
  open, mode, task, employees, providers, onClose, onSubmit,
}) => {
  const { t } = useTranslation()
  const { token } = theme.useToken()
  const [form] = Form.useForm()
  const isEdit = mode === 'edit'
  const [freq, setFreq] = useState<Freq>('none')
  const [selectedProviderId, setSelectedProviderId] = useState<string>('')

  const initialValues = useMemo(() => {
    if (isEdit && task) {
      const startMs = task.start_at * MS
      const f = task.recurrence_rule?.freq
      return {
        title: task.title,
        description: task.description || '',
        prompt: task.prompt,
        employee_id: task.employee_id,
        provider_id: task.provider_id,
        model_id: task.model_id || undefined,
        high_permission: task.high_permission,
        startAt: dayjs(startMs),
        recurrenceFreq: f || 'none',
        recurrenceInterval: task.recurrence_rule?.interval || 1,
        recurrenceCount: task.recurrence_rule?.count ?? undefined,
        recurrenceUntil: task.recurrence_rule?.until ? dayjs(task.recurrence_rule.until * MS) : undefined,
        is_enabled: task.is_enabled,
        notify_on_complete: task.notify_on_complete,
        retry_count: task.retry_count,
        tags: task.tags || [],
      }
    }
    // 默认值：当前时间 + 1 小时
    const start = dayjs().add(1, 'hour').minute(0).second(0)
    const defaultProvider = providers[0]?.id || ''
    return {
      title: '',
      description: '',
      prompt: '',
      employee_id: employees[0]?.id || '',
      provider_id: defaultProvider,
      model_id: undefined,
      high_permission: false,
      startAt: start,
      recurrenceFreq: 'none',
      recurrenceInterval: 1,
      recurrenceCount: undefined,
      recurrenceUntil: undefined,
      is_enabled: true,
      notify_on_complete: true,
      retry_count: 0,
      tags: [],
    }
  }, [isEdit, task, employees, providers])

  useEffect(() => {
    if (open) {
      form.resetFields()
      setFreq(initialValues.recurrenceFreq as Freq)
      setSelectedProviderId(initialValues.provider_id as string)
    }
  }, [open, initialValues, form])

  const currentProvider = providers.find((p) => p.id === selectedProviderId)
  const modelOptions = useMemo(() => {
    if (!currentProvider) return []
    return getProviderModels(currentProvider)
      .filter((m) => (m.category || 'chat') === 'chat')
      .map((m) => ({ label: m.name || m.model, value: m.model }))
  }, [currentProvider])

  const handleOk = async () => {
    try {
      const values = await form.validateFields()
      const startAt = Math.floor((values.startAt as dayjs.Dayjs).valueOf() / MS)
      const rule: AutomationRecurrenceRule | null =
        values.recurrenceFreq && values.recurrenceFreq !== 'none'
          ? {
              freq: values.recurrenceFreq,
              interval: Math.max(1, Number(values.recurrenceInterval) || 1),
              ...(values.recurrenceCount ? { count: Number(values.recurrenceCount) } : {}),
              ...(values.recurrenceUntil
                ? { until: Math.floor((values.recurrenceUntil as dayjs.Dayjs).valueOf() / MS) }
                : {}),
            }
          : null

      const payload: CreateAutomationTaskInput | UpdateAutomationTaskInput = isEdit
        ? {
            id: task!.id,
            title: values.title,
            description: values.description || '',
            prompt: values.prompt,
            employee_id: values.employee_id,
            provider_id: values.provider_id,
            model_id: values.model_id || null,
            high_permission: !!values.high_permission,
            start_at: startAt,
            recurrence_rule: rule,
            is_enabled: !!values.is_enabled,
            notify_on_complete: !!values.notify_on_complete,
            retry_count: Math.max(0, Math.min(3, Number(values.retry_count) || 0)),
            tags: values.tags || [],
          }
        : {
            title: values.title,
            description: values.description || '',
            prompt: values.prompt,
            employee_id: values.employee_id,
            provider_id: values.provider_id,
            model_id: values.model_id || null,
            high_permission: !!values.high_permission,
            start_at: startAt,
            recurrence_rule: rule,
            is_enabled: !!values.is_enabled,
            notify_on_complete: !!values.notify_on_complete,
            retry_count: Math.max(0, Math.min(3, Number(values.retry_count) || 0)),
            tags: values.tags || [],
          }
      await onSubmit(payload)
      onClose()
    } catch (err: any) {
      // 校验失败 antd 自动展示
    }
  }

  return (
    <Modal
      open={open}
      title={isEdit ? t('automation.editTask') : t('automation.createTask')}
      width={640}
      onCancel={onClose}
      onOk={handleOk}
      okText={isEdit ? t('common.save') : t('common.create')}
      cancelText={t('common.cancel')}
      destroyOnHidden
      mask={{ closable: false }}
    >
      <Form form={form} layout="vertical" initialValues={initialValues}>
        <Form.Item
          name="title"
          label={t('automation.fieldTitle')}
          rules={[{ required: true, message: t('automation.titleRequired') }]}
          style={compactItem}
        >
          <Input maxLength={100} placeholder={t('automation.titlePlaceholder')} />
        </Form.Item>

        <Form.Item name="description" label={t('automation.fieldDescription')} style={compactItem}>
          <Input.TextArea rows={2} maxLength={500} placeholder={t('automation.descriptionPlaceholder')} />
        </Form.Item>

        <Form.Item
          name="prompt"
          label={t('automation.fieldPrompt')}
          rules={[{ required: true, message: t('automation.promptRequired') }]}
          extra={<span style={{ fontSize: 12, color: token.colorTextTertiary }}>{t('automation.promptHint')}</span>}
          style={compactItem}
        >
          <Input.TextArea rows={4} maxLength={4000} placeholder={t('automation.promptPlaceholder')} />
        </Form.Item>

        <Row gutter={12}>
          <Col span={12}>
            <Form.Item
              name="employee_id"
              label={t('automation.fieldEmployee')}
              rules={[{ required: true, message: t('automation.employeeRequired') }]}
              style={compactItem}
            >
              <Select
                showSearch
                optionFilterProp="label"
                options={employees.map((e) => ({ label: e.name, value: e.id }))}
                placeholder={t('automation.fieldEmployee')}
              />
            </Form.Item>
          </Col>
          <Col span={12}>
            <Form.Item
              name="provider_id"
              label={t('automation.fieldProvider')}
              rules={[{ required: true, message: t('automation.providerRequired') }]}
              style={compactItem}
            >
              <Select
                showSearch
                optionFilterProp="label"
                options={providers.map((p) => ({ label: p.name, value: p.id }))}
                placeholder={t('automation.fieldProvider')}
                onChange={(v) => {
                  setSelectedProviderId(v as string)
                  form.setFieldValue('model_id', undefined)
                }}
              />
            </Form.Item>
          </Col>
        </Row>

        <Row gutter={12}>
          <Col span={12}>
            <Form.Item name="model_id" label={t('automation.fieldModel')} style={compactItem}>
              <Select
                showSearch
                optionFilterProp="label"
                options={modelOptions}
                placeholder={t('automation.modelPlaceholder')}
                allowClear
                notFoundContent={t('automation.noModels')}
              />
            </Form.Item>
          </Col>
          <Col span={12}>
            <Form.Item name="startAt" label={t('automation.fieldStartAt')} rules={[{ required: true }]} style={compactItem}>
              <DatePicker
                showTime={{ format: 'HH:mm' }}
                format="YYYY-MM-DD HH:mm"
                style={{ width: '100%' }}
              />
            </Form.Item>
          </Col>
        </Row>

        <Divider style={{ margin: '8px 0' }} />

        <Row gutter={12}>
          <Col span={8}>
            <Form.Item name="recurrenceFreq" label={t('automation.fieldRecurrence')} style={compactItem}>
              <Select
                options={FREQ_OPTIONS.map((o) => ({ label: t(o.labelKey), value: o.value }))}
                onChange={(v) => setFreq(v as Freq)}
              />
            </Form.Item>
          </Col>
          {freq !== 'none' && (
            <>
              <Col span={5}>
                <Form.Item name="recurrenceInterval" label={t('automation.fieldInterval')} style={compactItem}>
                  <InputNumber min={1} max={365} style={{ width: '100%' }} />
                </Form.Item>
              </Col>
              <Col span={5}>
                <Form.Item name="recurrenceCount" label={t('automation.fieldCount')} style={compactItem}>
                  <InputNumber min={1} max={999} style={{ width: '100%' }} placeholder={t('automation.countOptional')} />
                </Form.Item>
              </Col>
              <Col span={6}>
                <Form.Item name="recurrenceUntil" label={t('automation.fieldUntil')} style={compactItem}>
                  <DatePicker format="YYYY-MM-DD" style={{ width: '100%' }} />
                </Form.Item>
              </Col>
            </>
          )}
        </Row>

        <Row gutter={12}>
          <Col span={8}>
            <Form.Item name="retry_count" label={t('automation.fieldRetryCount')} style={compactItem}>
              <InputNumber min={0} max={3} style={{ width: '100%' }} />
            </Form.Item>
          </Col>
          <Col span={16}>
            <Form.Item name="tags" label={t('automation.fieldTags')} style={compactItem}>
              <Select mode="tags" placeholder={t('automation.tagsPlaceholder')} tokenSeparators={[',']} />
            </Form.Item>
          </Col>
        </Row>

        <Row gutter={12}>
          <Col span={8}>
            <Form.Item name="is_enabled" label={t('automation.fieldEnabled')} valuePropName="checked" style={compactItem}>
              <Switch />
            </Form.Item>
          </Col>
          <Col span={8}>
            <Form.Item
              name="notify_on_complete"
              label={t('automation.fieldNotify')}
              valuePropName="checked"
              style={compactItem}
            >
              <Switch />
            </Form.Item>
          </Col>
          <Col span={8}>
            <Form.Item
              name="high_permission"
              label={
                <Space size={4}>
                  <span>{t('automation.fieldHighPermission')}</span>
                  <Tooltip title={t('automation.highPermissionHint')}>
                    <InfoCircleOutlined style={{ color: token.colorTextTertiary }} />
                  </Tooltip>
                </Space>
              }
              valuePropName="checked"
              style={compactItem}
            >
              <Switch />
            </Form.Item>
          </Col>
        </Row>

        {freq !== 'none' && (
          <div style={{ marginBottom: 12 }}>
            <Tag color="blue">{t('automation.recurrencePreviewHint')}</Tag>
          </div>
        )}
      </Form>
    </Modal>
  )
}

export default AutomationTaskForm
