import { useState } from 'react'
import { Form, Input, Button, Typography, theme, App } from 'antd'
import { IdcardOutlined, ToolOutlined, BookOutlined, RobotOutlined } from '@ant-design/icons'
import { useTranslation } from 'react-i18next'

const { Text, Title } = Typography
const { TextArea } = Input

interface EmployeeStepProps {
  onCreated: () => void
  onGoWizard: () => void
}

const EmployeeStep: React.FC<EmployeeStepProps> = ({ onCreated, onGoWizard }) => {
  const { t } = useTranslation()
  const { message } = App.useApp()
  const { token } = theme.useToken()
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

  const concepts = [
    { icon: <IdcardOutlined />, color: token.colorPrimary, bg: token.colorPrimaryBg, title: t('onboarding.employee.concept1Title'), desc: t('onboarding.employee.concept1Desc') },
    { icon: <ToolOutlined />, color: token.colorSuccess, bg: token.colorSuccessBg, title: t('onboarding.employee.concept2Title'), desc: t('onboarding.employee.concept2Desc') },
    { icon: <BookOutlined />, color: token.colorWarning, bg: token.colorWarningBg, title: t('onboarding.employee.concept3Title'), desc: t('onboarding.employee.concept3Desc') },
  ]

  return (
    <div style={{ textAlign: 'center', padding: '8px 0' }}>
      <Title level={3} style={{ marginBottom: 8 }}>{t('onboarding.employee.title')}</Title>
      <Text type="secondary" style={{ display: 'block', maxWidth: 560, margin: '0 auto 24px' }}>
        {t('onboarding.employee.desc')}
      </Text>

      <div style={{ display: 'flex', gap: 14, justifyContent: 'center', flexWrap: 'wrap', marginBottom: 24 }}>
        {concepts.map((c) => (
          <div
            key={c.title}
            style={{
              width: 250, padding: '16px 16px', borderRadius: 12, textAlign: 'left',
              background: token.colorBgContainer, border: `1px solid ${token.colorBorderSecondary}`,
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
              <div style={{ width: 28, height: 28, borderRadius: 8, background: c.bg, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                <span style={{ color: c.color, fontSize: 14 }}>{c.icon}</span>
              </div>
              <Text strong style={{ fontSize: 13 }}>{c.title}</Text>
            </div>
            <Text type="secondary" style={{ fontSize: 12, lineHeight: 1.6 }}>{c.desc}</Text>
          </div>
        ))}
      </div>

      <div
        style={{
          maxWidth: 560, margin: '0 auto', padding: '20px 24px 24px', borderRadius: 12, textAlign: 'left',
          background: token.colorBgContainer, border: `1px solid ${token.colorBorderSecondary}`,
        }}
      >
        <Text strong style={{ display: 'block', marginBottom: 16 }}>
          <RobotOutlined style={{ color: token.colorPrimary, marginRight: 8 }} />
          {t('onboarding.employee.quickCreateTitle')}
        </Text>
        <Form form={form} layout="vertical">
          <Form.Item
            name="name"
            label={t('onboarding.employee.name')}
            rules={[{ required: true, message: t('onboarding.employee.nameRequired') }]}
            style={{ marginBottom: 14 }}
          >
            <Input placeholder={t('onboarding.employee.namePlaceholder')} maxLength={30} />
          </Form.Item>
          <Form.Item
            name="rules"
            label={t('onboarding.employee.rules')}
            rules={[{ required: true, message: t('onboarding.employee.rulesRequired') }]}
            style={{ marginBottom: 16 }}
          >
            <TextArea rows={4} maxLength={2000} showCount placeholder={t('onboarding.employee.rulesPlaceholder')} />
          </Form.Item>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <Button type="primary" loading={creating} onClick={handleCreate}>
              {t('onboarding.employee.create')}
            </Button>
            <Button type="link" onClick={onGoWizard}>
              {t('onboarding.employee.useFullWizard')}
            </Button>
          </div>
        </Form>
      </div>
    </div>
  )
}

export default EmployeeStep
