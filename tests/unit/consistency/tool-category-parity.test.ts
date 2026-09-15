import { describe, it, expect } from 'vitest'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import * as ts from 'typescript'
import zhCN from '../../../src/i18n/locales/zh-CN'
import enUS from '../../../src/i18n/locales/en-US'

/**
 * 工具分类前后端契约（项目规则：分类 ID 与 toolIds 必须前后端严格一致）。
 *
 * 后端单源真相：electron/main/ipc/tool.handlers.ts 的 TOOL_CATEGORY_DEFS
 * 前端：src/components/employee-settings/ToolsSection.tsx、src/pages/creation-wizard/ToolCheckboxes.tsx
 *      的 CATEGORY_ICON_MAP（按后端 icon 字段取值；分类 id/toolIds 由后端 IPC 下发）
 * i18n：employeeSettings.toolCategory_<id> / toolCategoryDesc_<id>
 *
 * 采用 TypeScript AST 静态解析，不 import 生产代码（避免拉起 Electron 运行时）。
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')

const TOOL_HANDLERS = path.join(ROOT, 'electron', 'main', 'ipc', 'tool.handlers.ts')
const TOOLS_SECTION = path.join(ROOT, 'src', 'components', 'employee-settings', 'ToolsSection.tsx')
const TOOL_CHECKBOXES = path.join(ROOT, 'src', 'pages', 'creation-wizard', 'ToolCheckboxes.tsx')
const AGENT_TOOLS_DIR = path.join(ROOT, 'electron', 'main', 'services', 'agent', 'tools')
const GENERIC_AGENT = path.join(ROOT, 'electron', 'main', 'services', 'agent', 'business', 'generic-agent.ts')

/** 文档（.trae/rules/实现方案.md §1）声明的内置分类顺序 */
const DOCUMENTED_CATEGORY_ORDER = [
  'file_operations',
  'kms',
  'web',
  'scripting',
  'conversation_memory',
  'basic_helpers',
  'collaboration',
]

function readSource(file: string): ts.SourceFile {
  const text = fs.readFileSync(file, 'utf-8')
  return ts.createSourceFile(
    file,
    text,
    ts.ScriptTarget.Latest,
    true,
    file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS
  )
}

function declInit(sf: ts.SourceFile, varName: string): ts.Expression | undefined {
  for (const stmt of sf.statements) {
    if (!ts.isVariableStatement(stmt)) continue
    for (const decl of stmt.declarationList.declarations) {
      if (decl.name.getText(sf) === varName && decl.initializer) return decl.initializer
    }
  }
  return undefined
}

function propName(name: ts.PropertyName): string {
  return ts.isStringLiteral(name) ? name.text : name.getText()
}

function strProp(obj: ts.ObjectLiteralExpression, name: string): string | undefined {
  for (const p of obj.properties) {
    if (ts.isPropertyAssignment(p) && propName(p.name) === name && ts.isStringLiteral(p.initializer)) {
      return p.initializer.text
    }
  }
  return undefined
}

function strArrayProp(obj: ts.ObjectLiteralExpression, name: string): string[] {
  for (const p of obj.properties) {
    if (!ts.isPropertyAssignment(p) || propName(p.name) !== name) continue
    if (!ts.isArrayLiteralExpression(p.initializer)) return []
    return p.initializer.elements.filter(ts.isStringLiteral).map((e) => e.text)
  }
  return []
}

interface CategoryDef {
  id: string
  name: string
  icon: string
  toolIds: string[]
}

function backendCategoryDefs(): CategoryDef[] {
  const sf = readSource(TOOL_HANDLERS)
  const init = declInit(sf, 'TOOL_CATEGORY_DEFS')
  if (!init || !ts.isArrayLiteralExpression(init)) throw new Error('未找到 TOOL_CATEGORY_DEFS 数组定义')
  return init.elements.filter(ts.isObjectLiteralExpression).map((obj) => ({
    id: strProp(obj, 'id') ?? '',
    name: strProp(obj, 'name') ?? '',
    icon: strProp(obj, 'icon') ?? '',
    toolIds: strArrayProp(obj, 'toolIds'),
  }))
}

/** 前端 CATEGORY_ICON_MAP 的键集合（键为后端分类的 icon 字段值） */
function frontendIconMapKeys(file: string): string[] {
  const init = declInit(readSource(file), 'CATEGORY_ICON_MAP')
  if (!init || !ts.isObjectLiteralExpression(init)) throw new Error(`未找到 CATEGORY_ICON_MAP: ${file}`)
  return init.properties.filter(ts.isPropertyAssignment).map((p) => propName(p.name))
}

/** 后端内置工具 id 全集（工具定义文件 + 技能工具所在 agent 文件） */
function builtinToolIds(): Set<string> {
  const files = fs
    .readdirSync(AGENT_TOOLS_DIR)
    .filter((f) => f.endsWith('.ts'))
    .map((f) => path.join(AGENT_TOOLS_DIR, f))
  files.push(GENERIC_AGENT)
  const ids = new Set<string>()
  for (const file of files) {
    const text = fs.readFileSync(file, 'utf-8')
    for (const m of text.matchAll(/(?:^|\n)\s*id:\s*'([a-z][a-z0-9_]*)'/g)) ids.add(m[1])
  }
  return ids
}

