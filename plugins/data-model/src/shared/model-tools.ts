// 数据模型操作工具（纯函数，移植自 DataModelViewer）
// 所有工具：不 mutate 入参 model，返回新 model + 结果

import {
  createTable, createField, createRelationship, createEnumType, createDataModel, createId,
  type DataModel, type Table, type Field, type Relationship, type FieldType, type Cardinality
} from './domain'

export interface ToolResult<T = unknown> {
  ok: boolean
  data?: T
  message?: string
  error?: string
}

export interface ToolExecResult<T = unknown> {
  model: DataModel
  result: ToolResult<T>
}

export interface ToolContext {
  parseDbml?: (dbml: string, name?: string) => DataModel
}

export interface ToolDef<A = unknown, R = unknown> {
  name: string
  description: string
  parameters: Record<string, unknown>
  execute: (model: DataModel, args: A, ctx?: ToolContext) => ToolExecResult<R>
}

function ok<T>(data: T, message: string): ToolResult<T> {
  return { ok: true, data, message }
}
function err(error: string): ToolResult {
  return { ok: false, error }
}

// ============ helpers ============

export function findTable(model: DataModel, loc: { tableId?: string; tableName?: string }) {
  if (loc.tableId) return model.tables.find((t) => t.id === loc.tableId)
  if (loc.tableName) {
    const lower = loc.tableName.toLowerCase()
    return model.tables.find((t) => t.name.toLowerCase() === lower)
  }
  return undefined
}

export function findField(table: Table, loc: { fieldId?: string; fieldName?: string }) {
  if (loc.fieldId) return table.fields.find((f) => f.id === loc.fieldId)
  if (loc.fieldName) {
    const lower = loc.fieldName.toLowerCase()
    return table.fields.find((f) => f.name.toLowerCase() === lower)
  }
  return undefined
}

// ============ query tools ============

const listTablesTool: ToolDef = {
  name: 'list_tables',
  description: '列出当前数据模型中的所有表。返回每张表的 id、名称、schema、字段数、注释。用于了解模型现状。',
  parameters: { type: 'object', properties: {} },
  execute: (model) => {
    const data = model.tables.map((t) => ({
      id: t.id, name: t.name, schema: t.schema ?? null,
      fieldsCount: t.fields.length, isView: t.isView, comment: t.comment ?? null
    }))
    return { model, result: ok(data, `当前模型共 ${data.length} 张表`) }
  }
}

const getTableTool: ToolDef = {
  name: 'get_table',
  description: '按 id 或名称获取表的完整定义（含所有字段的类型、约束、注释）。创建关系或加字段前可用此工具确认字段名。',
  parameters: {
    type: 'object',
    properties: {
      tableId: { type: 'string', description: '表 id（优先）' },
      tableName: { type: 'string', description: '表名（tableId 为空时按名称匹配，不区分大小写）' }
    }
  },
  execute: (model, args: any) => {
    const table = findTable(model, args)
    if (!table) return { model, result: err(`未找到表: ${args.tableName ?? args.tableId}`) }
    return {
      model,
      result: ok({
        id: table.id, name: table.name, schema: table.schema ?? null, isView: table.isView,
        comment: table.comment ?? null, color: table.color,
        fields: table.fields.map((f) => ({
          id: f.id, name: f.name, type: f.type, typeLength: f.typeLength ?? null,
          primaryKey: f.primaryKey, unique: f.unique, nullable: f.nullable,
          autoIncrement: f.autoIncrement, defaultValue: f.defaultValue ?? null, comment: f.comment ?? null
        }))
      }, `表 ${table.name} 共 ${table.fields.length} 个字段`)
    }
  }
}

