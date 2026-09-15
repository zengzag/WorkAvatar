// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

/**
 * src/stores/appearance.store：主题 / 字号 / 语言的持久化、DOM 应用与初始化兜底。
 * jsdom 环境提供 document.documentElement；matchMedia 由用例自行注入以可控 prefers-color-scheme。
 */

const settingsGet = vi.fn(async (_p: { key: string }): Promise<any> => undefined)
const settingsSet = vi.fn(async (_p: { key: string; value: string }): Promise<void> => {})

;(globalThis as any).window.electronAPI = { settings: { get: settingsGet, set: settingsSet } }

let mediaMatches = false
const mediaListeners = new Set<(e?: any) => void>()

function installMatchMedia() {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    configurable: true,
    value: (query: string) => ({
      matches: mediaMatches,
      media: query,
      onchange: null,
      addEventListener: (_type: string, cb: any) => { mediaListeners.add(cb) },
      removeEventListener: (_type: string, cb: any) => { mediaListeners.delete(cb) },
      addListener: (cb: any) => { mediaListeners.add(cb) },
      removeListener: (cb: any) => { mediaListeners.delete(cb) },
      dispatchEvent: () => false,
    }),
  })
}

const { useAppearanceStore, getEffectiveTheme, listenSystemThemeChange, FONT_SIZE_MAP, FONT_SIZE_SM_MAP, FONT_SIZE_LG_MAP, FONT_SIZE_XL_MAP } =
  await import('../../../src/stores/appearance.store')
const i18n = (await import('../../../src/i18n')).default

function resetDom() {
  const root = document.documentElement
  root.removeAttribute('data-theme')
  root.removeAttribute('data-font-size')
  root.removeAttribute('data-locale')
  root.classList.remove('dark')
  root.removeAttribute('style')
}

beforeEach(() => {
  mediaMatches = false
  mediaListeners.clear()
  installMatchMedia()
  resetDom()
  settingsGet.mockReset().mockResolvedValue(undefined)
  settingsSet.mockReset().mockResolvedValue(undefined)
  useAppearanceStore.setState({
    themeMode: 'dark',
    fontSizeLevel: 'medium',
    locale: 'zh-CN',
    initialized: false,
  })
})

afterEach(() => {
  resetDom()
})

describe('appearance.store / 默认状态与 getEffectiveTheme', () => {
  it('默认使用暗色主题、中号字号、中文', () => {
    const s = useAppearanceStore.getState()
    expect(s.themeMode).toBe('dark')
    expect(s.fontSizeLevel).toBe('medium')
    expect(s.locale).toBe('zh-CN')
    expect(s.initialized).toBe(false)
  })

  it('light/dark 直接透传，system 取决于 prefers-color-scheme', () => {
    expect(getEffectiveTheme('light')).toBe('light')
    expect(getEffectiveTheme('dark')).toBe('dark')
    mediaMatches = false
    expect(getEffectiveTheme('system')).toBe('light')
    mediaMatches = true
    expect(getEffectiveTheme('system')).toBe('dark')
  })

  it('字号映射表覆盖全部档位', () => {
    for (const level of ['small', 'medium', 'large', 'xlarge'] as const) {
      expect(FONT_SIZE_MAP[level]).toBeTypeOf('number')
      expect(FONT_SIZE_SM_MAP[level]).toBeTypeOf('number')
      expect(FONT_SIZE_LG_MAP[level]).toBeTypeOf('number')
      expect(FONT_SIZE_XL_MAP[level]).toBeTypeOf('number')
    }
  })
})

describe('appearance.store / setThemeMode', () => {
  it('切换亮色：持久化 + data-theme=light + 移除 dark class', () => {
    document.documentElement.classList.add('dark')
    useAppearanceStore.getState().setThemeMode('light')
    expect(useAppearanceStore.getState().themeMode).toBe('light')
    expect(settingsSet).toHaveBeenCalledWith({ key: 'appearance_theme', value: 'light' })
    expect(document.documentElement.getAttribute('data-theme')).toBe('light')
    expect(document.documentElement.classList.contains('dark')).toBe(false)
  })

  it('切换暗色：添加 dark class', () => {
    useAppearanceStore.getState().setThemeMode('dark')
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark')
    expect(document.documentElement.classList.contains('dark')).toBe(true)
  })

  it('system 档位按系统偏好应用到 DOM', () => {
    mediaMatches = true
    useAppearanceStore.getState().setThemeMode('system')
    expect(useAppearanceStore.getState().themeMode).toBe('system')
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark')
    expect(document.documentElement.classList.contains('dark')).toBe(true)

    mediaMatches = false
    useAppearanceStore.getState().setThemeMode('system')
    expect(document.documentElement.getAttribute('data-theme')).toBe('light')
    expect(document.documentElement.classList.contains('dark')).toBe(false)
  })
})

