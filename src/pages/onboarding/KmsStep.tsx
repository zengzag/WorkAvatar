import { Typography, theme, Alert } from 'antd'
import { FolderAddOutlined, FileSearchOutlined, MessageOutlined, RightOutlined } from '@ant-design/icons'
import { useTranslation } from 'react-i18next'

const { Text, Title } = Typography

const KmsStep: React.FC = () => {
  const { t } = useTranslation()
  const { token } = theme.useToken()

  const steps = [
    { icon: <FolderAddOutlined />, color: token.colorPrimary, bg: token.colorPrimaryBg, title: t('onboarding.kms.step1Title'), desc: t('onboarding.kms.step1Desc') },
    { icon: <FileSearchOutlined />, color: token.colorSuccess, bg: token.colorSuccessBg, title: t('onboarding.kms.step2Title'), desc: t('onboarding.kms.step2Desc') },
    { icon: <MessageOutlined />, color: token.colorWarning, bg: token.colorWarningBg, title: t('onboarding.kms.step3Title'), desc: t('onboarding.kms.step3Desc') },
  ]

  return (
    <div style={{ textAlign: 'center', padding: '8px 0' }}>
      <Title level={3} style={{ marginBottom: 8 }}>{t('onboarding.kms.title')}</Title>
      <Text type="secondary" style={{ display: 'block', maxWidth: 560, margin: '0 auto 32px' }}>
        {t('onboarding.kms.desc')}
      </Text>

      <div style={{ display: 'flex', alignItems: 'stretch', justifyContent: 'center', gap: 8, flexWrap: 'wrap', marginBottom: 28 }}>
        {steps.map((s, i) => (
          <div key={s.title} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            {i > 0 && <RightOutlined style={{ color: token.colorTextQuaternary, fontSize: 14 }} />}
            <div
              style={{
                width: 230, padding: '20px 16px', borderRadius: 12, textAlign: 'left',
                background: token.colorBgContainer, border: `1px solid ${token.colorBorderSecondary}`,
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10 }}>
                <div style={{ width: 34, height: 34, borderRadius: 10, background: s.bg, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                  <span style={{ color: s.color, fontSize: 17 }}>{s.icon}</span>
                </div>
                <Text strong style={{ fontSize: 12 }}>{i + 1}. {s.title}</Text>
              </div>
              <Text type="secondary" style={{ fontSize: 12, lineHeight: 1.6 }}>{s.desc}</Text>
            </div>
          </div>
        ))}
      </div>

      <Alert
        type="info"
        showIcon
        message={t('onboarding.kms.chatTip')}
        style={{ maxWidth: 620, margin: '0 auto', textAlign: 'left' }}
      />
    </div>
  )
}

export default KmsStep