const getModelSummaryTool: ToolDef = {
  name: 'get_model_summary',
  description: '获取当前数据模型的整体概览：表数、关系数、枚举数，以及表名清单与关系清单。开始建模前先调用以了解现状。',
  parameters: { type: 'object', properties: {} },
  execute: (model) => {
    const data = {
      name: model.name, databaseType: model.databaseType,
      tablesCount: model.tables.length, relationshipsCount: model.relationships.length, enumsCount: model.enums.length,
      tables: model.tables.map((t) => ({ id: t.id, name: t.name, fieldsCount: t.fields.length })),
      relationships: model.relationships.map((r) => {
        const st = model.tables.find((t) => t.id === r.sourceTableId)
        const tt = model.tables.find((t) => t.id === r.targetTableId)
        const sf = st?.fields.find((f) => f.id === r.sourceFieldId)
        const tf = tt?.fields.find((f) => f.id === r.targetFieldId)
        return {
          id: r.id,
          source: st ? `${st.name}.${sf?.name ?? '?'}` : '?',
          target: tt ? `${tt.name}.${tf?.name ?? '?'}` : '?',
          sourceCardinality: r.sourceCardinality, targetCardinality: r.targetCardinality
        }
      })
    }
    return { model, result: ok(data, `模型概览: ${data.tablesCount} 表 / ${data.relationshipsCount} 关系`) }
  }
}

const listRelationshipsTool: ToolDef = {
  name: 'list_relationships',
  description: '列出当前模型中所有关系（外键边），含源表/目标表名与字段、基数。',
  parameters: { type: 'object', properties: {} },
  execute: (model) => {
    const data = model.relationships.map((r) => {
      const st = model.tables.find((t) => t.id === r.sourceTableId)
      const tt = model.tables.find((t) => t.id === r.targetTableId)
      const sf = st?.fields.find((f) => f.id === r.sourceFieldId)
      const tf = tt?.fields.find((f) => f.id === r.targetFieldId)
      return {
        id: r.id, name: r.name ?? null,
        sourceTable: st?.name ?? '?', sourceField: sf?.name ?? '?',
        targetTable: tt?.name ?? '?', targetField: tf?.name ?? '?',
        sourceCardinality: r.sourceCardinality, targetCardinality: r.targetCardinality
      }
    })
    return { model, result: ok(data, `当前模型共 ${data.length} 条关系`) }
  }
}

const listEnumsTool: ToolDef = {
  name: 'list_enums',
  description: '列出当前模型中所有枚举类型及其取值。',
  parameters: { type: 'object', properties: {} },
  execute: (model) => {
    const data = model.enums.map((e) => ({
      id: e.id, name: e.name,
      values: e.values.map((v) => ({ id: v.id, name: v.name, comment: v.comment ?? null }))
    }))
    return { model, result: ok(data, `当前模型共 ${data.length} 个枚举`) }
  }
}

// ============ table tools ============

const createTableTool: ToolDef = {
  name: 'create_table',
  description: '创建一张新表。可一次性指定字段列表；若不提供字段，会自动创建 id(bigint, 主键, 自增) 字段。表名不能与现有表重复（不区分大小写）。',
  parameters: {
    type: 'object',
    properties: {
      name: { type: 'string', description: '表名' },
      schema: { type: ['string', 'null'], description: 'schema 名（可省略）' },
      fields: {
        type: 'array', description: '字段列表。为空时自动创建 id 主键字段',
        items: {
          type: 'object',
          properties: {
            name: { type: 'string' }, type: { type: 'string' }, typeLength: { type: ['string', 'null'] },
            primaryKey: { type: 'boolean' }, unique: { type: 'boolean' }, nullable: { type: 'boolean' },
            autoIncrement: { type: 'boolean' }, defaultValue: { type: ['string', 'null'] }, comment: { type: ['string', 'null'] }
          }
        }
      },
      comment: { type: ['string', 'null'], description: '表注释' },
      color: { type: 'string', description: '表头颜色（十六进制）' },
      isView: { type: 'boolean', description: '是否为视图' }
    },
    required: ['name']
  },
  execute: (model, args: any) => {
    const lowerName = args.name.toLowerCase()
    if (model.tables.some((t) => t.name.toLowerCase() === lowerName)) {
      return { model, result: err(`表已存在: ${args.name}`) }
    }
    const fieldInputs = args.fields && args.fields.length > 0
      ? args.fields
      : [{ name: 'id', type: 'bigint', primaryKey: true, nullable: false, autoIncrement: true }]
    const fields = fieldInputs.map((f: any) =>
      createField({
        name: f.name, type: f.type, typeLength: f.typeLength ?? null,
        primaryKey: f.primaryKey ?? false, unique: f.unique ?? false, nullable: f.nullable ?? true,
        autoIncrement: f.autoIncrement ?? false, defaultValue: f.defaultValue ?? null, comment: f.comment ?? null
      })
    )
    const table: Table = {
      ...createTable({ name: args.name, schema: args.schema ?? null, comment: args.comment ?? null, color: args.color, isView: args.isView, fields })
    }
    table.x = 80 + (model.tables.length % 8) * 40
    table.y = 80 + (model.tables.length % 8) * 40
    const newModel: DataModel = { ...model, tables: [...model.tables, table], updatedAt: Date.now() }
    return {
      model: newModel,
      result: ok({ tableId: table.id, name: table.name, fieldsCount: table.fields.length }, `已创建表 ${table.name}（${table.fields.length} 个字段）`)
    }
  }
}

