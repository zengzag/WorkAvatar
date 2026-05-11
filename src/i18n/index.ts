import i18n from 'i18next'
import { initReactI18next } from 'react-i18next'
import zhCN from './locales/zh-CN'
import enUS from './locales/en-US'

export type AppLocale = 'zh-CN' | 'en-US'

const SETTINGS_KEY_LOCALE = 'appearance_locale'

export async function getSavedLocale(): Promise<AppLocale> {
  try {
    const saved = await window.electronAPI.settings.get({ key: SETTINGS_KEY_LOCALE })
    return (saved as AppLocale) || 'zh-CN'
  } catch {
    return 'zh-CN'
  }
}

export async function saveLocale(locale: AppLocale): Promise<void> {
  try {
    await window.electronAPI.settings.set({ key: SETTINGS_KEY_LOCALE, value: locale })
  } catch {
    // ignore
  }
}

i18n.use(initReactI18next).init({
  resources: {
    'zh-CN': { translation: zhCN },
    'en-US': { translation: enUS },
  },
  lng: 'zh-CN',
  fallbackLng: 'zh-CN',
  interpolation: {
    escapeValue: false,
  },
})

export default i18n
