// 数据模型领域类型与工厂函数（移植自 DataModelViewer）

export const DatabaseTypes = [
  'generic', 'postgresql', 'mysql', 'mariadb', 'sqlite', 'sqlserver', 'oracle', 'clickhouse'
] as const
export type DatabaseType = (typeof DatabaseTypes)[number]

export const FieldTypes = [
  'integer', 'bigint', 'smallint', 'tinyint',
  'decimal', 'numeric', 'real', 'double', 'float',
  'varchar', 'char', 'text', 'string', 'json', 'jsonb', 'xml',
  'boolean', 'bool', 'bit',
  'date', 'time', 'timestamp', 'timestamptz', 'datetime', 'interval',
  'uuid', 'bytea', 'blob', 'binary',
  'enum', 'array', 'custom'
] as const
export type FieldType = (typeof FieldTypes)[number]

export type Cardinality = 'one' | 'many'
export type RelationshipType = 'one_to_one' | 'one_to_many' | 'many_to_one' | 'many_to_many'
export type IndexType = 'btree' | 'hash' | 'gist' | 'gin' | 'brin' | 'custom'

export interface Field {
  id: string
  name: string
  type: FieldType
  typeLength: string | null
  precision: number | null
  scale: number | null
  primaryKey: boolean
  unique: boolean
  nullable: boolean
  autoIncrement: boolean
  defaultValue: string | null
  comment: string | null
  enumTypeId: string | null
  createdAt: number
}

export interface Table {
  id: string
  name: string
  schema: string | null
  fields: Field[]
  x: number
  y: number
  width: number
  color: string
  comment: string | null
  isView: boolean
  expanded: boolean
  createdAt: number
}

export interface Relationship {
  id: string
  name: string | null
  sourceTableId: string
  sourceFieldId: string
  targetTableId: string
  targetFieldId: string
  sourceCardinality: Cardinality
  targetCardinality: Cardinality
  createdAt: number
}

export interface Index {
  id: string
  name: string
  tableId: string
  fieldIds: string[]
  unique: boolean
  type: IndexType
  createdAt: number
}

export interface EnumValue {
  id: string
  name: string
  comment: string | null
}

export interface EnumType {
  id: string
  name: string
  values: EnumValue[]
  createdAt: number
}

export interface DataModel {
  id: string
  name: string
  databaseType: DatabaseType
  tables: Table[]
  relationships: Relationship[]
  indexes: Index[]
  enums: EnumType[]
  sourceDocumentId: string | null
  createdAt: number
  updatedAt: number
}

export function createId(prefix = ''): string {
  const id = Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4)
  return prefix ? `${prefix}_${id}` : id
}

export function createField(partial: Partial<Field> = {}): Field {
  return {
    id: createId('fld'),
    name: partial.name ?? 'new_field',
    type: partial.type ?? 'varchar',
    typeLength: partial.typeLength ?? null,
    precision: partial.precision ?? null,
    scale: partial.scale ?? null,
    primaryKey: partial.primaryKey ?? false,
    unique: partial.unique ?? false,
    nullable: partial.nullable ?? true,
    autoIncrement: partial.autoIncrement ?? false,
    defaultValue: partial.defaultValue ?? null,
    comment: partial.comment ?? null,
    enumTypeId: partial.enumTypeId ?? null,
    createdAt: Date.now()
  }
}

export function createTable(partial: Partial<Table> = {}): Table {
  return {
    id: createId('tbl'),
    name: partial.name ?? 'new_table',
    schema: partial.schema ?? null,
    fields: partial.fields ?? [
      createField({ name: 'id', type: 'bigint', primaryKey: true, nullable: false, autoIncrement: true })
    ],
    x: partial.x ?? 0,
    y: partial.y ?? 0,
    width: partial.width ?? 260,
    color: partial.color ?? '#71717a',
    comment: partial.comment ?? null,
    isView: partial.isView ?? false,
    expanded: partial.expanded ?? true,
    createdAt: Date.now()
  }
}

export function createRelationship(partial: Partial<Relationship>): Relationship {
  return {
    id: createId('rel'),
    name: partial.name ?? null,
    sourceTableId: partial.sourceTableId ?? '',
    sourceFieldId: partial.sourceFieldId ?? '',
    targetTableId: partial.targetTableId ?? '',
    targetFieldId: partial.targetFieldId ?? '',
    sourceCardinality: partial.sourceCardinality ?? 'one',
    targetCardinality: partial.targetCardinality ?? 'many',
    createdAt: Date.now()
  }
}

export function createEnumType(partial: Partial<EnumType> = {}): EnumType {
  return {
    id: createId('enum'),
    name: partial.name ?? 'new_enum',
    values: partial.values ?? [],
    createdAt: Date.now()
  }
}

export function createDataModel(partial: Partial<DataModel> = {}): DataModel {
  const now = Date.now()
  return {
    id: partial.id ?? createId('dm'),
    name: partial.name ?? '未命名数据模型',
    databaseType: partial.databaseType ?? 'generic',
    tables: partial.tables ?? [],
    relationships: partial.relationships ?? [],
    indexes: partial.indexes ?? [],
    enums: partial.enums ?? [],
    sourceDocumentId: partial.sourceDocumentId ?? null,
    createdAt: partial.createdAt ?? now,
    updatedAt: partial.updatedAt ?? now
  }
}

export function deriveRelationshipType(rel: Relationship): RelationshipType {
  const { sourceCardinality, targetCardinality } = rel
  if (sourceCardinality === 'one' && targetCardinality === 'one') return 'one_to_one'
  if (sourceCardinality === 'one' && targetCardinality === 'many') return 'one_to_many'
  if (sourceCardinality === 'many' && targetCardinality === 'one') return 'many_to_one'
  return 'many_to_many'
}