const updateTableTool: ToolDef = {
  name: 'update_table',
  description: '修改表的属性（名称、schema、注释、颜色、是否视图、是否展开）。不会改动字段。',
  parameters: {
    type: 'object',
    properties: {
      table: {
        type: 'object', description: '要修改的表',
        properties: { tableId: { type: 'string' }, tableName: { type: 'string' } }
      },
      name: { type: 'string', description: '新表名' },
      schema: { type: ['string', 'null'], description: '新 schema' },
      comment: { type: ['string', 'null'], description: '新注释' },
      color: { type: 'string', description: '新颜色' },
      isView: { type: 'boolean', description: '是否视图' },
      expanded: { type: 'boolean', description: '画布上是否展开' }
    },
    required: ['table']
  },
  execute: (model, args: any) => {
    const table = findTable(model, args.table)
    if (!table) return { model, result: err(`未找到表: ${args.table.tableName ?? args.table.tableId}`) }
    if (args.name && args.name.toLowerCase() !== table.name.toLowerCase()) {
      if (model.tables.some((t) => t.id !== table.id && t.name.toLowerCase() === args.name.toLowerCase())) {
        return { model, result: err(`表名已存在: ${args.name}`) }
      }
    }
    const updated: Table = {
      ...table,
      ...(args.name !== undefined ? { name: args.name } : {}),
      ...(args.schema !== undefined ? { schema: args.schema } : {}),
      ...(args.comment !== undefined ? { comment: args.comment } : {}),
      ...(args.color !== undefined ? { color: args.color } : {}),
      ...(args.isView !== undefined ? { isView: args.isView } : {}),
      ...(args.expanded !== undefined ? { expanded: args.expanded } : {})
    }
    const newModel: DataModel = { ...model, tables: model.tables.map((t) => (t.id === table.id ? updated : t)), updatedAt: Date.now() }
    return { model: newModel, result: ok({ tableId: updated.id, name: updated.name }, `已更新表 ${updated.name}`) }
  }
}

const deleteTableTool: ToolDef = {
  name: 'delete_table',
  description: '删除一张表，同时级联删除引用该表的所有关系。删除不可撤销，请谨慎。',
  parameters: {
    type: 'object',
    properties: {
      table: {
        type: 'object', description: '要删除的表',
        properties: { tableId: { type: 'string' }, tableName: { type: 'string' } }
      }
    },
    required: ['table']
  },
  execute: (model, args: any) => {
    const table = findTable(model, args.table)
    if (!table) return { model, result: err(`未找到表: ${args.table.tableName ?? args.table.tableId}`) }
    const removedRels = model.relationships.filter((r) => r.sourceTableId === table.id || r.targetTableId === table.id).length
    const newModel: DataModel = {
      ...model,
      tables: model.tables.filter((t) => t.id !== table.id),
      relationships: model.relationships.filter((r) => r.sourceTableId !== table.id && r.targetTableId !== table.id),
      indexes: model.indexes.filter((i) => i.tableId !== table.id),
      updatedAt: Date.now()
    }
    return { model: newModel, result: ok({ deletedTable: table.name, cascadedRelationships: removedRels }, `已删除表 ${table.name}（级联删除 ${removedRels} 条关系）`) }
  }
}

// ============ field tools ============

