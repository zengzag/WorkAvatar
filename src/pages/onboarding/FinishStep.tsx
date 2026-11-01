import { Button, Typography, theme, Space } from 'antd'
import { CheckCircleFilled, MinusCircleFilled } from '@ant-design/icons'
import { useTranslation } from 'react-i18next'

const { Text, Title } = Typography

interface FinishStepProps {
  hasProvider: boolean
  hasEmployee: boolean
  onGoKms: () => void
  onStart: () => void
}

const FinishStep: React.FC<FinishStepProps> = ({ hasProvider, hasEmployee, onGoKms, onStart }) => {
  const { t } = useTranslation()
  const { token } = theme.useToken()

  const rows = [
    {
      done: hasProvider,
      title: hasProvider ? t('onboarding.finish.modelDone') : t('onboarding.finish.modelPending'),
      desc: hasProvider ? '' : t('onboarding.finish.modelPendingHint'),
    },
    {
      done: hasEmployee,
      title: hasEmployee ? t('onboarding.finish.employeeDone') : t('onboarding.finish.employeePending'),
      desc: hasEmployee ? '' : t('onboarding.finish.employeePendingHint'),
    },
  ]

  return (
    <div>
      <Title level={4} style={{ marginBottom: 8 }}>{t('onboarding.finish.title')}</Title>
      <Text type="secondary" style={{ display: 'block', marginBottom: 20 }}>
        {t('onboarding.finish.desc')}
      </Text>

      <div style={{ border: `1px solid ${token.colorBorderSecondary}`, borderRadius: 8, padding: '4px 14px', marginBottom: 16 }}>
        {rows.map((r, i) => (
          <div
            key={r.title}
            style={{
              display: 'flex', alignItems: 'flex-start', gap: 10, padding: '12px 0',
              borderBottom: i < rows.length - 1 ? `1px solid ${token.colorBorderSecondary}` : 'none',
            }}
          >
            {r.done
              ? <CheckCircleFilled style={{ fontSize: 16, color: token.colorSuccess, marginTop: 2 }} />
              : <MinusCircleFilled style={{ fontSize: 16, color: token.colorTextQuaternary, marginTop: 2 }} />}
            <div style={{ flex: 1, minWidth: 0 }}>
              <Text style={{ display: 'block' }}>{r.title}</Text>
              {r.desc && <Text type="secondary" style={{ fontSize: 12 }}>{r.desc}</Text>}
            </div>
          </div>
        ))}
      </div>

      <Text type="secondary" style={{ fontSize: 12, display: 'block', marginBottom: 24 }}>
        {t('onboarding.finish.kmsHint')}
      </Text>

      <Space size={12}>
        <Button onClick={onGoKms}>{t('onboarding.finish.goKms')}</Button>
        <Button type="primary" onClick={onStart}>{t('onboarding.finish.start')}</Button>
      </Space>
    </div>
  )
}

export default FinishStep
