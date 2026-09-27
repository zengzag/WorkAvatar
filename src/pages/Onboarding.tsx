import { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { Steps, Button, Typography, theme, Spin } from 'antd'
import { ApiOutlined, RobotOutlined, DatabaseOutlined } from '@ant-design/icons'
import type { LLMProvider } from '../types'
import { useAppearanceStore, getEffectiveTheme } from '../stores/appearance.store'
import ModelStep from './onboarding/ModelStep'
import EmployeeStep from './onboarding/EmployeeStep'
import KmsStep from './onboarding/KmsStep'
import FinishStep from './onboarding/FinishStep'

const { Text, Title, Paragraph } = Typography

const ONBOARDING_COMPLETED_KEY = 'onboarding_completed'

const Onboarding: React.FC = () => {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const { token } = theme.useToken()
  const themeMode = useAppearanceStore((s) => s.themeMode)
  const isDark = getEffectiveTheme(themeMode) === 'dark'
  const [step, setStep] = useState(0)
  const [initializing, setInitializing] = useState(true)
  const [providers, setProviders] = useState<LLMProvider[]>([])
  const [hasEmployee, setHasEmployee] = useState(false)

  useEffect(() => {
    Promise.all([
      window.electronAPI.llm.getProviders().catch(() => []),
      window.electronAPI.employee.list().catch(() => []),
    ]).then(([ps, es]) => {
      setProviders(Array.isArray(ps) ? (ps as LLMProvider[]) : [])
      setHasEmployee(Array.isArray(es) && es.length > 0)
      setInitializing(false)
    })
  }, [])

  const hasProvider = providers.length > 0

  const finish = async (target?: string) => {
    try {
      await window.electronAPI.settings.set({ key: ONBOARDING_COMPLETED_KEY, value: 'true' })
    } catch { /* 标志写失败不阻塞进入应用 */ }
    navigate(target || (hasEmployee ? '/tasks' : '/employees'))
  }

  const reloadProviders = async () => {
    try {
      const ps = await window.electronAPI.llm.getProviders()
      setProviders(Array.isArray(ps) ? (ps as LLMProvider[]) : [])
    } catch { /* 保持原状态 */ }
  }

  const stepItems = [
    { title: t('onboarding.stepWelcome') },
    { title: t('onboarding.stepModel') },
    { title: t('onboarding.stepEmployee') },
    { title: t('onboarding.stepKms') },
    { title: t('onboarding.stepFinish') },
  ]

  const renderStep = () => {
    switch (step) {
      case 1:
        return (
          <ModelStep
            providers={providers}
            onConfigured={reloadProviders}
            onGoSettings={() => finish('/settings?tab=llm')}
          />
        )
      case 2:
        return (
          <EmployeeStep
            onCreated={() => { setHasEmployee(true); setStep(3) }}
            onGoWizard={() => finish('/wizard')}
          />
        )
      case 3:
        return <KmsStep />
      case 4:
        return (
          <FinishStep
            hasProvider={hasProvider}
            hasEmployee={hasEmployee}
            onGoKms={() => finish('/kms')}
            onStart={() => finish()}
          />
        )
      default:
        return (
          <div style={{ textAlign: 'center', padding: '40px 0' }}>
            <div className="onboarding-float" style={{ position: 'relative', width: 96, height: 96, margin: '0 auto 24px' }}>
              <div style={{
                width: 96, height: 96, borderRadius: 24,
                background: `linear-gradient(135deg, ${token.colorPrimary}, ${token.colorPrimaryActive})`,
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                boxShadow: `0 16px 40px ${token.colorPrimaryBgHover}`,
              }}>
                <RobotOutlined style={{ fontSize: 46, color: '#fff' }} />
              </div>
              <div className="onboarding-chip" style={{ position: 'absolute', top: -12, right: -28, animationDelay: '0.6s' }}>
                <ApiOutlined style={{ color: token.colorPrimary, fontSize: 16 }} />
              </div>
              <div className="onboarding-chip" style={{ position: 'absolute', bottom: -8, left: -30, animationDelay: '1.2s' }}>
                <DatabaseOutlined style={{ color: token.colorSuccess, fontSize: 16 }} />
              </div>
            </div>
            <Title level={2} style={{ marginBottom: 12 }}>{t('onboarding.welcome.title')}</Title>
            <Paragraph type="secondary" style={{ fontSize: 15, maxWidth: 480, margin: '0 auto 36px' }}>
              {t('onboarding.welcome.subtitle')}
            </Paragraph>
            <div style={{ display: 'flex', gap: 16, justifyContent: 'center', flexWrap: 'wrap', marginBottom: 40 }}>
              {[
                { icon: <ApiOutlined />, color: token.colorPrimary, bg: token.colorPrimaryBg, title: t('onboarding.welcome.cardLlmTitle'), desc: t('onboarding.welcome.cardLlmDesc') },
                { icon: <RobotOutlined />, color: token.colorSuccess, bg: token.colorSuccessBg, title: t('onboarding.welcome.cardEmployeeTitle'), desc: t('onboarding.welcome.cardEmployeeDesc') },
                { icon: <DatabaseOutlined />, color: token.colorWarning, bg: token.colorWarningBg, title: t('onboarding.welcome.cardKmsTitle'), desc: t('onboarding.welcome.cardKmsDesc') },
              ].map((c) => (
                <div
                  key={c.title}
                  style={{
                    width: 240, padding: '20px 18px', borderRadius: 12, textAlign: 'left',
                    background: token.colorBgContainer,
                    border: `1px solid ${token.colorBorderSecondary}`,
                    transition: 'box-shadow 0.2s, transform 0.2s',
                  }}
                  className="onboarding-card"
                >
                  <div style={{ width: 36, height: 36, borderRadius: 10, background: c.bg, display: 'flex', alignItems: 'center', justifyContent: 'center', marginBottom: 12 }}>
                    <span style={{ color: c.color, fontSize: 18 }}>{c.icon}</span>
                  </div>
                  <Text strong style={{ display: 'block', marginBottom: 6 }}>{c.title}</Text>
                  <Text type="secondary" style={{ fontSize: 12, lineHeight: 1.6 }}>{c.desc}</Text>
                </div>
              ))}
            </div>
            <Button type="primary" size="large" onClick={() => setStep(1)}>
              {t('onboarding.welcome.start')}
            </Button>
          </div>
        )
    }
  }

  return (
    <div
      style={{
        height: '100%', overflow: 'auto', position: 'relative',
        background: `linear-gradient(165deg, ${token.colorPrimaryBg} 0%, ${token.colorBgContainer} 45%, ${token.colorBgLayout} 100%)`,
      }}
    >
      {/* 装饰元素：纯 CSS/SVG，随主题取色 */}
      <svg width="440" height="440" viewBox="0 0 200 200" style={{ position: 'fixed', top: -150, right: -110, opacity: isDark ? 0.1 : 0.09, pointerEvents: 'none' }}>
        <circle cx="100" cy="100" r="76" fill="none" stroke={token.colorPrimary} strokeWidth="22" />
      </svg>
      <svg width="300" height="300" viewBox="0 0 200 200" style={{ position: 'fixed', bottom: -110, left: -80, opacity: isDark ? 0.08 : 0.06, pointerEvents: 'none' }}>
        <circle cx="100" cy="100" r="92" fill={token.colorPrimary} />
      </svg>
      <svg width="150" height="110" style={{ position: 'fixed', top: 120, left: '10%', opacity: 0.12, pointerEvents: 'none' }}>
        <defs>
          <pattern id="onboarding-dots" width="16" height="16" patternUnits="userSpaceOnUse">
            <circle cx="2" cy="2" r="1.6" fill={token.colorPrimary} />
          </pattern>
        </defs>
        <rect width="100%" height="100%" fill="url(#onboarding-dots)" />
      </svg>

      {/* 顶部栏：品牌 + 跳过 */}
      <div style={{ position: 'relative', display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '16px 24px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <div style={{
            width: 28, height: 28, borderRadius: 8,
            background: `linear-gradient(135deg, ${token.colorPrimary}, ${token.colorPrimaryActive})`,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
          }}>
            <RobotOutlined style={{ color: '#fff', fontSize: 15 }} />
          </div>
          <Text strong>WorkAvatar</Text>
        </div>
        {step < 4 && (
          <Button type="text" onClick={() => finish()}>
            {t('onboarding.skip')}
          </Button>
        )}
      </div>

      <div style={{ position: 'relative', maxWidth: 920, margin: '0 auto', padding: '8px 24px 32px', display: 'flex', flexDirection: 'column', minHeight: 'calc(100% - 60px)' }}>
        {initializing ? (
          <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <Spin size="large" />
          </div>
        ) : (
          <>
            <Steps current={step} items={stepItems} style={{ maxWidth: 760, width: '100%', margin: '0 auto 32px' }} />
            <div style={{ flex: 1 }}>
              {renderStep()}
            </div>
            {step > 0 && step < 4 && (
              <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 28, paddingTop: 16, borderTop: `1px solid ${token.colorBorderSecondary}` }}>
                <Button onClick={() => setStep(step - 1)}>{t('common.prev')}</Button>
                <Button type="primary" onClick={() => setStep(step + 1)}>{t('common.next')}</Button>
              </div>
            )}
          </>
        )}
      </div>

      <style>{`
        @keyframes onboarding-float {
          0%, 100% { transform: translateY(0); }
          50% { transform: translateY(-8px); }
        }
        .onboarding-float { animation: onboarding-float 4s ease-in-out infinite; }
        .onboarding-chip {
          width: 32px; height: 32px; border-radius: 10px;
          background: ${token.colorBgContainer};
          border: 1px solid ${token.colorBorderSecondary};
          display: flex; align-items: center; justify-content: center;
          box-shadow: 0 4px 12px rgba(0, 0, 0, 0.08);
          animation: onboarding-float 4s ease-in-out infinite;
        }
        .onboarding-card:hover {
          box-shadow: ${token.boxShadowSecondary};
          transform: translateY(-2px);
        }
      `}</style>
    </div>
  )
}

export default Onboarding
