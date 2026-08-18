// DBML 导入/导出（移植自 DataModelViewer）

import { Parser } from '@dbml/core'
import {
  createDataModel, createTable, createField, createRelationship, createId,
  type DataModel, type Table, type Field, type Relationship, type FieldType
} from '../shared/domain'

interface DbmlField {
  name: string
  type: string
  pk?: boolean
  unique?: boolean
  not_null?: boolean
  increment?: boolean
  default?: string
  note?: string
}

interface DbmlTable {
  name: string
  schema?: string
  note?: string
  fields: DbmlField[]
}

interface DbmlRef {
  name?: string
  from: { table: string; field: string }
  to: { table: string; field: string }
  from_cardinality?: string
  to_cardinality?: string
}

interface DbmlEnum {
  name: string
  values: { name: string; note?: string }[]
}

function parseDbml(dbml: string): { tables: DbmlTable[]; refs: DbmlRef[]; enums: DbmlEnum[] } {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db: any = Parser.parse(dbml, 'dbml')
  const schemas = db.schemas ?? []
  const tables: DbmlTable[] = []
  const refs: DbmlRef[] = []
  const enums: DbmlEnum[] = []
  for (const schema of schemas) {
    for (const table of schema.tables ?? []) {
      const fields: DbmlField[] = (table.fields ?? []).map((f: any) => ({
        name: f.name,
        type: f.type?.type_name ?? String(f.type ?? 'varchar'),
        pk: f.pk,
        unique: f.unique,
        not_null: f.not_null,
        increment: f.increment,
        default: f.default != null ? String(f.default) : undefined,
        note: f.note?.text
      }))
      tables.push({
        name: table.name,
        schema: schema.name !== 'public' ? schema.name : undefined,
        note: table.note?.text,
        fields
      })
    }
    for (const ref of schema.refs ?? []) {
      refs.push({
        name: ref.name,
        from: { table: ref.endpoints?.[0]?.tableName ?? '', field: ref.endpoints?.[0]?.fieldNames?.[0] ?? '' },
        to: { table: ref.endpoints?.[1]?.tableName ?? '', field: ref.endpoints?.[1]?.fieldNames?.[0] ?? '' },
        from_cardinality: ref.endpoints?.[0]?.relation,
        to_cardinality: ref.endpoints?.[1]?.relation
      })
    }
    for (const enumDef of schema.enums ?? []) {
      enums.push({
        name: enumDef.name,
        values: (enumDef.values ?? []).map((v: any) => ({ name: v.name, note: v.note?.text }))
      })
    }
  }
  return { tables, refs, enums }
}

const DBML_TYPE_MAP: Record<string, FieldType> = {
  int: 'integer', integer: 'integer', bigint: 'bigint', smallint: 'smallint', tinyint: 'tinyint',
  decimal: 'decimal', numeric: 'numeric', real: 'real', double: 'double', float: 'float',
  varchar: 'varchar', char: 'char', text: 'text', string: 'string', json: 'json', jsonb: 'jsonb', xml: 'xml',
  boolean: 'boolean', bool: 'bool', bit: 'bit',
  date: 'date', time: 'time', timestamp: 'timestamp', timestamptz: 'timestamptz', datetime: 'datetime', interval: 'interval',
  uuid: 'uuid', bytea: 'bytea', blob: 'blob', binary: 'binary', enum: 'enum', array: 'array'
}

function mapDbmlType(raw: string): { type: FieldType; length: string | null } {
  const normalized = raw.trim().toLowerCase()
  const m = normalized.match(/^([a-z]+)\s*\((\d+)\)$/)
  if (m) {
    return { type: DBML_TYPE_MAP[m[1]] ?? 'custom', length: m[2] }
  }
  return { type: DBML_TYPE_MAP[normalized] ?? 'custom', length: null }
}

function mapCardinality(raw?: string): 'one' | 'many' {
  if (raw === '1' || raw === 'one') return 'one'
  return 'many'
}

export function importDbml(dbml: string, modelName = 'DBML 导入'): DataModel {
  const parsed = parseDbml(dbml)
  const tableNameToId = new Map<string, string>()
  const fieldKeyToId = new Map<string, string>()
  const tables: Table[] = parsed.tables.map((t) => {
    const tableId = createId('tbl')
    const lowerName = t.name.toLowerCase()
    tableNameToId.set(lowerName, tableId)
    const fields: Field[] = t.fields.map((f) => {
      const { type, length } = mapDbmlType(f.type)
      const field = createField({
        name: f.name, type, typeLength: length,
        primaryKey: f.pk ?? false, unique: f.unique ?? false, nullable: !f.not_null,
        autoIncrement: f.increment ?? false, defaultValue: f.default ?? null, comment: f.note ?? null
      })
      fieldKeyToId.set(`${lowerName}:${f.name.toLowerCase()}`, field.id)
      return field
    })
    return { ...createTable({ name: t.name, schema: t.schema ?? null, comment: t.note ?? null, fields }), id: tableId }
  })
  const relationships: Relationship[] = parsed.refs
    .map((ref) => {
      const sourceTableId = tableNameToId.get(ref.from.table.toLowerCase())
      const targetTableId = tableNameToId.get(ref.to.table.toLowerCase())
      if (!sourceTableId || !targetTableId) return null
      const sourceFieldId = fieldKeyToId.get(`${ref.from.table.toLowerCase()}:${ref.from.field.toLowerCase()}`)
      const targetFieldId = fieldKeyToId.get(`${ref.to.table.toLowerCase()}:${ref.to.field.toLowerCase()}`)
      if (!sourceFieldId || !targetFieldId) return null
      return createRelationship({
        name: ref.name ?? null, sourceTableId, sourceFieldId, targetTableId, targetFieldId,
        sourceCardinality: mapCardinality(ref.from_cardinality), targetCardinality: mapCardinality(ref.to_cardinality)
      })
    })
    .filter((r): r is Relationship => r !== null)
  return createDataModel({ name: modelName, tables, relationships })
}