describe('appearance.store / setFontSizeLevel', () => {
  it('写入 CSS 变量与 data-font-size', () => {
    useAppearanceStore.getState().setFontSizeLevel('xlarge')
    expect(useAppearanceStore.getState().fontSizeLevel).toBe('xlarge')
    expect(settingsSet).toHaveBeenCalledWith({ key: 'appearance_font_size', value: 'xlarge' })
    const style = document.documentElement.style
    expect(style.getPropertyValue('--font-size-base')).toBe(`${FONT_SIZE_MAP.xlarge}px`)
    expect(style.getPropertyValue('--font-size-sm')).toBe(`${FONT_SIZE_SM_MAP.xlarge}px`)
    expect(style.getPropertyValue('--font-size-lg')).toBe(`${FONT_SIZE_LG_MAP.xlarge}px`)
    expect(style.getPropertyValue('--font-size-xl')).toBe(`${FONT_SIZE_XL_MAP.xlarge}px`)
    expect(document.documentElement.getAttribute('data-font-size')).toBe('xlarge')
  })

  it('未知档位（越界值）不抛错，仅属性写成未知档位', () => {
    expect(() => useAppearanceStore.getState().setFontSizeLevel('huge' as any)).not.toThrow()
    expect(useAppearanceStore.getState().fontSizeLevel).toBe('huge')
    expect(document.documentElement.getAttribute('data-font-size')).toBe('huge')
  })
})

describe('appearance.store / setLocale', () => {
  it('持久化 + 切换 i18n 语言 + data-locale', async () => {
    useAppearanceStore.getState().setLocale('en-US')
    expect(useAppearanceStore.getState().locale).toBe('en-US')
    expect(document.documentElement.getAttribute('data-locale')).toBe('en-US')
    expect(settingsSet).toHaveBeenCalledWith({ key: 'appearance_locale', value: 'en-US' })
    await vi.waitFor(() => expect(i18n.language).toBe('en-US'))
  })
})

describe('appearance.store / initialize', () => {
  it('读取持久化值并应用', async () => {
    settingsGet.mockImplementation(async ({ key }: { key: string }) => {
      if (key === 'appearance_theme') return 'light'
      if (key === 'appearance_font_size') return 'large'
      if (key === 'appearance_locale') return 'en-US'
      return undefined
    })
    await useAppearanceStore.getState().initialize()
    const s = useAppearanceStore.getState()
    expect(s).toMatchObject({ themeMode: 'light', fontSizeLevel: 'large', locale: 'en-US', initialized: true })
    expect(document.documentElement.getAttribute('data-theme')).toBe('light')
    expect(document.documentElement.getAttribute('data-font-size')).toBe('large')
    expect(document.documentElement.getAttribute('data-locale')).toBe('en-US')
  })

  it('无持久化值时使用默认值', async () => {
    await useAppearanceStore.getState().initialize()
    const s = useAppearanceStore.getState()
    expect(s).toMatchObject({ themeMode: 'dark', fontSizeLevel: 'medium', locale: 'zh-CN', initialized: true })
  })

  it('已初始化时幂等，不再读取设置', async () => {
    useAppearanceStore.setState({ initialized: true })
    await useAppearanceStore.getState().initialize()
    expect(settingsGet).not.toHaveBeenCalled()
  })

  it('读取失败时兜底为默认值并标记已初始化', async () => {
    settingsGet.mockRejectedValue(new Error('ipc down'))
    await useAppearanceStore.getState().initialize()
    const s = useAppearanceStore.getState()
    expect(s.initialized).toBe(true)
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark')
    expect(document.documentElement.getAttribute('data-locale')).toBe('zh-CN')
  })

  it('读取失败时 state.locale 与 DOM/i18n 一并复位为 zh-CN', async () => {
    useAppearanceStore.getState().setLocale('en-US')
    settingsGet.mockRejectedValue(new Error('ipc down'))
    await useAppearanceStore.getState().initialize()
    // 失败分支同步回写 state.locale，保持 state / data-locale / i18n 三者一致
    expect(document.documentElement.getAttribute('data-locale')).toBe('zh-CN')
    expect(useAppearanceStore.getState().locale).toBe('zh-CN')
    await vi.waitFor(() => expect(i18n.language).toBe('zh-CN'))
  })
})

describe('appearance.store / listenSystemThemeChange', () => {
  it('仅 system 档位响应系统主题变化', () => {
    useAppearanceStore.setState({ themeMode: 'light' })
    const off = listenSystemThemeChange()
    expect(mediaListeners.size).toBe(1)
    document.documentElement.setAttribute('data-theme', 'light')
    mediaMatches = true
    for (const cb of mediaListeners) cb()
    expect(document.documentElement.getAttribute('data-theme')).toBe('light') // 非 system 不响应

    useAppearanceStore.setState({ themeMode: 'system' })
    for (const cb of mediaListeners) cb()
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark')
    off()
    expect(mediaListeners.size).toBe(0)
  })

  it('取消订阅后不再响应', () => {
    useAppearanceStore.setState({ themeMode: 'system' })
    const off = listenSystemThemeChange()
    off()
    mediaMatches = true
    document.documentElement.setAttribute('data-theme', 'light')
    for (const cb of mediaListeners) cb()
    expect(document.documentElement.getAttribute('data-theme')).toBe('light')
  })
})
