import { Card, Tabs } from 'antd'
import {
  ApiOutlined,
  SaveOutlined,
  SettingOutlined,
} from '@ant-design/icons'
import type { TabsProps } from 'antd'
import { useTranslation } from 'react-i18next'
import {
  LLMSettings,
  MCPServerSettings,
  SkillSettings,
  AppearanceSettings,
  StorageSettings,
  AboutSection,
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
      key: 'mcp',
      label: (
        <span>
          <SettingOutlined /> {t('settings.tabMcp')}
        </span>
      ),
      children: <MCPServerSettings />,
    },
    {
      key: 'skills',
      label: (
        <span>
          <SettingOutlined /> {t('settings.tabSkills')}
        </span>
      ),
      children: <SkillSettings />,
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