const addFieldTool: ToolDef = {
  name: 'add_field',
  description: '向指定表添加一个字段。字段名不能与该表已有字段重复（不区分大小写）。',
  parameters: {
    type: 'object',
    properties: {
      table: {
        type: 'object', description: '目标表',
        properties: { tableId: { type: 'string' }, tableName: { type: 'string' } }
      },
      field: {
        type: 'object', description: '要新增的字段',
        properties: {
          name: { type: 'string' }, type: { type: 'string' }, typeLength: { type: ['string', 'null'] },
          primaryKey: { type: 'boolean' }, unique: { type: 'boolean' }, nullable: { type: 'boolean' },
          autoIncrement: { type: 'boolean' }, defaultValue: { type: ['string', 'null'] }, comment: { type: ['string', 'null'] }
        }
      }
    },
    required: ['table', 'field']
  },
  execute: (model, args: any) => {
    const table = findTable(model, args.table)
    if (!table) return { model, result: err(`未找到表: ${args.table.tableName ?? args.table.tableId}`) }
    const lowerName = args.field.name.toLowerCase()
    if (table.fields.some((f) => f.name.toLowerCase() === lowerName)) {
      return { model, result: err(`字段已存在: ${table.name}.${args.field.name}`) }
    }
    const field = createField({
      name: args.field.name, type: args.field.type, typeLength: args.field.typeLength ?? null,
      primaryKey: args.field.primaryKey ?? false, unique: args.field.unique ?? false, nullable: args.field.nullable ?? true,
      autoIncrement: args.field.autoIncrement ?? false, defaultValue: args.field.defaultValue ?? null, comment: args.field.comment ?? null
    })
    const newModel: DataModel = {
      ...model,
      tables: model.tables.map((t) => (t.id === table.id ? { ...t, fields: [...t.fields, field] } : t)),
      updatedAt: Date.now()
    }
    return { model: newModel, result: ok({ tableId: table.id, tableName: table.name, fieldId: field.id, fieldName: field.name }, `已在表 ${table.name} 添加字段 ${field.name} (${field.type})`) }
  }
}

const updateFieldTool: ToolDef = {
  name: 'update_field',
  description: '修改指定字段的属性（类型、约束、注释等）。仅需提供要变更的字段。',
  parameters: {
    type: 'object',
    properties: {
      locator: {
        type: 'object', description: '表 + 字段定位',
        properties: {
          tableId: { type: 'string' }, tableName: { type: 'string' },
          fieldId: { type: 'string' }, fieldName: { type: 'string' }
        }
      },
      patch: {
        type: 'object', description: '要修改的字段属性',
        properties: {
          name: { type: 'string' }, type: { type: 'string' }, typeLength: { type: ['string', 'null'] },
          primaryKey: { type: 'boolean' }, unique: { type: 'boolean' }, nullable: { type: 'boolean' },
          autoIncrement: { type: 'boolean' }, defaultValue: { type: ['string', 'null'] }, comment: { type: ['string', 'null'] }
        }
      }
    },
    required: ['locator', 'patch']
  },
  execute: (model, args: any) => {
    const table = findTable(model, args.locator)
    if (!table) return { model, result: err(`未找到表: ${args.locator.tableName ?? args.locator.tableId}`) }
    const field = findField(table, args.locator)
    if (!field) return { model, result: err(`未找到字段: ${table.name}.${args.locator.fieldName ?? args.locator.fieldId}`) }
    if (args.patch.name && args.patch.name.toLowerCase() !== field.name.toLowerCase()) {
      if (table.fields.some((f) => f.id !== field.id && f.name.toLowerCase() === args.patch.name.toLowerCase())) {
        return { model, result: err(`字段名已存在: ${table.name}.${args.patch.name}`) }
      }
    }
    const updated = { ...field, ...args.patch }
    const newModel: DataModel = {
      ...model,
      tables: model.tables.map((t) => (t.id === table.id ? { ...t, fields: t.fields.map((f) => (f.id === field.id ? updated : f)) } : t)),
      updatedAt: Date.now()
    }
    return { model: newModel, result: ok({ tableId: table.id, fieldName: updated.name, type: updated.type }, `已更新字段 ${table.name}.${updated.name}`) }
  }
}

