import { describe, it, expect } from 'vitest'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import {
  engineSatisfies,
  PLUGIN_PROTOCOL_VERSION,
} from '../../../electron/main/services/plugin/plugin-host.service'
import { validateCapabilities } from '../../../electron/main/services/plugin/plugin-capability'
import type { PluginCapability } from '../../../plugin-sdk/src'

/**
 * 插件 manifest / capabilities 契约一致性：
 * - manifest.id 规则（宿主 ID_RE）、engine 与宿主协议版本兼容（复用 engineSatisfies）
 * - manifest.version 与 package.json.version 一致；包名遵循 workavatar-plugin-<目录名>
 * - manifest.ipc 白名单 ↔ 主进程 ctx.ipc.handle 注册通道双向一致
 * - manifest nav.order 唯一、nav.label 在插件 locale 中存在
 * - 插件工具 id ↔ 插件 locale toolNames 双向一致
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')

/** 与宿主 plugin-host.service 的 ID_RE / RESERVED_IDS 保持同一规则 */
const ID_RE = /^[a-z][a-z0-9-]{1,63}$/
const RESERVED_IDS = ['settings', 'tasks', 'employees', 'list', 'invoke', 'event']
const SEMVER_RE = /^\d+\.\d+\.\d+$/

interface PluginStat {
  id: string
  dirName: string
  relDir: string
  manifest: Record<string, any>
  pkg: Record<string, any>
  zh: Record<string, any>
  en: Record<string, any>
}

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

function readJson(file: string): Record<string, any> {
  return JSON.parse(fs.readFileSync(file, 'utf-8'))
}

function walkTs(dir: string, out: string[] = []): string[] {
  if (!fs.existsSync(dir)) return out
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) walkTs(full, out)
    else if (/\.tsx?$/.test(entry.name)) out.push(full)
  }
  return out
}

const plugins: PluginStat[] = pluginDirs().map((dir) => {
  const manifest = readJson(path.join(dir, 'manifest.json'))
  const pkgPath = path.join(dir, 'package.json')
  return {
    id: manifest.id as string,
    dirName: path.basename(dir),
    relDir: path.relative(ROOT, dir),
    manifest,
    pkg: fs.existsSync(pkgPath) ? readJson(pkgPath) : {},
    zh: readJson(path.join(dir, 'locale', 'zh-CN.json')),
    en: readJson(path.join(dir, 'locale', 'en-US.json')),
  }
})

describe('插件 manifest 基础契约', () => {
  it('仓库内至少解析到一个插件', () => {
    expect(plugins.length).toBeGreaterThan(0)
  })

  it('id 合法（宿主 ID_RE）、非保留字、版本号为 semver', () => {
    const violations: string[] = []
    for (const p of plugins) {
      if (!p.id || !ID_RE.test(p.id)) violations.push(`${p.relDir}: manifest.id 非法 "${p.id}"`)
      if (RESERVED_IDS.includes(p.id)) violations.push(`${p.relDir}: manifest.id 为宿主保留字 "${p.id}"`)
      if (!SEMVER_RE.test(p.manifest.version ?? '')) {
        violations.push(`${p.relDir}: manifest.version 非 semver "${p.manifest.version}"`)
      }
    }
    expect(violations, violations.join('\n')).toEqual([])
  })

  it('主进程/渲染端入口与 locale 目录真实存在', () => {
    const violations: string[] = []
    for (const p of plugins) {
      const dir = path.join(ROOT, p.relDir)
      for (const field of ['main', 'renderer'] as const) {
        const value = p.manifest[field]
        if (!value) violations.push(`${p.relDir}: manifest 缺少 ${field}`)
        else if (!fs.existsSync(path.join(dir, value))) violations.push(`${p.relDir}: ${field} 指向的文件不存在 (${value})`)
      }
      if (!p.manifest.locale) violations.push(`${p.relDir}: manifest 缺少 locale`)
      else if (!fs.existsSync(path.join(dir, p.manifest.locale))) {
        violations.push(`${p.relDir}: locale 目录不存在 (${p.manifest.locale})`)
      }
    }
    expect(violations, violations.join('\n')).toEqual([])
  })

  it('nav.label（i18n key）在插件中英 locale 中都存在', () => {
    const violations: string[] = []
    for (const p of plugins) {
      const label = p.manifest.nav?.label
      if (!label) {
        violations.push(`${p.relDir}: manifest.nav.label 缺失`)
        continue
      }
      if (typeof p.zh[label] !== 'string') violations.push(`${p.relDir}: zh-CN.json 缺少 nav.label 键 "${label}"`)
      if (typeof p.en[label] !== 'string') violations.push(`${p.relDir}: en-US.json 缺少 nav.label 键 "${label}"`)
      if (typeof p.manifest.nav?.order !== 'number') violations.push(`${p.relDir}: manifest.nav.order 非数字`)
    }
    expect(violations, violations.join('\n')).toEqual([])
  })
})

describe('插件 manifest ↔ package.json', () => {
  it('版本号一致且包名遵循 workavatar-plugin-<目录名>', () => {
    const violations: string[] = []
    for (const p of plugins) {
      if (!p.pkg.version) {
        violations.push(`${p.relDir}: 缺少 package.json 或 version`)
        continue
      }
      if (p.pkg.version !== p.manifest.version) {
        violations.push(`${p.relDir}: manifest.version=${p.manifest.version} 与 package.json.version=${p.pkg.version} 不一致`)
      }
      const expectedName = `workavatar-plugin-${p.dirName}`
      if (p.pkg.name !== expectedName) {
        violations.push(`${p.relDir}: package.json.name=${p.pkg.name}，期望 ${expectedName}`)
      }
    }
    expect(violations, violations.join('\n')).toEqual([])
  })
})