const FIELD_TYPE_TO_DBML: Record<FieldType, string> = {
  integer: 'integer', bigint: 'bigint', smallint: 'smallint', tinyint: 'tinyint',
  decimal: 'decimal', numeric: 'numeric', real: 'real', double: 'double', float: 'float',
  varchar: 'varchar', char: 'char', text: 'text', string: 'varchar', json: 'json', jsonb: 'jsonb', xml: 'xml',
  boolean: 'boolean', bool: 'boolean', bit: 'bit',
  date: 'date', time: 'time', timestamp: 'timestamp', timestamptz: 'timestamptz', datetime: 'datetime', interval: 'interval',
  uuid: 'uuid', bytea: 'bytea', blob: 'blob', binary: 'binary', enum: 'enum', array: 'array', custom: 'varchar'
}

function formatFieldType(field: Field): string {
  const base = FIELD_TYPE_TO_DBML[field.type] ?? 'varchar'
  if (field.typeLength && (field.type === 'varchar' || field.type === 'char')) {
    return `${base}(${field.typeLength})`
  }
  return base
}

function escapeDbmlString(s: string): string {
  return s.replace(/'/g, "\\'").replace(/\n/g, '\\n')
}

function formatDefault(value: string): string {
  if (/^[a-zA-Z_][a-zA-Z0-9_]*\(\)$/.test(value)) return value
  if (/^-?\d+(\.\d+)?$/.test(value)) return value
  if (value === 'true' || value === 'false') return value
  return `'${escapeDbmlString(value)}'`
}

export function exportDbml(model: DataModel): string {
  const lines: string[] = []
  const projectName = model.name || 'DataModelViewer Export'
  lines.push(`// ${projectName}`)
  lines.push(`// Generated by DataModelViewer at ${new Date().toISOString()}`)
  lines.push('')
  for (const table of model.tables) {
    const fullName = table.schema ? `${table.schema}.${table.name}` : table.name
    lines.push(`Table ${fullName} {`)
    for (const field of table.fields) {
      const parts: string[] = []
      parts.push(`  ${field.name} ${formatFieldType(field)}`)
      const constraints: string[] = []
      if (field.primaryKey) constraints.push('[pk]')
      if (field.unique && !field.primaryKey) constraints.push('[unique]')
      if (!field.nullable && !field.primaryKey) constraints.push('not null')
      if (field.autoIncrement) constraints.push('increment')
      if (field.defaultValue != null) parts.push(`default: ${formatDefault(field.defaultValue)}`)
      if (constraints.length > 0) parts.push(constraints.join(' '))
      lines.push(parts.join(' '))
      if (field.comment) lines.push(`  note: '${escapeDbmlString(field.comment)}'`)
    }
    if (table.comment) lines.push(`  note: '${escapeDbmlString(table.comment)}'`)
    lines.push('}')
    lines.push('')
  }
  for (const rel of model.relationships) {
    const sourceTable = model.tables.find((t) => t.id === rel.sourceTableId)
    const targetTable = model.tables.find((t) => t.id === rel.targetTableId)
    const sourceField = sourceTable?.fields.find((f) => f.id === rel.sourceFieldId)
    const targetField = targetTable?.fields.find((f) => f.id === rel.targetFieldId)
    if (!sourceTable || !targetTable || !sourceField || !targetField) continue
    const src = sourceTable.schema ? `${sourceTable.schema}.${sourceTable.name}` : sourceTable.name
    const tgt = targetTable.schema ? `${targetTable.schema}.${targetTable.name}` : targetTable.name
    const srcCard = rel.sourceCardinality === 'many' ? '*' : '1'
    const tgtCard = rel.targetCardinality === 'many' ? '*' : '1'
    if (rel.name) {
      lines.push(`Ref ${rel.name}: ${src}.${sourceField.name} ${srcCard} - ${tgtCard} ${tgt}.${targetField.name}`)
    } else {
      lines.push(`Ref: ${src}.${sourceField.name} ${srcCard} - ${tgtCard} ${tgt}.${targetField.name}`)
    }
  }
  return lines.join('\n')
}