const deleteFieldTool: ToolDef = {
  name: 'delete_field',
  description: '删除指定字段，同时级联删除引用该字段的所有关系。',
  parameters: {
    type: 'object',
    properties: {
      locator: {
        type: 'object', description: '表 + 字段定位',
        properties: {
          tableId: { type: 'string' }, tableName: { type: 'string' },
          fieldId: { type: 'string' }, fieldName: { type: 'string' }
        }
      }
    },
    required: ['locator']
  },
  execute: (model, args: any) => {
    const table = findTable(model, args.locator)
    if (!table) return { model, result: err(`未找到表: ${args.locator.tableName ?? args.locator.tableId}`) }
    const field = findField(table, args.locator)
    if (!field) return { model, result: err(`未找到字段: ${table.name}.${args.locator.fieldName ?? args.locator.fieldId}`) }
    const removedRels = model.relationships.filter((r) => r.sourceFieldId === field.id || r.targetFieldId === field.id).length
    const newModel: DataModel = {
      ...model,
      tables: model.tables.map((t) => (t.id === table.id ? { ...t, fields: t.fields.filter((f) => f.id !== field.id) } : t)),
      relationships: model.relationships.filter((r) => r.sourceFieldId !== field.id && r.targetFieldId !== field.id),
      indexes: model.indexes.map((i) => ({ ...i, fieldIds: i.fieldIds.filter((id) => id !== field.id) })).filter((i) => i.fieldIds.length > 0),
      updatedAt: Date.now()
    }
    return { model: newModel, result: ok({ deletedField: `${table.name}.${field.name}`, cascadedRelationships: removedRels }, `已删除字段 ${table.name}.${field.name}（级联删除 ${removedRels} 条关系）`) }
  }
}

// ============ relationship tools ============

const createRelationshipTool: ToolDef = {
  name: 'create_relationship',
  description: '在两张表的字段间创建关系（外键边）。通过表名+字段名定位（不区分大小写）。典型用法：一对多 sourceCardinality=one, targetCardinality=many。重复关系（相同四元组）会被拒绝。',
  parameters: {
    type: 'object',
    properties: {
      sourceTable: { type: 'string', description: '源表名' },
      sourceField: { type: 'string', description: '源表字段名' },
      targetTable: { type: 'string', description: '目标表名' },
      targetField: { type: 'string', description: '目标表字段名' },
      sourceCardinality: { type: 'string', enum: ['one', 'many'], description: '源端基数，默认 one' },
      targetCardinality: { type: 'string', enum: ['one', 'many'], description: '目标端基数，默认 many' },
      name: { type: ['string', 'null'], description: '关系名（可省略）' }
    },
    required: ['sourceTable', 'sourceField', 'targetTable', 'targetField']
  },
  execute: (model, args: any) => {
    const sTable = model.tables.find((t) => t.name.toLowerCase() === args.sourceTable.toLowerCase())
    const tTable = model.tables.find((t) => t.name.toLowerCase() === args.targetTable.toLowerCase())
    if (!sTable) return { model, result: err(`未找到源表: ${args.sourceTable}`) }
    if (!tTable) return { model, result: err(`未找到目标表: ${args.targetTable}`) }
    const sField = sTable.fields.find((f) => f.name.toLowerCase() === args.sourceField.toLowerCase())
    const tField = tTable.fields.find((f) => f.name.toLowerCase() === args.targetField.toLowerCase())
    if (!sField) return { model, result: err(`未找到源字段: ${sTable.name}.${args.sourceField}`) }
    if (!tField) return { model, result: err(`未找到目标字段: ${tTable.name}.${args.targetField}`) }
    const key = `${sTable.id}:${sField.id}:${tTable.id}:${tField.id}`
    if (model.relationships.some((r) => `${r.sourceTableId}:${r.sourceFieldId}:${r.targetTableId}:${r.targetFieldId}` === key)) {
      return { model, result: err(`关系已存在: ${sTable.name}.${sField.name} → ${tTable.name}.${tField.name}`) }
    }
    const rel: Relationship = createRelationship({
      name: args.name ?? null,
      sourceTableId: sTable.id, sourceFieldId: sField.id,
      targetTableId: tTable.id, targetFieldId: tField.id,
      sourceCardinality: (args.sourceCardinality as Cardinality) ?? 'one',
      targetCardinality: (args.targetCardinality as Cardinality) ?? 'many'
    })
    const newModel: DataModel = { ...model, relationships: [...model.relationships, rel], updatedAt: Date.now() }
    return {
      model: newModel,
      result: ok({
        relationshipId: rel.id,
        source: `${sTable.name}.${sField.name}`,
        target: `${tTable.name}.${tField.name}`,
        type: `${rel.sourceCardinality}_to_${rel.targetCardinality}`
      }, `已创建关系 ${sTable.name}.${sField.name} (${rel.sourceCardinality}) → ${tTable.name}.${tField.name} (${rel.targetCardinality})`)
    }
  }
}

