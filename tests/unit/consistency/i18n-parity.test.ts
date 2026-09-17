import { describe, it, expect } from 'vitest'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import zhCN from '../../../src/i18n/locales/zh-CN'
import enUS from '../../../src/i18n/locales/en-US'

/**
 * i18n 契约一致性：
 * - 宿主 zh-CN / en-US 键集合必须完全一致（叶子键递归展平比较）
 * - 英文资源不得残留中文文案
 * - 插件 locale（plugins/<id>/locale/*.json）键集合必须完全一致
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const CN_RE = /[\u4e00-\u9fa5]/

type Dict = Record<string, unknown>

function flatten(dict: Dict, prefix = '', out: Array<[string, unknown]> = []): Array<[string, unknown]> {
  for (const key of Object.keys(dict)) {
    const value = dict[key]
    const full = prefix ? `${prefix}.${key}` : key
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      flatten(value as Dict, full, out)
    } else {
      out.push([full, value])
    }
  }
  return out
}

function leafMap(dict: Dict): Map<string, unknown> {
  return new Map(flatten(dict))
}

function diffKeys(a: Set<string>, b: Set<string>): string[] {
  return [...a].filter((k) => !b.has(k)).sort()
}

/** 插件目录（含 plugins/examples/*），以存在 manifest.json 为准 */
function pluginDirs(): string[] {
  const bases = [path.join(ROOT, 'plugins'), path.join(ROOT, 'plugins', 'examples')]
  const dirs: string[] = []
  for (const base of bases) {
    for (const entry of fs.readdirSync(base, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const dir = path.join(base, entry.name)
      if (fs.existsSync(path.join(dir, 'manifest.json'))) dirs.push(dir)
    }
  }
  return dirs
}

describe('宿主 i18n（zh-CN ↔ en-US）', () => {
  const zh = leafMap(zhCN as Dict)
  const en = leafMap(enUS as Dict)

  it('键集合完全一致', () => {
    const onlyZh = diffKeys(new Set(zh.keys()), new Set(en.keys()))
    const onlyEn = diffKeys(new Set(en.keys()), new Set(zh.keys()))
    expect(
      { onlyZh, onlyEn },
      `仅 zh-CN 存在: ${onlyZh.join(', ')}\n仅 en-US 存在: ${onlyEn.join(', ')}`
    ).toEqual({ onlyZh: [], onlyEn: [] })
  })

  it('英文资源不残留中文文案', () => {
    const zhInEn = [...en.entries()]
      .filter(([, v]) => typeof v === 'string' && CN_RE.test(v))
      .map(([k]) => k)
    expect(zhInEn, `en-US 中残留中文的键: ${zhInEn.join(', ')}`).toEqual([])
  })

  it('同键的空值状态在两语言下一致（一侧有文案，另一侧不得为空）', () => {
    const violations: string[] = []
    for (const [key, zhValue] of zh.entries()) {
      if (!en.has(key)) continue
      const enValue = en.get(key)
      const zhEmpty = typeof zhValue === 'string' && zhValue.trim() === ''
      const enEmpty = typeof enValue === 'string' && enValue.trim() === ''
      if (zhEmpty !== enEmpty) violations.push(`${key} (zh: "${zhValue}" / en: "${enValue}")`)
    }
    expect(violations, `空值状态不一致的键:\n${violations.join('\n')}`).toEqual([])
  })

  it('workbench.toolNames 与 workbench.toolDescriptions 键集合一一对应（中英文各自成立）', () => {
    const violations: string[] = []
    for (const [locale, dict] of [['zh-CN', zhCN], ['en-US', enUS]] as const) {
      const wb = (dict as Dict).workbench as Dict
      const toolNames = new Set(Object.keys((wb.toolNames ?? {}) as Dict))
      const toolDescriptions = new Set(Object.keys((wb.toolDescriptions ?? {}) as Dict))
      expect(toolNames.size, `${locale}: workbench.toolNames 为空`).toBeGreaterThan(0)
      for (const k of diffKeys(toolNames, toolDescriptions)) violations.push(`${locale}: toolNames 独有 ${k}`)
      for (const k of diffKeys(toolDescriptions, toolNames)) violations.push(`${locale}: toolDescriptions 独有 ${k}`)
    }
    expect(violations, violations.join('\n')).toEqual([])
  })
})

describe('插件 locale（zh-CN ↔ en-US）', () => {
  const dirs = pluginDirs()

  it('至少存在一个插件 locale 目录', () => {
    expect(dirs.length).toBeGreaterThan(0)
  })

  it('每个插件的中英键集合完全一致，且英文无中文残留', () => {
    const violations: string[] = []
    for (const dir of dirs) {
      const id = path.basename(dir)
      const zhPath = path.join(dir, 'locale', 'zh-CN.json')
      const enPath = path.join(dir, 'locale', 'en-US.json')
      if (!fs.existsSync(zhPath) || !fs.existsSync(enPath)) {
        violations.push(`${id}: 缺少 locale/zh-CN.json 或 locale/en-US.json`)
        continue
      }
      const zh = leafMap(JSON.parse(fs.readFileSync(zhPath, 'utf-8')) as Dict)
      const en = leafMap(JSON.parse(fs.readFileSync(enPath, 'utf-8')) as Dict)
      for (const k of diffKeys(new Set(zh.keys()), new Set(en.keys()))) violations.push(`${id}: 仅 zh-CN 有键 ${k}`)
      for (const k of diffKeys(new Set(en.keys()), new Set(zh.keys()))) violations.push(`${id}: 仅 en-US 有键 ${k}`)
      for (const [k, v] of en.entries()) {
        if (typeof v === 'string' && CN_RE.test(v)) violations.push(`${id}: en-US.${k} 残留中文 "${v}"`)
      }
    }
    expect(violations, violations.join('\n')).toEqual([])
  })
})
