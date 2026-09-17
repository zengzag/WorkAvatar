import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest'

/**
 * src/i18n：初始化配置（默认语言 / fallbackLng / 命名空间）与缺失键回退、
 * 以及 locale 持久化的读写与异常兜底。
 */

const settingsGet = vi.fn(async (_p: { key: string }): Promise<any> => undefined)
const settingsSet = vi.fn(async (_p: { key: string; value: string }): Promise<void> => {})

vi.stubGlobal('window', { electronAPI: { settings: { get: settingsGet, set: settingsSet } } })

const mod = await import('../../../src/i18n')
const i18n = mod.default

beforeAll(async () => {
  await i18n.changeLanguage('zh-CN')
})

afterEach(async () => {
  settingsGet.mockReset().mockResolvedValue(undefined)
  settingsSet.mockReset().mockResolvedValue(undefined)
  await i18n.changeLanguage('zh-CN')
})

describe('i18n / 初始化与命名空间', () => {
  it('默认语言与 fallbackLng 均为 zh-CN', () => {
    // i18next 内部把 fallbackLng 归一化为数组
    expect([(i18n.options.fallbackLng as any)].flat()).toEqual(['zh-CN'])
    expect(i18n.hasResourceBundle('zh-CN', 'translation')).toBe(true)
    expect(i18n.hasResourceBundle('en-US', 'translation')).toBe(true)
  })

  it('中英文资源按当前语言解析', async () => {
    expect(i18n.t('workbench.justNow')).toBe('刚刚')
    await i18n.changeLanguage('en-US')
    expect(i18n.t('workbench.justNow')).toBe('Just now')
    await i18n.changeLanguage('zh-CN')
    expect(i18n.t('workbench.justNow')).toBe('刚刚')
  })

  it('插值配置生效（escapeValue=false，不转义特殊字符）', async () => {
    expect(i18n.t('workbench.monthDay', { month: 1, day: 5 })).toBe('1月5日')
    await i18n.changeLanguage('en-US')
    expect(typeof i18n.t('workbench.monthDay', { month: 12, day: 31 })).toBe('string')
  })

  it('缺失键返回 key 本身（不抛错）', () => {
    expect(i18n.t('definitely.not.exist.key')).toBe('definitely.not.exist.key')
  })

  it('en-US 缺失但 zh-CN 存在的键走 fallbackLng', async () => {
    i18n.addResourceBundle('zh-CN', 'translation', { __wa_fallback_probe__: '中文兜底' }, true, true)
    await i18n.changeLanguage('en-US')
    expect(i18n.t('__wa_fallback_probe__')).toBe('中文兜底')
    i18n.removeResourceBundle('zh-CN', 'translation')
    await i18n.changeLanguage('zh-CN')
  })

  it('getSavedLocale 读取持久化值，默认 zh-CN，异常兜底 zh-CN', async () => {
    settingsGet.mockResolvedValue('en-US')
    expect(await mod.getSavedLocale()).toBe('en-US')
    expect(settingsGet).toHaveBeenCalledWith({ key: 'appearance_locale' })

    settingsGet.mockResolvedValue(undefined)
    expect(await mod.getSavedLocale()).toBe('zh-CN')
    settingsGet.mockResolvedValue('')
    expect(await mod.getSavedLocale()).toBe('zh-CN')

    settingsGet.mockRejectedValue(new Error('ipc down'))
    expect(await mod.getSavedLocale()).toBe('zh-CN')
    settingsGet.mockImplementation(() => { throw new Error('sync boom') })
    expect(await mod.getSavedLocale()).toBe('zh-CN')
  })

  it('saveLocale 写持久化并在失败时静默', async () => {
    await mod.saveLocale('en-US')
    expect(settingsSet).toHaveBeenCalledWith({ key: 'appearance_locale', value: 'en-US' })

    settingsSet.mockRejectedValue(new Error('ipc down'))
    await expect(mod.saveLocale('zh-CN')).resolves.toBeUndefined()
    settingsSet.mockImplementation(() => { throw new Error('sync boom') })
    await expect(mod.saveLocale('zh-CN')).resolves.toBeUndefined()
  })
})
