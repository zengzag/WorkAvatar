import { useState } from 'react'
import { Form, Input, Button, Typography, App } from 'antd'
import { useTranslation } from 'react-i18next'

const { Text, Title } = Typography
const { TextArea } = Input

interface EmployeeStepProps {
  onCreated: () => void
}

const EmployeeStep: React.FC<EmployeeStepProps> = ({ onCreated }) => {
  const { t } = useTranslation()
  const { message } = App.useApp()
  const [form] = Form.useForm()
  const [creating, setCreating] = useState(false)

  const handleCreate = async () => {
    let values: { name: string; rules: string }
    try {
      values = await form.validateFields()
    } catch {
      return
    }
    setCreating(true)
    try {
      await window.electronAPI.employee.create({
        name: values.name.trim(),
        description: values.rules.trim().slice(0, 150),
        rules: values.rules.trim(),
        profile_json: '',
      })
      message.success(t('onboarding.employee.createSuccess'))
      onCreated()
    } catch (e: any) {
      message.error(e?.message || String(e))
    } finally {
      setCreating(false)
    }
  }

  return (
    <div>
      <Title level={4} style={{ marginBottom: 8 }}>{t('onboarding.employee.title')}</Title>
      <Text type="secondary" style={{ display: 'block', marginBottom: 20 }}>
        {t('onboarding.employee.desc')}
      </Text>

      <Form form={form} layout="vertical">
        <Form.Item
          name="name"
          label={t('onboarding.employee.name')}
          rules={[{ required: true, message: t('onboarding.employee.nameRequired') }]}
        >
          <Input placeholder={t('onboarding.employee.namePlaceholder')} maxLength={30} />
        </Form.Item>
        <Form.Item
          name="rules"
          label={t('onboarding.employee.rules')}
          rules={[{ required: true, message: t('onboarding.employee.rulesRequired') }]}
        >
          <TextArea rows={4} maxLength={2000} showCount placeholder={t('onboarding.employee.rulesPlaceholder')} />
        </Form.Item>
        <Button type="primary" loading={creating} onClick={handleCreate}>
          {t('onboarding.employee.create')}
        </Button>
      </Form>
    </div>
  )
}

export default EmployeeStep
