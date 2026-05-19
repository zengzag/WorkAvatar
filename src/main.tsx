import React, { useEffect, useMemo } from 'react'
import ReactDOM from 'react-dom/client'
import { RouterProvider } from 'react-router-dom'
import { ConfigProvider, theme as antdTheme, App as AntApp } from 'antd'
import zhCN from 'antd/locale/zh_CN'
import enUS from 'antd/locale/en_US'
import router from './router'
import './i18n'
import './styles/index.css'
import {
  useAppearanceStore,
  getEffectiveTheme,
  FONT_SIZE_MAP,
  FONT_SIZE_SM_MAP,
  FONT_SIZE_LG_MAP,
  listenSystemThemeChange,
} from './stores/appearance.store'

const ANT_LOCALE_MAP: Record<string, any> = {
  'zh-CN': zhCN,
  'en-US': enUS,
}

const AppWithTheme: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const themeMode = useAppearanceStore((s) => s.themeMode)
  const fontSizeLevel = useAppearanceStore((s) => s.fontSizeLevel)
  const locale = useAppearanceStore((s) => s.locale)
  const initialize = useAppearanceStore((s) => s.initialize)

  useEffect(() => {
    initialize()
    const cleanup = listenSystemThemeChange()
    return cleanup
  }, [initialize])

  const effectiveTheme = useMemo(() => getEffectiveTheme(themeMode), [themeMode])

  const antLocale = useMemo(() => ANT_LOCALE_MAP[locale] || zhCN, [locale])

  const themeConfig = useMemo(
    () => ({
      algorithm:
        effectiveTheme === 'dark' ? antdTheme.darkAlgorithm : antdTheme.defaultAlgorithm,
      token: {
        fontSize: FONT_SIZE_MAP[fontSizeLevel],
        fontSizeSM: FONT_SIZE_SM_MAP[fontSizeLevel],
        fontSizeLG: FONT_SIZE_LG_MAP[fontSizeLevel],
        borderRadius: 6,
      },
      components: {
        Layout: {
          headerBg: effectiveTheme === 'dark' ? '#141414' : '#fff',
          siderBg: effectiveTheme === 'dark' ? '#1f1f1f' : '#fff',
          bodyBg: effectiveTheme === 'dark' ? '#141414' : '#f5f5f5',
        },
        Menu: {
          darkItemBg: '#1f1f1f',
        },
        Table: {
          stickyScrollBarBg: effectiveTheme === 'dark' ? 'rgba(255, 255, 255, 0.15)' : 'rgba(0, 0, 0, 0.15)',
        },
      },
    }),
    [effectiveTheme, fontSizeLevel]
  )

  return (
    <ConfigProvider locale={antLocale} theme={themeConfig}>
      <AntApp>
        {children}
      </AntApp>
    </ConfigProvider>
  )
}

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    <AppWithTheme>
      <RouterProvider router={router} />
    </AppWithTheme>
  </React.StrictMode>
)
