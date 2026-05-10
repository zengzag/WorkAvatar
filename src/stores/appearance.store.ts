import { create } from 'zustand'
import { immer } from 'zustand/middleware/immer'

export type ThemeMode = 'light' | 'dark' | 'system'
export type FontSizeLevel = 'small' | 'medium' | 'large'

export const FONT_SIZE_MAP: Record<FontSizeLevel, number> = {
  small: 12,
  medium: 14,
  large: 16,
}

export const FONT_SIZE_SM_MAP: Record<FontSizeLevel, number> = {
  small: 10,
  medium: 12,
  large: 14,
}

export const FONT_SIZE_LG_MAP: Record<FontSizeLevel, number> = {
  small: 14,
  medium: 16,
  large: 18,
}

export const FONT_SIZE_XL_MAP: Record<FontSizeLevel, number> = {
  small: 16,
  medium: 20,
  large: 24,
}

interface AppearanceState {
  themeMode: ThemeMode
  fontSizeLevel: FontSizeLevel
  initialized: boolean

  setThemeMode: (mode: ThemeMode) => void
  setFontSizeLevel: (level: FontSizeLevel) => void
  initialize: () => Promise<void>
}

const SETTINGS_KEY_THEME = 'appearance_theme'
const SETTINGS_KEY_FONT_SIZE = 'appearance_font_size'

export const useAppearanceStore = create<AppearanceState>()(
  immer((set, get) => ({
    themeMode: 'light',
    fontSizeLevel: 'medium',
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

    initialize: async () => {
      if (get().initialized) return
      try {
        const [savedTheme, savedFontSize] = await Promise.all([
          window.electronAPI.settings.get({ key: SETTINGS_KEY_THEME }),
          window.electronAPI.settings.get({ key: SETTINGS_KEY_FONT_SIZE }),
        ])

        const themeMode = (savedTheme as ThemeMode) || 'light'
        const fontSizeLevel = (savedFontSize as FontSizeLevel) || 'medium'

        set((state) => {
          state.themeMode = themeMode
          state.fontSizeLevel = fontSizeLevel
          state.initialized = true
        })

        applyThemeToDOM(themeMode)
        applyFontSizeToDOM(fontSizeLevel)
      } catch {
        set((state) => {
          state.initialized = true
        })
        applyThemeToDOM('light')
        applyFontSizeToDOM('medium')
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