const defs = backendCategoryDefs()
const toolsSectionIcons = frontendIconMapKeys(TOOLS_SECTION)
const toolCheckboxesIcons = frontendIconMapKeys(TOOL_CHECKBOXES)
const builtinIds = builtinToolIds()

describe('工具分类：后端定义自身合法', () => {
  it('分类 id 唯一、name 与 id 一致、toolIds 无重复且非空', () => {
    const violations: string[] = []
    const seen = new Set<string>()
    for (const def of defs) {
      if (!def.id) violations.push('存在缺少 id 的分类定义')
      if (def.name !== def.id) violations.push(`分类 ${def.id} 的 name(${def.name}) 与 id 不一致`)
      if (seen.has(def.id)) violations.push(`分类 id 重复: ${def.id}`)
      seen.add(def.id)
      if (def.toolIds.length === 0) violations.push(`分类 ${def.id} toolIds 为空`)
      const dup = def.toolIds.filter((t, i) => def.toolIds.indexOf(t) !== i)
      if (dup.length) violations.push(`分类 ${def.id} toolIds 重复: ${[...new Set(dup)].join(', ')}`)
      if (!def.icon) violations.push(`分类 ${def.id} 缺少 icon`)
    }
    expect(violations, violations.join('\n')).toEqual([])
  })

  it('内置分类 id 与顺序符合实现方案文档', () => {
    expect(defs.map((d) => d.id)).toEqual(DOCUMENTED_CATEGORY_ORDER)
  })
})

describe('工具分类：前后端一致性', () => {
  it('每个后端分类的 icon 在两个前端 CATEGORY_ICON_MAP 中都有映射', () => {
    const violations: string[] = []
    for (const def of defs) {
      if (!toolsSectionIcons.includes(def.icon)) {
        violations.push(`ToolsSection.tsx CATEGORY_ICON_MAP 缺少 icon "${def.icon}"（分类 ${def.id}）`)
      }
      if (!toolCheckboxesIcons.includes(def.icon)) {
        violations.push(`ToolCheckboxes.tsx CATEGORY_ICON_MAP 缺少 icon "${def.icon}"（分类 ${def.id}）`)
      }
    }
    expect(violations, violations.join('\n')).toEqual([])
  })

  it('前端不硬编码内置分类 id（分类定义只能有后端一个真相源）', () => {
    const violations: string[] = []
    for (const file of [TOOLS_SECTION, TOOL_CHECKBOXES]) {
      const src = fs.readFileSync(file, 'utf-8')
      for (const id of defs.map((d) => d.id)) {
        if (new RegExp(`['"\`]${id}['"\`]`).test(src)) {
          violations.push(`${path.basename(file)} 硬编码了分类 id "${id}"`)
        }
      }
    }
    expect(violations, violations.join('\n')).toEqual([])
  })

  it('内置分类引用的工具 id 都存在于后端内置工具清单', () => {
    const violations: string[] = []
    for (const def of defs) {
      for (const toolId of def.toolIds) {
        if (!builtinIds.has(toolId)) violations.push(`分类 ${def.id} 引用了不存在的内置工具 ${toolId}`)
      }
    }
    expect(violations, violations.join('\n')).toEqual([])
  })
})

describe('工具分类：i18n 文案覆盖', () => {
  it('employeeSettings.toolCategory_<id> / toolCategoryDesc_<id> 覆盖全部分类（中英文）', () => {
    const violations: string[] = []
    for (const [locale, dict] of [['zh-CN', zhCN], ['en-US', enUS]] as const) {
      const settings = (dict as Record<string, unknown>).employeeSettings as Record<string, unknown>
      for (const def of defs) {
        for (const prefix of ['toolCategory_', 'toolCategoryDesc_']) {
          const key = `${prefix}${def.id}`
          if (typeof settings?.[key] !== 'string') violations.push(`${locale} 缺少 employeeSettings.${key}`)
        }
      }
    }
    expect(violations, violations.join('\n')).toEqual([])
  })
})

describe('内置工具文案覆盖（workbench.toolNames / toolDescriptions）', () => {
  const backendIds = [...builtinIds].sort()

  it('后端内置工具清单的每个工具在两语言下都有 toolNames / toolDescriptions 键', () => {
    const violations: string[] = []
    for (const [locale, dict] of [['zh-CN', zhCN], ['en-US', enUS]] as const) {
      const wb = (dict as Record<string, unknown>).workbench as Record<string, unknown>
      const names = (wb?.toolNames ?? {}) as Record<string, unknown>
      const descriptions = (wb?.toolDescriptions ?? {}) as Record<string, unknown>
      for (const id of backendIds) {
        if (typeof names[id] !== 'string') violations.push(`${locale} 缺少 workbench.toolNames.${id}`)
        if (typeof descriptions[id] !== 'string') violations.push(`${locale} 缺少 workbench.toolDescriptions.${id}`)
      }
    }
    expect(violations, violations.join('\n')).toEqual([])
  })

  it('workbench.toolNames 不存在指向已删除工具的死键', () => {
    const wb = (zhCN as Record<string, unknown>).workbench as Record<string, unknown>
    const names = Object.keys((wb?.toolNames ?? {}) as Record<string, unknown>)
    const stale = names.filter((k) => !builtinIds.has(k))
    expect(stale, `workbench.toolNames 中无对应工具定义的键: ${stale.join(', ')}`).toEqual([])
  })
})
