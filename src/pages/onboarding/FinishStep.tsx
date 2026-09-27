import { Button, Typography, theme } from 'antd'
import { CheckCircleFilled, MinusCircleFilled, DatabaseOutlined, RocketOutlined } from '@ant-design/icons'
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
    {
      done: false,
      title: t('onboarding.finish.kmsPending'),
      desc: t('onboarding.finish.kmsPendingHint'),
      action: (
        <Button size="small" icon={<DatabaseOutlined />} onClick={onGoKms}>
          {t('onboarding.finish.goKms')}
        </Button>
      ),
    },
  ]

  return (
    <div style={{ textAlign: 'center', padding: '16px 0' }}>
      <CheckCircleFilled style={{ fontSize: 56, color: token.colorSuccess, marginBottom: 20 }} />
      <Title level={2} style={{ marginBottom: 10 }}>{t('onboarding.finish.title')}</Title>
      <Text type="secondary" style={{ display: 'block', marginBottom: 32 }}>
        {t('onboarding.finish.desc')}
      </Text>

      <div
        style={{
          maxWidth: 520, margin: '0 auto 32px', padding: '8px 20px', borderRadius: 12, textAlign: 'left',
          background: token.colorBgContainer, border: `1px solid ${token.colorBorderSecondary}`,
        }}
      >
        {rows.map((r, i) => (
          <div
            key={r.title}
            style={{
              display: 'flex', alignItems: 'center', gap: 12, padding: '14px 0',
              borderBottom: i < rows.length - 1 ? `1px solid ${token.colorBorderSecondary}` : 'none',
            }}
          >
            {r.done
              ? <CheckCircleFilled style={{ fontSize: 18, color: token.colorSuccess, flexShrink: 0 }} />
              : <MinusCircleFilled style={{ fontSize: 18, color: token.colorTextQuaternary, flexShrink: 0 }} />}
            <div style={{ flex: 1, minWidth: 0 }}>
              <Text strong={r.done} style={{ display: 'block', fontSize: 13 }}>{r.title}</Text>
              {r.desc && <Text type="secondary" style={{ fontSize: 12 }}>{r.desc}</Text>}
            </div>
            {r.action}
          </div>
        ))}
      </div>

      <Button type="primary" size="large" icon={<RocketOutlined />} onClick={onStart}>
        {t('onboarding.finish.start')}
      </Button>
    </div>
  )
}

export default FinishStep
