import { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { Steps, Button, Typography, theme, Spin } from 'antd'
import { RobotOutlined } from '@ant-design/icons'
import type { LLMProvider } from '../types'
import ModelStep from './onboarding/ModelStep'
import EmployeeStep from './onboarding/EmployeeStep'
import FinishStep from './onboarding/FinishStep'

const { Text } = Typography

const ONBOARDING_COMPLETED_KEY = 'onboarding_completed'

const Onboarding: React.FC = () => {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const { token } = theme.useToken()
  const [step, setStep] = useState(0)
  const [maxVisited, setMaxVisited] = useState(0)
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

  const goTo = (next: number) => {
    setStep(next)
    setMaxVisited((v) => Math.max(v, next))
  }

  const stepItems = [
    { title: t('onboarding.stepModel') },
    { title: t('onboarding.stepEmployee') },
    { title: t('onboarding.stepFinish') },
  ]

  const renderStep = () => {
    switch (step) {
      case 0:
        return (
          <ModelStep
            providers={providers}
            onConfigured={reloadProviders}
          />
        )
      case 1:
        return (
          <EmployeeStep
            onCreated={() => { setHasEmployee(true); goTo(2) }}
          />
        )
      default:
        return (
          <FinishStep
            hasProvider={hasProvider}
            hasEmployee={hasEmployee}
            onGoKms={() => finish('/kms')}
            onStart={() => finish()}
          />
        )
    }
  }

  return (
    <div style={{ height: '100%', overflow: 'auto', background: token.colorBgLayout }}>
      <div
        style={{
          maxWidth: 480, margin: '0 auto', padding: '32px 24px 40px',
          minHeight: '100%', boxSizing: 'border-box',
          display: 'flex', flexDirection: 'column',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 28 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <RobotOutlined style={{ color: token.colorPrimary, fontSize: 16 }} />
            <Text strong>WorkAvatar</Text>
          </div>
          {step < 2 && (
            <Button type="text" size="small" onClick={() => finish()} data-testid="onboarding-skip">
              {t('onboarding.skip')}
            </Button>
          )}
        </div>

        {initializing ? (
          <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <Spin />
          </div>
        ) : (
          <>
            <Steps
              size="small"
              current={step}
              items={stepItems}
              onChange={(next) => { if (next <= maxVisited) setStep(next) }}
              style={{ marginBottom: 28 }}
            />
            <div style={{ flex: 1 }}>
              {renderStep()}
            </div>
            {step < 2 && (
              <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 28 }}>
                {step > 0
                  ? <Button onClick={() => setStep(step - 1)} data-testid="onboarding-prev">{t('common.prev')}</Button>
                  : <span />}
                <Button type="primary" onClick={() => goTo(step + 1)} data-testid="onboarding-next">{t('common.next')}</Button>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  )
}

export default Onboarding
