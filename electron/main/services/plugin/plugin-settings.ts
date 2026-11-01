import type { PluginSettingField } from '../../../../plugin-sdk/src'

/** 设置键命名规则（与 manifest 声明一致，防注入与冲突） */
const KEY_RE = /^[a-zA-Z][a-zA-Z0-9_.-]{0,63}$/

const SETTING_TYPES = new Set(['string', 'textarea', 'number', 'boolean', 'select'])

/** manifest.settings 静态校验（扫描插件时执行，非法即标记插件 invalid） */
export function validatePluginSettingsSchema(fields: unknown): { ok: boolean; reason?: string } {
  if (fields === undefined) return { ok: true }
  if (!Array.isArray(fields)) return { ok: false, reason: 'settings 必须是数组' }
  const seen = new Set<string>()
  for (const raw of fields) {
    const field = raw as PluginSettingField
    if (!field || typeof field !== 'object') return { ok: false, reason: 'settings 项必须是对象' }
    if (typeof field.key !== 'string' || !KEY_RE.test(field.key)) {
      return { ok: false, reason: `settings.key 非法: ${String(field.key)}` }
    }
    if (seen.has(field.key)) return { ok: false, reason: `settings.key 重复: ${field.key}` }
    seen.add(field.key)
    if (!SETTING_TYPES.has(field.type)) return { ok: false, reason: `settings.type 非法: ${String(field.type)}` }
    if (typeof field.label !== 'string' || !field.label.trim()) {
      return { ok: false, reason: `settings.label 缺失: ${field.key}` }
    }
    if (field.type === 'select') {
      if (!Array.isArray(field.options) || field.options.length === 0) {
        return { ok: false, reason: `select 类型需要 options: ${field.key}` }
      }
      for (const option of field.options) {
        if (!option || typeof option.value !== 'string' || typeof option.label !== 'string') {
          return { ok: false, reason: `options 项非法: ${field.key}` }
        }
      }
    }
    if (field.default !== undefined) {
      const check = validateDefaultValue(field)
      if (check) return { ok: false, reason: `settings.default 非法（${field.key}）: ${check}` }
    }
  }
  return { ok: true }
}

function validateDefaultValue(field: PluginSettingField): string | undefined {
  const value = field.default
  switch (field.type) {
    case 'boolean':
      return typeof value === 'boolean' ? undefined : '需要布尔值'
    case 'number':
      return typeof value === 'number' && Number.isFinite(value) ? undefined : '需要数值'
    case 'select':
      return typeof value === 'string' && field.options?.some(o => o.value === value)
        ? undefined
        : '需要命中 options 的字符串值'
    default:
      return typeof value === 'string' ? undefined : '需要字符串'
  }
}

/** 设置项默认值（未声明 default 时按类型取空值） */
export function defaultSettingValue(field: PluginSettingField): unknown {
  const value = field.default
  switch (field.type) {
    case 'boolean':
      return typeof value === 'boolean' ? value : false
    case 'number':
      return typeof value === 'number' && Number.isFinite(value) ? value : undefined
    case 'select':
      if (typeof value === 'string' && field.options?.some(o => o.value === value)) return value
      return field.options?.[0]?.value ?? ''
    default:
      return typeof value === 'string' ? value : ''
  }
}

/** 写入时的严格类型/范围校验（非法即抛错，错误直接展示给用户） */
export function coerceSettingValue(field: PluginSettingField, value: unknown): unknown {
  switch (field.type) {
    case 'boolean':
      if (typeof value === 'boolean') return value
      throw new Error(`设置项 ${field.key} 需要布尔值`)
    case 'number': {
      const num = typeof value === 'number'
        ? value
        : typeof value === 'string' && value.trim() !== '' ? Number(value) : NaN
      if (!Number.isFinite(num)) throw new Error(`设置项 ${field.key} 需要数值`)
      if (field.min !== undefined && num < field.min) throw new Error(`设置项 ${field.key} 不能小于 ${field.min}`)
      if (field.max !== undefined && num > field.max) throw new Error(`设置项 ${field.key} 不能大于 ${field.max}`)
      return num
    }
    case 'select':
      if (typeof value !== 'string' || !field.options?.some(o => o.value === value)) {
        throw new Error(`设置项 ${field.key} 取值非法`)
      }
      return value
    default:
      if (typeof value !== 'string') throw new Error(`设置项 ${field.key} 需要字符串`)
      return value
  }
}

/** 读取时合并默认值：存量值非法则回退默认值，保证插件永远拿到类型正确的配置 */
export function resolveSettingValues(
  fields: PluginSettingField[] | undefined,
  stored: Record<string, unknown> | undefined,
): Record<string, unknown> {
  const values: Record<string, unknown> = {}
  for (const field of fields ?? []) {
    const hasStored = !!stored && Object.prototype.hasOwnProperty.call(stored, field.key)
    if (!hasStored) {
      values[field.key] = defaultSettingValue(field)
      continue
    }
    try {
      values[field.key] = coerceSettingValue(field, stored![field.key])
    } catch {
      values[field.key] = defaultSettingValue(field)
    }
  }
  return values
}

/** 合并一次保存补丁：只接受 schema 声明的键，返回完整的新值 */
export function applySettingUpdate(
  fields: PluginSettingField[] | undefined,
  current: Record<string, unknown>,
  patch: Record<string, unknown> | undefined,
): Record<string, unknown> {
  const next = { ...current }
  for (const field of fields ?? []) {
    if (!patch || !Object.prototype.hasOwnProperty.call(patch, field.key)) continue
    // 完整表单会带上未填写的 number 项（值为 undefined），跳过以免误判为非法写入
    if (patch[field.key] === undefined) continue
    next[field.key] = coerceSettingValue(field, patch[field.key])
  }
  for (const field of fields ?? []) {
    if (!field.required) continue
    const value = next[field.key]
    if (value === undefined || value === null || value === '') {
      throw new Error(`设置项 ${field.key} 不能为空`)
    }
  }
  return next
}