const deleteRelationshipTool: ToolDef = {
  name: 'delete_relationship',
  description: '删除一条关系。可通过 relationshipId，或通过源/目标表+字段定位。',
  parameters: {
    type: 'object',
    properties: {
      relationshipId: { type: 'string', description: '关系 id（优先）' },
      sourceTable: { type: 'string' }, sourceField: { type: 'string' },
      targetTable: { type: 'string' }, targetField: { type: 'string' }
    }
  },
  execute: (model, args: any) => {
    let target: Relationship | undefined
    if (args.relationshipId) {
      target = model.relationships.find((r) => r.id === args.relationshipId)
    } else {
      if (!args.sourceTable || !args.sourceField || !args.targetTable || !args.targetField) {
        return { model, result: err('需提供 relationshipId，或同时提供源/目标表与字段') }
      }
      const sTable = model.tables.find((t) => t.name.toLowerCase() === args.sourceTable.toLowerCase())
      const tTable = model.tables.find((t) => t.name.toLowerCase() === args.targetTable.toLowerCase())
      const sField = sTable?.fields.find((f) => f.name.toLowerCase() === args.sourceField.toLowerCase())
      const tField = tTable?.fields.find((f) => f.name.toLowerCase() === args.targetField.toLowerCase())
      if (!sTable || !tTable || !sField || !tField) {
        return { model, result: err('未找到对应的关系（表或字段不存在）') }
      }
      target = model.relationships.find(
        (r) => r.sourceTableId === sTable.id && r.sourceFieldId === sField.id && r.targetTableId === tTable.id && r.targetFieldId === tField.id
      )
    }
    if (!target) return { model, result: err('未找到匹配的关系') }
    const st = model.tables.find((t) => t.id === target.sourceTableId)
    const tt = model.tables.find((t) => t.id === target.targetTableId)
    const sf = st?.fields.find((f) => f.id === target.sourceFieldId)
    const tf = tt?.fields.find((f) => f.id === target.targetFieldId)
    const newModel: DataModel = { ...model, relationships: model.relationships.filter((r) => r.id !== target.id), updatedAt: Date.now() }
    return { model: newModel, result: ok({ deletedId: target.id }, `已删除关系 ${st?.name ?? '?'}.${sf?.name ?? '?'} → ${tt?.name ?? '?'}.${tf?.name ?? '?'}`) }
  }
}

// ============ enum tools ============

const createEnumTool: ToolDef = {
  name: 'create_enum',
  description: '创建一个枚举类型（含取值列表）。枚举名不能与已有枚举重复（不区分大小写）。',
  parameters: {
    type: 'object',
    properties: {
      name: { type: 'string', description: '枚举类型名' },
      values: {
        type: 'array', description: '枚举取值列表',
        items: { type: 'object', properties: { name: { type: 'string' }, comment: { type: ['string', 'null'] } } }
      }
    },
    required: ['name', 'values']
  },
  execute: (model, args: any) => {
    const lowerName = args.name.toLowerCase()
    if (model.enums.some((e) => e.name.toLowerCase() === lowerName)) {
      return { model, result: err(`枚举已存在: ${args.name}`) }
    }
    const enumType = createEnumType({
      name: args.name,
      values: args.values.map((v: any) => ({ id: createId(), name: v.name, comment: v.comment ?? null }))
    })
    const newModel: DataModel = { ...model, enums: [...model.enums, enumType], updatedAt: Date.now() }
    return { model: newModel, result: ok({ enumId: enumType.id, name: enumType.name, valuesCount: enumType.values.length }, `已创建枚举 ${enumType.name}（${enumType.values.length} 个取值）`) }
  }
}