describe('插件 engine ↔ 宿主协议版本', () => {
  it('宿主协议版本为 semver 且 * 范围恒满足', () => {
    expect(SEMVER_RE.test(PLUGIN_PROTOCOL_VERSION)).toBe(true)
    expect(engineSatisfies('*', PLUGIN_PROTOCOL_VERSION)).toBe(true)
  })

  it('每个插件的 engine 范围都兼容宿主协议版本', () => {
    const violations: string[] = []
    for (const p of plugins) {
      const engine = p.manifest.engine ?? '*'
      if (!engineSatisfies(engine, PLUGIN_PROTOCOL_VERSION)) {
        violations.push(`${p.relDir}: engine "${engine}" 不满足宿主协议 ${PLUGIN_PROTOCOL_VERSION}`)
      }
    }
    expect(violations, violations.join('\n')).toEqual([])
  })
})

describe('插件 capabilities 结构校验', () => {
  it('宿主 validateCapabilities 全部通过', () => {
    const violations: string[] = []
    for (const p of plugins) {
      const result = validateCapabilities(p.manifest.capabilities as PluginCapability[] | undefined)
      if (!result.ok) violations.push(`${p.relDir}: ${result.reason}`)
    }
    expect(violations, violations.join('\n')).toEqual([])
  })
})

describe('插件 manifest.ipc ↔ 主进程注册通道', () => {
  const registeredByPlugin = new Map<string, Set<string>>()
  for (const p of plugins) {
    const found = new Set<string>()
    for (const file of walkTs(path.join(ROOT, p.relDir, 'src', 'main'))) {
      const text = fs.readFileSync(file, 'utf-8')
      for (const m of text.matchAll(/ctx\.ipc\.handle\(\s*'([^']+)'/g)) found.add(m[1])
    }
    registeredByPlugin.set(p.relDir, found)
  }

  it('manifest.ipc 无重复条目', () => {
    const violations: string[] = []
    for (const p of plugins) {
      const ipc: string[] = p.manifest.ipc ?? []
      const dup = ipc.filter((c, i) => ipc.indexOf(c) !== i)
      if (dup.length) violations.push(`${p.relDir}: manifest.ipc 重复 ${[...new Set(dup)].join(', ')}`)
    }
    expect(violations, violations.join('\n')).toEqual([])
  })

  it('代码中注册的通道都必须出现在 manifest.ipc 白名单内', () => {
    const violations: string[] = []
    for (const p of plugins) {
      const declared = new Set<string>(p.manifest.ipc ?? [])
      for (const channel of registeredByPlugin.get(p.relDir) ?? []) {
        if (!declared.has(channel)) violations.push(`${p.relDir}: ctx.ipc.handle('${channel}') 未在 manifest.ipc 中声明`)
      }
    }
    expect(violations, violations.join('\n')).toEqual([])
  })

  it('manifest.ipc 声明的通道都必须有 ctx.ipc.handle 注册', () => {
    const violations: string[] = []
    for (const p of plugins) {
      const registered = registeredByPlugin.get(p.relDir) ?? new Set<string>()
      for (const channel of (p.manifest.ipc ?? []) as string[]) {
        if (!registered.has(channel)) violations.push(`${p.relDir}: manifest.ipc 声明了 "${channel}" 但代码中无注册`)
      }
    }
    expect(violations, violations.join('\n')).toEqual([])
  })
})

describe('插件导航顺序', () => {
  it('各插件 manifest.nav.order 唯一（重复会导致导航顺序不确定）', () => {
    const byOrder = new Map<number, string[]>()
    for (const p of plugins) {
      const order = p.manifest.nav?.order
      if (typeof order !== 'number') continue
      if (!byOrder.has(order)) byOrder.set(order, [])
      byOrder.get(order)!.push(p.id)
    }
    const violations = [...byOrder.entries()]
      .filter(([, ids]) => ids.length > 1)
      .map(([order, ids]) => `nav.order=${order} 被重复使用: ${ids.join(', ')}`)
    expect(violations, violations.join('\n')).toEqual([])
  })
})

describe('插件工具 id ↔ 插件 locale toolNames', () => {
  it('工具定义文件中的工具 id 与 locale toolNames 键双向一致', () => {
    const violations: string[] = []
    for (const p of plugins) {
      const localeTools = Object.keys((p.zh.toolNames ?? {}) as Record<string, unknown>)
      const toolFiles = walkTs(path.join(ROOT, p.relDir, 'src')).filter((f) => /tools?\.ts$/.test(f))
      if (localeTools.length === 0 || toolFiles.length === 0) continue
      const defined = new Set<string>()
      for (const file of toolFiles) {
        const text = fs.readFileSync(file, 'utf-8')
        for (const m of text.matchAll(/(?:^|\n)\s*(?:id|name):\s*'([a-z][a-z0-9_]+)'/g)) defined.add(m[1])
      }
      for (const id of defined) {
        if (!localeTools.includes(id)) violations.push(`${p.relDir}: 工具 ${id} 缺少 locale toolNames 键`)
      }
      for (const key of localeTools) {
        if (!defined.has(key)) violations.push(`${p.relDir}: locale toolNames.${key} 无对应工具定义`)
      }
    }
    expect(violations, violations.join('\n')).toEqual([])
  })
})
