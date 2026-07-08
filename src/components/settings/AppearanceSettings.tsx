import React from 'react'
import { Typography, Radio, Divider } from 'antd'
import { useAppearanceStore, type ThemeMode, type FontSizeLevel, type AppLocale } from '../../stores/appearance.store'
import { useTranslation } from 'react-i18next'

const { Text, Title } = Typography

const AppearanceSettings: React.FC = () => {
  const { t } = useTranslation()
  const themeMode = useAppearanceStore((s) => s.themeMode)
  const fontSizeLevel = useAppearanceStore((s) => s.fontSizeLevel)
  const setThemeMode = useAppearanceStore((s) => s.setThemeMode)
  const setFontSizeLevel = useAppearanceStore((s) => s.setFontSizeLevel)
  const locale = useAppearanceStore((s) => s.locale)
  const setLocale = useAppearanceStore((s) => s.setLocale)

  return (
    <div>
      <Title level={5}>{t('settings.appearanceTitle')}</Title>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <Text strong>{t('settings.themeMode')}</Text>
          <Radio.Group
            value={themeMode}
            optionType="button"
            buttonStyle="solid"
            onChange={(e) => setThemeMode(e.target.value as ThemeMode)}
          >
            <Radio.Button value="light">{t('settings.light')}</Radio.Button>
            <Radio.Button value="dark">{t('settings.dark')}</Radio.Button>
            <Radio.Button value="system">{t('settings.system')}</Radio.Button>
          </Radio.Group>
        </div>
        <Divider />
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <Text strong>{t('settings.fontSize')}</Text>
          <Radio.Group
            value={fontSizeLevel}
            optionType="button"
            buttonStyle="solid"
            onChange={(e) => setFontSizeLevel(e.target.value as FontSizeLevel)}
          >
            <Radio.Button value="small">{t('settings.small')}</Radio.Button>
            <Radio.Button value="medium">{t('settings.medium')}</Radio.Button>
            <Radio.Button value="large">{t('settings.large')}</Radio.Button>
          </Radio.Group>
        </div>
        <Divider />
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <Text strong>{t('settings.language')}</Text>
          <Radio.Group value={locale} optionType="button" buttonStyle="solid" onChange={(e) => setLocale(e.target.value as AppLocale)}>
            <Radio.Button value="zh-CN">中文</Radio.Button>
            <Radio.Button value="en-US">English</Radio.Button>
          </Radio.Group>
        </div>
      </div>
    </div>
  )
}

export default React.memo(AppearanceSettings)