const deleteEnumTool: ToolDef = {
  name: 'delete_enum',
  description: '删除一个枚举类型。不会自动清理引用该枚举的字段（其 enumTypeId 会保留为旧值）。',
  parameters: {
    type: 'object',
    properties: {
      enumId: { type: 'string', description: '枚举 id（优先）' },
      name: { type: 'string', description: '枚举名（enumId 为空时按名称匹配）' }
    }
  },
  execute: (model, args: any) => {
    const target = args.enumId
      ? model.enums.find((e) => e.id === args.enumId)
      : model.enums.find((e) => e.name.toLowerCase() === (args.name ?? '').toLowerCase())
    if (!target) return { model, result: err(`未找到枚举: ${args.name ?? args.enumId}`) }
    const newModel: DataModel = { ...model, enums: model.enums.filter((e) => e.id !== target.id), updatedAt: Date.now() }
    return { model: newModel, result: ok({ deletedId: target.id, name: target.name }, `已删除枚举 ${target.name}`) }
  }
}

// ============ dbml tools ============

const importDbmlTool: ToolDef = {
  name: 'import_dbml',
  description: '将一段 DBML 文本解析并并入当前数据模型。适合用户提供了既有 DBML/SQL DDL 时快速导入。默认 merge 模式按表名去重追加；可选 replace 模式整体替换。',
  parameters: {
    type: 'object',
    properties: {
      dbml: { type: 'string', description: 'DBML 格式的 schema 文本' },
      mode: { type: 'string', enum: ['merge', 'replace'], description: 'merge=并入，replace=替换。默认 merge' }
    },
    required: ['dbml']
  },
  execute: (model, args: any, ctx) => {
    if (!ctx?.parseDbml) return { model, result: err('DBML 解析器未注入（仅主进程可用）') }
    let imported: DataModel
    try {
      imported = ctx.parseDbml(args.dbml, 'DBML 导入片段')
    } catch (e) {
      return { model, result: err(`DBML 解析失败: ${e instanceof Error ? e.message : String(e)}`) }
    }
    const mode = args.mode ?? 'merge'
    if (mode === 'replace') {
      const replaced: DataModel = { ...imported, id: model.id, name: model.name, updatedAt: Date.now() }
      return { model: replaced, result: ok({ mode, tables: replaced.tables.length, relationships: replaced.relationships.length }, `已用 DBML 替换模型：${replaced.tables.length} 表 / ${replaced.relationships.length} 关系`) }
    }
    return mergeDbml(model, imported)
  }
}

function mergeDbml(model: DataModel, imported: DataModel): ToolExecResult {
  const existingNames = new Set(model.tables.map((t) => t.name.toLowerCase()))
  const newTables = imported.tables.filter((t) => !existingNames.has(t.name.toLowerCase()))
  const allTables = [...model.tables, ...newTables]
  const importedTableIdToName = new Map(imported.tables.map((t) => [t.id, t.name.toLowerCase()]))
  const importedFieldIdToName = new Map<string, string>()
  for (const t of imported.tables) {
    for (const f of t.fields) importedFieldIdToName.set(`${t.id}:${f.id}`, f.name.toLowerCase())
  }
  const existingRelKeys = new Set(model.relationships.map((r) => `${r.sourceTableId}:${r.sourceFieldId}:${r.targetTableId}:${r.targetFieldId}`))
  const newRels = imported.relationships
    .map((rel) => {
      const sName = importedTableIdToName.get(rel.sourceTableId)
      const tName = importedTableIdToName.get(rel.targetTableId)
      if (!sName || !tName) return null
      const sFieldName = importedFieldIdToName.get(`${rel.sourceTableId}:${rel.sourceFieldId}`)
      const tFieldName = importedFieldIdToName.get(`${rel.targetTableId}:${rel.targetFieldId}`)
      if (!sFieldName || !tFieldName) return null
      const sTable = allTables.find((t) => t.name.toLowerCase() === sName)
      const tTable = allTables.find((t) => t.name.toLowerCase() === tName)
      if (!sTable || !tTable) return null
      const sf = sTable.fields.find((f) => f.name.toLowerCase() === sFieldName)
      const tf = tTable.fields.find((f) => f.name.toLowerCase() === tFieldName)
      if (!sf || !tf) return null
      const key = `${sTable.id}:${sf.id}:${tTable.id}:${tf.id}`
      if (existingRelKeys.has(key)) return null
      existingRelKeys.add(key)
      return { ...rel, id: createId('rel'), sourceTableId: sTable.id, sourceFieldId: sf.id, targetTableId: tTable.id, targetFieldId: tf.id }
    })
    .filter((r): r is NonNullable<typeof r> => r !== null)
  const merged: DataModel = { ...model, tables: allTables, relationships: [...model.relationships, ...newRels], updatedAt: Date.now() }
  return { model: merged, result: ok({ mode: 'merge', addedTables: newTables.length, addedRelationships: newRels.length, totalTables: merged.tables.length }, `DBML 并入完成：新增 ${newTables.length} 表 / ${newRels.length} 关系（共 ${merged.tables.length} 表）`) }
}

