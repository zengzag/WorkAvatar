import { Card, Tabs } from 'antd'
import {
  ApiOutlined,
  SaveOutlined,
  SettingOutlined,
  RobotOutlined,
  GlobalOutlined,
  CloudServerOutlined,
} from '@ant-design/icons'
import type { TabsProps } from 'antd'
import { useTranslation } from 'react-i18next'
import { useSearchParams } from 'react-router-dom'
import {
  LLMSettings,
  AppearanceSettings,
  StorageSettings,
  AboutSection,
  DefaultModelSettings,
  InternetSearchSettings,
  KBMCPSettings,
} from '../components/settings'

const Settings: React.FC = () => {
  const { t } = useTranslation()
  const [searchParams] = useSearchParams()
  const tabParam = searchParams.get('tab')

  const tabItems: TabsProps['items'] = [
    {
      key: 'llm',
      label: (
        <span>
          <ApiOutlined /> {t('settings.tabLlm')}
        </span>
      ),
      children: <LLMSettings />,
    },
    {
      key: 'defaultModel',
      label: (
        <span>
          <RobotOutlined /> {t('settings.tabDefaultModel')}
        </span>
      ),
      children: <DefaultModelSettings />,
    },
    {
      key: 'kbMcp',
      label: (
        <span>
          <CloudServerOutlined /> {t('settings.tabKbMcp')}
        </span>
      ),
      children: <KBMCPSettings />,
    },
    {
      key: 'storage',
      label: (
        <span>
          <SaveOutlined /> {t('settings.tabStorage')}
        </span>
      ),
      children: <StorageSettings />,
    },
    {
      key: 'appearance',
      label: (
        <span>
          <SettingOutlined /> {t('settings.tabAppearance')}
        </span>
      ),
      children: <AppearanceSettings />,
    },
    {
      key: 'internetSearch',
      label: (
        <span>
          <GlobalOutlined /> {t('settings.tabInternetSearch')}
        </span>
      ),
      children: <InternetSearchSettings />,
    },
    {
      key: 'about',
      label: t('settings.tabAbout'),
      children: <AboutSection />,
    },
  ]

  const validTabs = ['llm', 'defaultModel', 'kbMcp', 'storage', 'appearance', 'internetSearch', 'about']
  const defaultActiveKey = tabParam && validTabs.includes(tabParam) ? tabParam : 'llm'

  return (
    <div style={{ padding: 24, height: '100%', overflow: 'auto' }}>
      <Card>
        <Tabs defaultActiveKey={defaultActiveKey} items={tabItems} style={{ minHeight: 400 }} />
      </Card>
    </div>
  )
}

export default Settings
