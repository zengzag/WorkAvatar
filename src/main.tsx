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
import { useNavConfigStore } from './stores/nav.store'
import { installConsoleForwarder } from './utils/logger'

// 尽早挂载 console 转发，把渲染进程日志写入主进程日志文件
installConsoleForwarder()

const ANT_LOCALE_MAP: Record<string, any> = {
  'zh-CN': zhCN,
  'en-US': enUS,
}

const AppWithTheme: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const themeMode = useAppearanceStore((s) => s.themeMode)
  const fontSizeLevel = useAppearanceStore((s) => s.fontSizeLevel)
  const locale = useAppearanceStore((s) => s.locale)
  const initialize = useAppearanceStore((s) => s.initialize)
  const initializeNav = useNavConfigStore((s) => s.initialize)

  useEffect(() => {
    initialize()
    initializeNav()
    const cleanup = listenSystemThemeChange()
    return cleanup
  }, [initialize, initializeNav])

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
        borderRadius: 4,
        borderRadiusLG: 6,
        borderRadiusSM: 3,
        wireframe: false,
        // 更紧凑的间距，提升专业感
        controlHeight: 28,
        controlHeightSM: 24,
        controlHeightLG: 32,
        // 更细致的边框
        borderWidth: 1,
        // 更柔和的阴影
        boxShadowTertiary: '0 1px 2px 0 rgba(0,0,0,0.03), 0 1px 6px -1px rgba(0,0,0,0.02), 0 2px 4px 0 rgba(0,0,0,0.02)',
      },
      components: {
        Layout: {
          headerBg: effectiveTheme === 'dark' ? '#1a1a1a' : '#fff',
          siderBg: effectiveTheme === 'dark' ? '#1a1a1a' : '#fff',
          bodyBg: effectiveTheme === 'dark' ? '#0a0a0a' : '#f0f0f0',
          headerHeight: 40,
          headerPadding: '0 16px',
        },
        Menu: {
          darkItemBg: '#1a1a1a',
          itemBg: 'transparent',
          itemHeight: 36,
          itemMarginInline: 8,
          itemBorderRadius: 4,
          iconSize: 16,
          darkSubMenuItemBg: '#1a1a1a',
        },
        Table: {
          stickyScrollBarBg: effectiveTheme === 'dark' ? 'rgba(255, 255, 255, 0.15)' : 'rgba(0, 0, 0, 0.15)',
          cellPaddingBlock: 8,
          cellPaddingInline: 12,
          headerBg: effectiveTheme === 'dark' ? '#1f1f1f' : '#fafafa',
          headerColor: effectiveTheme === 'dark' ? 'rgba(255,255,255,0.85)' : 'rgba(0,0,0,0.85)',
        },
        Card: {
          headerFontSize: 14,
          headerHeight: 40,
          paddingLG: 16,
        },
        Tabs: {
          horizontalItemPadding: '8px 12px',
          titleTextSize: 13,
        },
        Button: {
          controlHeight: 28,
          controlHeightSM: 24,
          controlHeightLG: 32,
          paddingInline: 12,
        },
        Input: {
          controlHeight: 28,
          controlHeightSM: 24,
        },
        Select: {
          controlHeight: 28,
          controlHeightSM: 24,
        },
        Segmented: {
          itemSelectedBg: effectiveTheme === 'dark' ? '#2a2a2a' : '#e8e8e8',
          borderRadius: 4,
          borderRadiusSM: 3,
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
