import { create } from 'zustand'
import { immer } from 'zustand/middleware/immer'
import i18n, { type AppLocale, saveLocale } from '../i18n'

export type { AppLocale }

export type ThemeMode = 'light' | 'dark' | 'system'
export type FontSizeLevel = 'small' | 'medium' | 'large'

export const FONT_SIZE_MAP: Record<FontSizeLevel, number> = {
  small: 12,
  medium: 13,
  large: 15,
}

export const FONT_SIZE_SM_MAP: Record<FontSizeLevel, number> = {
  small: 11,
  medium: 12,
  large: 13,
}

export const FONT_SIZE_LG_MAP: Record<FontSizeLevel, number> = {
  small: 14,
  medium: 15,
  large: 17,
}

export const FONT_SIZE_XL_MAP: Record<FontSizeLevel, number> = {
  small: 16,
  medium: 18,
  large: 22,
}

interface AppearanceState {
  themeMode: ThemeMode
  fontSizeLevel: FontSizeLevel
  locale: AppLocale
  initialized: boolean

  setThemeMode: (mode: ThemeMode) => void
  setFontSizeLevel: (level: FontSizeLevel) => void
  setLocale: (locale: AppLocale) => void
  initialize: () => Promise<void>
}

const SETTINGS_KEY_THEME = 'appearance_theme'
const SETTINGS_KEY_FONT_SIZE = 'appearance_font_size'
const SETTINGS_KEY_LOCALE = 'appearance_locale'

export const useAppearanceStore = create<AppearanceState>()(
  immer((set, get) => ({
    themeMode: 'light',
    fontSizeLevel: 'medium',
    locale: 'zh-CN',
    initialized: false,

    setThemeMode: (mode) => {
      set((state) => {
        state.themeMode = mode
      })
      window.electronAPI.settings.set({ key: SETTINGS_KEY_THEME, value: mode })
      applyThemeToDOM(mode)
    },

    setFontSizeLevel: (level) => {
      set((state) => {
        state.fontSizeLevel = level
      })
      window.electronAPI.settings.set({ key: SETTINGS_KEY_FONT_SIZE, value: level })
      applyFontSizeToDOM(level)
    },

    setLocale: (locale) => {
      set((state) => {
        state.locale = locale
      })
      saveLocale(locale)
      i18n.changeLanguage(locale)
      document.documentElement.setAttribute('data-locale', locale)
    },

    initialize: async () => {
      if (get().initialized) return
      try {
        const [savedTheme, savedFontSize, savedLocale] = await Promise.all([
          window.electronAPI.settings.get({ key: SETTINGS_KEY_THEME }),
          window.electronAPI.settings.get({ key: SETTINGS_KEY_FONT_SIZE }),
          window.electronAPI.settings.get({ key: SETTINGS_KEY_LOCALE }),
        ])

        const themeMode = (savedTheme as ThemeMode) || 'light'
        const fontSizeLevel = (savedFontSize as FontSizeLevel) || 'medium'
        const locale = (savedLocale as AppLocale) || 'zh-CN'

        set((state) => {
          state.themeMode = themeMode
          state.fontSizeLevel = fontSizeLevel
          state.locale = locale
          state.initialized = true
        })

        applyThemeToDOM(themeMode)
        applyFontSizeToDOM(fontSizeLevel)
        i18n.changeLanguage(locale)
        document.documentElement.setAttribute('data-locale', locale)
      } catch {
        set((state) => {
          state.initialized = true
        })
        applyThemeToDOM('light')
        applyFontSizeToDOM('medium')
        i18n.changeLanguage('zh-CN')
        document.documentElement.setAttribute('data-locale', 'zh-CN')
      }
    },
  }))
)

export function getEffectiveTheme(mode: ThemeMode): 'light' | 'dark' {
  if (mode === 'system') {
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
  }
  return mode
}

function applyThemeToDOM(mode: ThemeMode) {
  const effective = getEffectiveTheme(mode)
  const root = document.documentElement
  root.setAttribute('data-theme', effective)
  if (effective === 'dark') {
    root.classList.add('dark')
  } else {
    root.classList.remove('dark')
  }
}

function applyFontSizeToDOM(level: FontSizeLevel) {
  const root = document.documentElement
  root.style.setProperty('--font-size-base', `${FONT_SIZE_MAP[level]}px`)
  root.style.setProperty('--font-size-sm', `${FONT_SIZE_SM_MAP[level]}px`)
  root.style.setProperty('--font-size-lg', `${FONT_SIZE_LG_MAP[level]}px`)
  root.style.setProperty('--font-size-xl', `${FONT_SIZE_XL_MAP[level]}px`)
  root.setAttribute('data-font-size', level)
}

export function listenSystemThemeChange() {
  const mql = window.matchMedia('(prefers-color-scheme: dark)')
  const handler = () => {
    const { themeMode } = useAppearanceStore.getState()
    if (themeMode === 'system') {
      applyThemeToDOM('system')
    }
  }
  mql.addEventListener('change', handler)
  return () => mql.removeEventListener('change', handler)
}