// ============ misc tools ============

const clearModelTool: ToolDef = {
  name: 'clear_model',
  description: '清空当前数据模型的全部表、关系、索引、枚举。仅在用户明确要求"全部重来"时使用。必须传 confirm=true 才会执行。不会删除项目文件本身。',
  parameters: {
    type: 'object',
    properties: { confirm: { type: 'boolean', const: true, description: '必须显式传 true 才会执行清空' } },
    required: ['confirm']
  },
  execute: (model, args: any) => {
    if (!args.confirm) return { model, result: err('未确认（需 confirm=true）') }
    const cleared: DataModel = { ...model, tables: [], relationships: [], indexes: [], enums: [], updatedAt: Date.now() }
    return { model: cleared, result: ok({ cleared: true }, '已清空当前数据模型') }
  }
}

const createBlankProjectTool: ToolDef = {
  name: 'create_blank_project',
  description: '创建一个全新的空白数据模型项目，替换当前画布上的所有内容。适用于用户说"新建项目"、"清空重来并新建"、"从头开始建模"等场景。注意：本工具会丢弃当前模型的所有表与关系；如需保留当前内容请在调用前提示用户先保存。调用后画布会变为空白，可继续用 create_table 等工具逐步建模。',
  parameters: {
    type: 'object',
    properties: {
      name: { type: 'string', description: '项目名称（可省略）' },
      databaseType: { type: 'string', enum: ['generic', 'postgresql', 'mysql', 'mariadb', 'sqlite', 'sqlserver', 'oracle', 'clickhouse'], description: '数据库类型，默认 generic' }
    }
  },
  execute: (_model, args: any) => {
    const dbType = (args.databaseType as DataModel['databaseType'] | undefined) ?? 'generic'
    const newModel = createDataModel({ name: args.name ?? '未命名数据模型', databaseType: dbType })
    return { model: newModel, result: ok({ modelId: newModel.id, name: newModel.name, databaseType: newModel.databaseType }, `已创建空白项目「${newModel.name}」`) }
  }
}

// ============ registry ============

export const MODEL_TOOLS: ToolDef[] = [
  listTablesTool, getTableTool, getModelSummaryTool, listRelationshipsTool, listEnumsTool,
  createTableTool, updateTableTool, deleteTableTool,
  addFieldTool, updateFieldTool, deleteFieldTool,
  createRelationshipTool, deleteRelationshipTool,
  createEnumTool, deleteEnumTool,
  importDbmlTool,
  clearModelTool, createBlankProjectTool
]

export function getToolByName(name: string): ToolDef | undefined {
  return MODEL_TOOLS.find((t) => t.name === name)
}

/** 允许无模型时调用的工具（用于初始化项目） */
export const NO_MODEL_REQUIRED_TOOLS = new Set(['create_blank_project'])

/** 会用全新 DataModel 替换当前模型（id 变化）的工具 */
export const PROJECT_REPLACING_TOOLS = new Set(['create_blank_project'])
