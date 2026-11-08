import { useEffect, useState } from 'react'
import { Tabs } from 'antd'
import {
  ApiOutlined,
  SaveOutlined,
  SettingOutlined,
  RobotOutlined,
  GlobalOutlined,
  AppstoreAddOutlined,
  AppstoreOutlined,
  ToolOutlined,
  ControlOutlined,
  BulbOutlined,
  SmileOutlined,
  DatabaseOutlined,
  InfoCircleOutlined,
} from '@ant-design/icons'
import type { TabsProps } from 'antd'
import { useTranslation } from 'react-i18next'
import { useSearchParams } from 'react-router-dom'
import { getPluginViews } from '../plugins/view-slot'
import {
  LLMSettings,
  AppearanceSettings,
  StorageSettings,
  AboutSection,
  DefaultModelSettings,
  GlobalMemorySettings,
  InternetSearchSettings,
  KMSMCPSettings,
  NavSettings,
  RuntimeEnvSection,
  PluginsSection,
  GeneralSettings,
} from '../components/settings'
import { PluginViewSlot } from '../plugins/view-slot'
import SecretarySettingsPanel from '../components/secretary/SecretarySettingsPanel'

const Settings: React.FC = () => {
  const { t } = useTranslation()
  const [searchParams] = useSearchParams()
  const tabParam = searchParams.get('tab')

  // 内容区容器：统一留白 + 滚动，内容收进一块可读性更好的设置面板
  const contentWrap = (node: React.ReactNode) => (
    <div className="wa-settings-scroll">
      <div className="wa-settings-panel">{node}</div>
    </div>
  )

  const tabItems: TabsProps['items'] = [
    {
      key: 'general',
      label: (
        <span>
          <ControlOutlined /> {t('settings.tabGeneral')}
        </span>
      ),
      children: contentWrap(<GeneralSettings />),
    },
    {
      key: 'secretary',
      label: (
        <span>
          <SmileOutlined /> {t('settings.tabSecretary')}
        </span>
      ),
      children: contentWrap(<SecretarySettingsPanel />),
    },
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
          <DatabaseOutlined /> {t('settings.tabKmsMcp')}
        </span>
      ),
      children: contentWrap(<KMSMCPSettings />),
    },
    {
      key: 'globalMemory',
      label: (
        <span>
          <BulbOutlined /> {t('settings.tabGlobalMemory')}
        </span>
      ),
      children: contentWrap(<GlobalMemorySettings />),
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
      key: 'plugins',
      label: (
        <span>
          <AppstoreAddOutlined /> {t('settings.tabPlugins')}
        </span>
      ),
      children: contentWrap(<PluginsSection />),
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
      label: (
        <span>
          <InfoCircleOutlined /> {t('settings.tabAbout')}
        </span>
      ),
      children: contentWrap(<AboutSection />),
    },
  ]

  const validTabs = ['general', 'secretary', 'llm', 'defaultModel', 'kmsMcp', 'globalMemory', 'storage', 'appearance', 'nav', 'plugins', 'runtime', 'internetSearch', 'about']

  // 插件设置注入点：至少一个插件注册 settings.tab 视野时，追加聚合 Tab
  const pluginSettingsViews = getPluginViews('settings.tab')
  const finalItems = pluginSettingsViews.length > 0 && !tabItems.some(i => i.key === 'plugins-config')
    ? [
        ...tabItems,
        {
          key: 'plugins-config',
          label: (
            <span>
              <SettingOutlined /> {t('settings.tabPluginConfig')}
            </span>
          ),
          children: contentWrap(<PluginViewSlot view="settings.tab" />),
        },
      ]
    : tabItems

  const defaultActiveKey = tabParam && validTabs.includes(tabParam) ? tabParam : 'llm'
  // 受控：小秘书右键菜单等外部入口会用 ?tab= 切到指定页，页面已挂载时也要生效
  const [activeKey, setActiveKey] = useState(defaultActiveKey)
  useEffect(() => {
    if (tabParam && validTabs.includes(tabParam)) setActiveKey(tabParam)
  }, [tabParam]) // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="wa-settings-page">
      <Tabs
        activeKey={activeKey}
        onChange={setActiveKey}
        items={finalItems}
        tabPlacement="start"
        style={{ flex: 1, minHeight: 0, height: '100%' }}
        tabBarStyle={{
          width: 208,
          minWidth: 208,
          margin: 0,
          paddingTop: 0,
        }}
        className="wa-settings-tabs settings-tabs"
      />
    </div>
  )
}

export default Settings
