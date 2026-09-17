/**
 * 主进程 UI 文案服务单测：
 * - 语言来源（settings KV `appearance_locale`）读取与容错
 * - t() 插值、订阅通知、缓存语义
 * - 双语文案完整性（所有 key 在 zh-CN / en-US 下均有值，且插值占位一致）
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const mockState = vi.hoisted(() => {
  const settings = new Map<string, string>()
  const db = {
    prepare: (sql: string) => {
      if (sql.includes('FROM settings')) {
        return { get: (key: string) => (settings.has(key) ? { value: settings.get(key) } : undefined) }
      }
      throw new Error(`unexpected sql: ${sql}`)
    },
  }
  return { settings, db }
})

vi.mock('../../../electron/main/services/database.service', () => ({
  default: { getInstance: () => ({ getDb: () => mockState.db }) },
}))

import mainUiI18n, { type MainUiTextKey } from '../../../electron/main/services/ui-i18n.service'

const ALL_KEYS = [
  'trayTooltip', 'trayShowWindow', 'trayQuit',
  'pluginLoadTitle', 'pluginLoadMessage', 'pluginLoadDetail', 'pluginLoadConfirm',
  'pluginCancel', 'pluginOk', 'pluginExistsTitle', 'pluginExistsMessage',
  'pluginUpgradeConfirm', 'pluginLoadedTitle', 'pluginLoadedMessage', 'pluginLoadFailedTitle',
  'askUserNotifyTitle',
  'ocrInitFailedTitle', 'ocrRuntimeErrorTitle', 'ocrRecognizeFailedTitle', 'ocrModelMissing',
  'ocrWorkerInitFailed', 'ocrWorkerCrashed', 'ocrRecognizeFailed', 'ocrPathLabel', 'ocrImageLabel',
  'runtimeUvDesc', 'runtimePythonDesc', 'runtimePythonHint', 'runtimeNodeDesc', 'runtimeNodeHint',
  'runtimePipDesc', 'runtimePipHint',
] as const satisfies readonly MainUiTextKey[]

const priv = mainUiI18n as any

beforeEach(() => {
  mockState.settings.clear()
  // 单例跨用例复用：清掉显式语言覆盖与缓存，还原为"进程刚启动、尚未 setLocale"的初始态
  priv.localeOverride = null
  priv.locale = 'zh-CN'
})

describe('ui-i18n / 语言来源', () => {
  it('无 settings 记录时默认中文', () => {
    expect(mainUiI18n.getLocale()).toBe('zh-CN')
    expect(mainUiI18n.t('trayQuit')).toBe('退出程序')
  })

  it('settings 中 en-US 生效', () => {
    mockState.settings.set('appearance_locale', 'en-US')
    expect(mainUiI18n.getLocale()).toBe('en-US')
    expect(mainUiI18n.t('trayQuit')).toBe('Quit')
  })

  it('非法语言值被忽略，回退到已缓存语言', () => {
    mainUiI18n.setLocale('en-US')
    mockState.settings.set('appearance_locale', 'ja-JP')
    expect(mainUiI18n.getLocale()).toBe('en-US')
  })

  it('settings 读取抛错时不崩溃，返回缓存语言', () => {
    const spy = vi.spyOn(mockState.db, 'prepare').mockImplementation(() => {
      throw new Error('db down')
    })
    expect(mainUiI18n.getLocale()).toBe('zh-CN')
    spy.mockRestore()
  })
})

describe('ui-i18n / setLocale 与订阅', () => {
  it('语言变化时通知订阅者，相同语言不重复通知', () => {
    const cb = vi.fn()
    const off = mainUiI18n.onLocaleChange(cb)
    mainUiI18n.setLocale('zh-CN') // 与初始值相同 → 不通知
    expect(cb).not.toHaveBeenCalled()
    mainUiI18n.setLocale('en-US')
    expect(cb).toHaveBeenCalledWith('en-US')
    mainUiI18n.setLocale('en-US')
    expect(cb).toHaveBeenCalledTimes(1)
    off()
    mainUiI18n.setLocale('zh-CN')
    expect(cb).toHaveBeenCalledTimes(1)
  })

  it('退订后不再接收通知', () => {
    const a = vi.fn()
    const b = vi.fn()
    const offA = mainUiI18n.onLocaleChange(a)
    mainUiI18n.onLocaleChange(b)
    offA()
    mainUiI18n.setLocale('en-US')
    expect(a).not.toHaveBeenCalled()
    expect(b).toHaveBeenCalledTimes(1)
  })

  it('setLocale 的显式语言优先于 DB 旧值（渲染端先 setLocale 后写库也能立即生效）', () => {
    mockState.settings.set('appearance_locale', 'zh-CN')
    mainUiI18n.setLocale('en-US')
    expect(mainUiI18n.getLocale()).toBe('en-US')
    expect(mainUiI18n.t('trayQuit')).toBe('Quit')
  })

  it('未调用 setLocale 时语言仍取自 settings', () => {
    mockState.settings.set('appearance_locale', 'en-US')
    expect(mainUiI18n.getLocale()).toBe('en-US')
    expect(mainUiI18n.t('trayQuit')).toBe('Quit')
  })
})

describe('ui-i18n / t 插值', () => {
  it('替换全部同名占位符', () => {
    expect(mainUiI18n.t('pluginLoadedMessage', { id: 'demo', version: '1.0.0' })).toBe(
      '插件 demo v1.0.0 已加载'
    )
  })

  it('数字参数转字符串', () => {
    expect(mainUiI18n.t('pluginLoadedMessage', { id: 'x', version: 2 })).toContain('v2')
  })

  it('换行占位符正常替换', () => {
    expect(mainUiI18n.t('pluginLoadDetail', { name: '插件A' })).toBe(
      '插件A\n确认后将安装并加载该插件。'
    )
  })

  it('未提供的占位符原样保留（暴露调用方漏传参数）', () => {
    expect(mainUiI18n.t('pluginLoadedMessage', { id: 'demo' })).toContain('{{version}}')
  })

  it('无占位符的 key 不受 params 影响', () => {
    expect(mainUiI18n.t('trayQuit', { unused: 'x' })).toBe('退出程序')
  })

  it('未知 key 抛错（类型约束被绕过时快速暴露）', () => {
    expect(() => mainUiI18n.t('notExist' as MainUiTextKey)).toThrow()
  })
})

describe('ui-i18n / 文案完整性', () => {
  it('所有 key 在两种语言下均为非空字符串', () => {
    for (const lng of ['zh-CN', 'en-US'] as const) {
      mockState.settings.set('appearance_locale', lng)
      for (const key of ALL_KEYS) {
        const text = mainUiI18n.t(key)
        expect(typeof text, `${lng}:${key}`).toBe('string')
        expect(text.trim().length, `${lng}:${key}`).toBeGreaterThan(0)
      }
    }
  })

  it('插值型文案在两种语言下占位符集合一致', () => {
    const placeholders = (s: string) => (s.match(/\{\{\w+\}\}/g) || []).sort()
    for (const key of ALL_KEYS) {
      mockState.settings.set('appearance_locale', 'zh-CN')
      const zh = mainUiI18n.t(key)
      mockState.settings.set('appearance_locale', 'en-US')
      const en = mainUiI18n.t(key)
      expect(placeholders(en), key).toEqual(placeholders(zh))
    }
  })
})
