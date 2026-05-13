import { Card, Tabs } from 'antd'
import {
  ApiOutlined,
  SaveOutlined,
  SettingOutlined,
  RobotOutlined,
} from '@ant-design/icons'
import type { TabsProps } from 'antd'
import { useTranslation } from 'react-i18next'
import {
  LLMSettings,
  AppearanceSettings,
  StorageSettings,
  AboutSection,
  DefaultModelSettings,
} from '../components/settings'

const Settings: React.FC = () => {
  const { t } = useTranslation()

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
      key: 'about',
      label: t('settings.tabAbout'),
      children: <AboutSection />,
    },
  ]

  return (
    <div style={{ padding: 24, height: '100%', overflow: 'auto' }}>
      <Card>
        <Tabs items={tabItems} style={{ minHeight: 400 }} />
      </Card>
    </div>
  )
}

export default Settings
