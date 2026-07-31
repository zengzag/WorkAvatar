import { Tabs } from 'antd'
import {
  ApiOutlined,
  SaveOutlined,
  SettingOutlined,
  RobotOutlined,
  GlobalOutlined,
  SearchOutlined,
  AppstoreOutlined,
  ToolOutlined,
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
  KMSMCPSettings,
  NavSettings,
  RuntimeEnvSection,
} from '../components/settings'

const Settings: React.FC = () => {
  const { t } = useTranslation()
  const [searchParams] = useSearchParams()
  const tabParam = searchParams.get('tab')

  // 内容区容器：统一顶部留白 + 滚动
  const contentWrap = (node: React.ReactNode) => (
    <div style={{ padding: '24px 24px 20px', height: '100%', overflow: 'auto' }}>
      {node}
    </div>
  )

  const tabItems: TabsProps['items'] = [
    {
      key: 'llm',
      label: (
        <span>
          <ApiOutlined /> {t('settings.tabLlm')}
        </span>
      ),
      children: contentWrap(<LLMSettings />),
    },
    {
      key: 'defaultModel',
      label: (
        <span>
          <RobotOutlined /> {t('settings.tabDefaultModel')}
        </span>
      ),
      children: contentWrap(<DefaultModelSettings />),
    },
    {
      key: 'kmsMcp',
      label: (
        <span>
          <SearchOutlined /> {t('settings.tabKmsMcp')}
        </span>
      ),
      children: contentWrap(<KMSMCPSettings />),
    },
    {
      key: 'storage',
      label: (
        <span>
          <SaveOutlined /> {t('settings.tabStorage')}
        </span>
      ),
      children: contentWrap(<StorageSettings />),
    },
    {
      key: 'appearance',
      label: (
        <span>
          <SettingOutlined /> {t('settings.tabAppearance')}
        </span>
      ),
      children: contentWrap(<AppearanceSettings />),
    },
    {
      key: 'nav',
      label: (
        <span>
          <AppstoreOutlined /> {t('settings.tabNav')}
        </span>
      ),
      children: contentWrap(<NavSettings />),
    },
    {
      key: 'runtime',
      label: (
        <span>
          <ToolOutlined /> {t('settings.tabRuntime')}
        </span>
      ),
      children: contentWrap(<RuntimeEnvSection />),
    },
    {
      key: 'internetSearch',
      label: (
        <span>
          <GlobalOutlined /> {t('settings.tabInternetSearch')}
        </span>
      ),
      children: contentWrap(<InternetSearchSettings />),
    },
    {
      key: 'about',
      label: t('settings.tabAbout'),
      children: contentWrap(<AboutSection />),
    },
  ]

  const validTabs = ['llm', 'defaultModel', 'kmsMcp', 'storage', 'appearance', 'nav', 'runtime', 'internetSearch', 'about']
  const defaultActiveKey = tabParam && validTabs.includes(tabParam) ? tabParam : 'llm'

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
      <Tabs
        defaultActiveKey={defaultActiveKey}
        items={tabItems}
        tabPlacement="start"
        style={{ flex: 1, minHeight: 0, height: '100%' }}
        tabBarStyle={{
          width: 150,
          minWidth: 150,
          margin: 0,
          paddingTop: 8,
        }}
        className="settings-tabs"
      />
      <style>{`
        .settings-tabs.ant-tabs {
          height: 100%;
        }
        .settings-tabs .ant-tabs-nav-list {
          padding: 0 8px;
        }
        .settings-tabs .ant-tabs-tab {
          margin: 2px 0 !important;
          padding: 6px 10px !important;
          border-radius: 4px;
        }
        .settings-tabs .ant-tabs-body-holder {
          border-left: 1px solid var(--border-color, #f0f0f0);
          flex: auto;
          min-width: 0;
          min-height: 0;
          overflow: hidden;
        }
        .settings-tabs .ant-tabs-body {
          height: 100%;
        }
        .settings-tabs .ant-tabs-content {
          height: 100%;
        }
        .settings-tabs .ant-tabs-tabpane {
          height: 100%;
        }
      `}</style>
    </div>
  )
}

export default Settings
