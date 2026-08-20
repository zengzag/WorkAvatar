// 数据模型操作工具（纯函数）
// 分层协议设计（生产可用）：
// - 读取分层：get_model_meta（轻量元信息，避免大模型全量读取）→ get_model_json（完整结构化 JSON，含布局/索引/枚举引用）
// - 写入：set_model_json（完整 JSON 替换/合并）、import_dbml / import_dbml_file（DBML 兼容输入）
// - 文件层：export_model_file / import_model_file（超大模型经文件读写，避免 IPC 传输过大）
// 结构化 JSON 是数据模型与 AI 之间的完整交换格式，能表达 DBML 无法承载的布局、索引、枚举引用等。

import {
  createId, createField, createTable, createRelationship, createEnumType,
  type DataModel, type Table, type Field, type Relationship, type EnumType, type Index, type Cardinality
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
  readFile?: (path: string) => string
  writeFile?: (path: string, content: string) => void
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

/**
 * 归一化外部传入的模型 JSON：确保每个表/字段/关系/枚举/索引都有唯一 id。
 * LLM 生成的 JSON 常省略 id（仅 name/fields），缺失 id 会导致 React Flow
 * 节点无法定位（"Handle: No node id found"）与关系引用失效。
 */
function normalizeModel(raw: any): DataModel {
  const used = new Set<string>()
  const uniqueId = (prefix: string, existing?: string): string => {
    let id = existing && !used.has(existing) ? existing : createId(prefix)
    while (used.has(id)) id = createId(prefix)
    used.add(id)
    return id
  }

  const tables: Table[] = (Array.isArray(raw?.tables) ? raw.tables : []).map((t: any) => {
    const tableId = uniqueId('tbl', t?.id)
    const fields: Field[] = (Array.isArray(t?.fields) ? t.fields : []).map((f: any) => ({
      id: uniqueId('fld', f?.id),
      name: f?.name ?? 'new_field',
      type: f?.type ?? 'varchar',
      typeLength: f?.typeLength ?? null,
      precision: f?.precision ?? null,
      scale: f?.scale ?? null,
      primaryKey: !!f?.primaryKey,
      unique: !!f?.unique,
      nullable: f?.nullable ?? true,
      autoIncrement: !!f?.autoIncrement,
      defaultValue: f?.defaultValue ?? null,
      comment: f?.comment ?? null,
      enumTypeId: f?.enumTypeId ?? null,
      createdAt: f?.createdAt ?? Date.now()
    }))
    return {
      id: tableId,
      name: t?.name ?? 'new_table',
      schema: t?.schema ?? null,
      fields,
      x: t?.x ?? 0,
      y: t?.y ?? 0,
      width: t?.width ?? 260,
      color: t?.color ?? '#71717a',
      comment: t?.comment ?? null,
      isView: !!t?.isView,
      expanded: t?.expanded ?? true,
      createdAt: t?.createdAt ?? Date.now()
    }
  })

  const relationships: Relationship[] = (Array.isArray(raw?.relationships) ? raw.relationships : []).map((r: any) => {
    const sTable = tables.find((t) => t.id === r?.sourceTableId || t.name.toLowerCase() === (r?.sourceTableName ?? '').toLowerCase())
    const tTable = tables.find((t) => t.id === r?.targetTableId || t.name.toLowerCase() === (r?.targetTableName ?? '').toLowerCase())
    const sf = sTable?.fields.find((f) => f.id === r?.sourceFieldId || f.name.toLowerCase() === (r?.sourceFieldName ?? '').toLowerCase())
    const tf = tTable?.fields.find((f) => f.id === r?.targetFieldId || f.name.toLowerCase() === (r?.targetFieldName ?? '').toLowerCase())
    return {
      id: uniqueId('rel', r?.id),
      name: r?.name ?? null,
      sourceTableId: sTable?.id ?? '',
      sourceFieldId: sf?.id ?? '',
      targetTableId: tTable?.id ?? '',
      targetFieldId: tf?.id ?? '',
      sourceCardinality: (r?.sourceCardinality === 'many' ? 'many' : 'one') as Cardinality,
      targetCardinality: (r?.targetCardinality === 'many' ? 'many' : 'one') as Cardinality,
      createdAt: r?.createdAt ?? Date.now()
    }
  })

  const enums: EnumType[] = (Array.isArray(raw?.enums) ? raw.enums : []).map((e: any) => ({
    id: uniqueId('enum', e?.id),
    name: e?.name ?? 'new_enum',
    values: (Array.isArray(e?.values) ? e.values : []).map((v: any) => ({
      id: uniqueId('enumv', v?.id),
      name: v?.name ?? '',
      comment: v?.comment ?? null
    })),
    createdAt: e?.createdAt ?? Date.now()
  }))

  const indexes: Index[] = (Array.isArray(raw?.indexes) ? raw.indexes : []).map((ix: any) => {
    const table = tables.find((t) => t.id === ix?.tableId || t.name.toLowerCase() === (ix?.tableName ?? '').toLowerCase())
    const fieldIds = (Array.isArray(ix?.fieldIds) ? ix.fieldIds : [])
      .map((fid: string) => {
        const f = table?.fields.find((f) => f.id === fid || f.name.toLowerCase() === String(fid).toLowerCase())
        return f?.id
      })
      .filter((id: string | undefined): id is string => !!id)
    return {
      id: uniqueId('idx', ix?.id),
      name: ix?.name ?? '',
      tableId: table?.id ?? '',
      fieldIds,
      unique: !!ix?.unique,
      type: ix?.type ?? 'btree',
      createdAt: ix?.createdAt ?? Date.now()
    }
  })

  return {
    id: raw?.id ?? createId('dm'),
    name: raw?.name ?? '未命名数据模型',
    databaseType: raw?.databaseType ?? 'generic',
    tables,
    relationships,
    indexes,
    enums,
    sourceDocumentId: raw?.sourceDocumentId ?? null,
    createdAt: raw?.createdAt ?? Date.now(),
    updatedAt: Date.now()
  }
}

// ============ 读取：轻量元信息 ============

const getModelMetaTool: ToolDef = {
  name: 'get_model_meta',
  description: '获取当前数据模型的轻量元信息概览：表数、关系数、枚举数、索引数，以及表名清单（含字段数）、关系清单、枚举清单。不含字段细节，适合大模型快速了解模型现状，避免直接读取全量数据。',
  parameters: { type: 'object', properties: {} },
  execute: (model) => {
    const data = {
      name: model.name,
      databaseType: model.databaseType,
      tablesCount: model.tables.length,
      relationshipsCount: model.relationships.length,
      enumsCount: model.enums.length,
      indexesCount: model.indexes.length,
      tables: model.tables.map((t) => ({
        id: t.id, name: t.name, schema: t.schema ?? null,
        fieldsCount: t.fields.length, isView: t.isView, comment: t.comment ?? null
      })),
      relationships: model.relationships.map((r) => {
        const st = model.tables.find((t) => t.id === r.sourceTableId)
        const tt = model.tables.find((t) => t.id === r.targetTableId)
        const sf = st?.fields.find((f) => f.id === r.sourceFieldId)
        const tf = tt?.fields.find((f) => f.id === r.targetFieldId)
        return {
          id: r.id, name: r.name ?? null,
          source: st ? `${st.name}.${sf?.name ?? '?'}` : '?',
          target: tt ? `${tt.name}.${tf?.name ?? '?'}` : '?',
          sourceCardinality: r.sourceCardinality, targetCardinality: r.targetCardinality
        }
      }),
      enums: model.enums.map((e) => ({ id: e.id, name: e.name, valuesCount: e.values.length }))
    }
    return { model, result: ok(data, `模型概览: ${data.tablesCount} 表 / ${data.relationshipsCount} 关系 / ${data.enumsCount} 枚举`) }
  }
}

// ============ 读取：完整结构化 JSON ============

const getModelJsonTool: ToolDef = {
  name: 'get_model_json',
  description: '获取当前数据模型的完整结构化 JSON（含表、字段、关系、索引、枚举、布局位置、颜色等全部内容）。includeLayout=false 时省略布局字段（x/y/width/color/expanded）以减小体积；tables 指定表名数组时仅返回这些表的完整定义（按需读取，避免全量）。',
  parameters: {
    type: 'object',
    properties: {
      includeLayout: { type: 'boolean', description: '是否包含布局字段（x/y/width/color/expanded），默认 true' },
      tables: { type: 'array', items: { type: 'string' }, description: '仅返回指定表名（不区分大小写）的完整定义；省略则返回全部' }
    }
  },
  execute: (model, args: any) => {
    const includeLayout = args?.includeLayout !== false
    let out = includeLayout ? model : stripLayout(model)
    if (Array.isArray(args?.tables) && args.tables.length > 0) {
      const names = new Set(args.tables.map((n: string) => n.toLowerCase()))
      out = { ...out, tables: out.tables.filter((t) => names.has(t.name.toLowerCase())) }
    }
    return { model, result: ok({ model: out }, `已导出模型 JSON（${out.tables.length} 表）`) }
  }
}

// ============ 写入：完整 JSON 替换/合并 ============

const setModelJsonTool: ToolDef = {
  name: 'set_model_json',
  description: '用结构化 JSON 设置当前数据模型，是修改模型的主要方式。mode=replace 用传入的 model 整体替换；mode=merge 按表名去重并入（已存在的表跳过）。AI 编辑 get_model_json 返回的 JSON 后调用本工具写回，即可完成任意增删改。',
  parameters: {
    type: 'object',
    properties: {
      model: { type: 'object', description: 'DataModel 结构化 JSON（含 tables/relationships/indexes/enums）' },
      mode: { type: 'string', enum: ['replace', 'merge'], description: 'replace=整体替换，merge=并入。默认 replace' }
    },
    required: ['model']
  },
  execute: (model, args: any) => {
    const incoming = args.model
    if (!incoming || !Array.isArray(incoming.tables)) {
      return { model, result: err('model 参数无效：缺少 tables 数组') }
    }
    if (args.mode === 'merge') return mergeModel(model, incoming)
    const normalized = normalizeModel(incoming)
    const replaced: DataModel = {
      ...normalized,
      id: model.id,
      name: normalized.name ?? model.name,
      databaseType: normalized.databaseType ?? model.databaseType,
      updatedAt: Date.now()
    }
    return { model: replaced, result: ok({ mode: 'replace', tables: replaced.tables.length, relationships: replaced.relationships.length }, `已用 JSON 替换模型：${replaced.tables.length} 表 / ${replaced.relationships.length} 关系`) }
  }
}

// ============ 写入：增量补丁（结构化操作指令） ============

const patchModelTool: ToolDef = {
  name: 'patch_model',
  description: '对当前数据模型做增量修改，无需传全量 JSON。operations 为操作数组，每个操作通过表名/字段名/枚举名定位（不区分大小写）。支持操作：addTable/updateTable/removeTable、addField/updateField/removeField、addRelationship/removeRelationship、addEnum/removeEnum、addIndex/removeIndex。一次可包含多个操作，按顺序执行，任一失败则整体回滚。',
  parameters: {
    type: 'object',
    properties: {
      operations: {
        type: 'array',
        description: '增量操作列表。示例：[{op:"addTable",table:{name:"orders",fields:[{name:"id",type:"bigint",primaryKey:true}]}}, {op:"addField",table:"orders",field:{name:"total",type:"decimal"}}]',
        items: { type: 'object' }
      }
    },
    required: ['operations']
  },
  execute: (model, args: any) => {
    const ops = args?.operations
    if (!Array.isArray(ops) || ops.length === 0) {
      return { model, result: err('operations 参数无效：需为非空数组') }
    }
    let current = model
    const applied: string[] = []
    for (const op of ops) {
      const r = applyPatchOp(current, op)
      if (!r.ok) return { model, result: err(`操作 ${op?.op} 失败: ${r.error}`) }
      current = r.model
      applied.push(r.message)
    }
    return { model: current, result: ok({ applied, tables: current.tables.length, relationships: current.relationships.length }, `已应用 ${applied.length} 个增量操作`) }
  }
}

type PatchResult = { ok: true; model: DataModel; message: string } | { ok: false; error: string }

function findTableByName(model: DataModel, name: unknown): Table | undefined {
  if (typeof name !== 'string' || !name) return undefined
  const lower = name.toLowerCase()
  return model.tables.find((t) => t.name.toLowerCase() === lower)
}

function findFieldByName(table: Table, name: unknown): Field | undefined {
  if (typeof name !== 'string' || !name) return undefined
  const lower = name.toLowerCase()
  return table.fields.find((f) => f.name.toLowerCase() === lower)
}

function applyPatchOp(model: DataModel, op: any): PatchResult {
  const kind = op?.op
  switch (kind) {
    case 'addTable': {
      const name = op?.table?.name
      if (typeof name !== 'string' || !name) return { ok: false, error: '缺少 table.name' }
      if (model.tables.some((t) => t.name.toLowerCase() === name.toLowerCase())) return { ok: false, error: `表已存在: ${name}` }
      const fields = (op.table.fields ?? []).map((f: any) => createField({
        name: f.name, type: f.type, typeLength: f.typeLength ?? null,
        primaryKey: f.primaryKey ?? false, unique: f.unique ?? false, nullable: f.nullable ?? true,
        autoIncrement: f.autoIncrement ?? false, defaultValue: f.defaultValue ?? null, comment: f.comment ?? null
      }))
      const table = createTable({
        name, schema: op.table.schema ?? null, comment: op.table.comment ?? null,
        color: op.table.color, isView: op.table.isView,
        fields: fields.length > 0 ? fields : undefined
      })
      table.x = 80 + (model.tables.length % 8) * 40
      table.y = 80 + (model.tables.length % 8) * 40
      return { ok: true, model: { ...model, tables: [...model.tables, table], updatedAt: Date.now() }, message: `已添加表 ${name}` }
    }
    case 'updateTable': {
      const t = findTableByName(model, op?.table)
      if (!t) return { ok: false, error: `未找到表: ${op?.table}` }
      const updated: Table = { ...t, ...(op.patch ?? {}), id: t.id }
      return { ok: true, model: { ...model, tables: model.tables.map((x) => (x.id === t.id ? updated : x)), updatedAt: Date.now() }, message: `已更新表 ${t.name}` }
    }
    case 'removeTable': {
      const t = findTableByName(model, op?.table)
      if (!t) return { ok: false, error: `未找到表: ${op?.table}` }
      return {
        ok: true,
        model: {
          ...model,
          tables: model.tables.filter((x) => x.id !== t.id),
          relationships: model.relationships.filter((r) => r.sourceTableId !== t.id && r.targetTableId !== t.id),
          indexes: model.indexes.filter((i) => i.tableId !== t.id),
          updatedAt: Date.now()
        },
        message: `已删除表 ${t.name}`
      }
    }
    case 'addField': {
      const t = findTableByName(model, op?.table)
      if (!t) return { ok: false, error: `未找到表: ${op?.table}` }
      const fname = op?.field?.name
      if (typeof fname !== 'string' || !fname) return { ok: false, error: '缺少 field.name' }
      if (t.fields.some((f) => f.name.toLowerCase() === fname.toLowerCase())) return { ok: false, error: `字段已存在: ${t.name}.${fname}` }
      const field = createField({
        name: fname, type: op.field.type, typeLength: op.field.typeLength ?? null,
        primaryKey: op.field.primaryKey ?? false, unique: op.field.unique ?? false, nullable: op.field.nullable ?? true,
        autoIncrement: op.field.autoIncrement ?? false, defaultValue: op.field.defaultValue ?? null, comment: op.field.comment ?? null
      })
      return { ok: true, model: { ...model, tables: model.tables.map((x) => (x.id === t.id ? { ...x, fields: [...x.fields, field] } : x)), updatedAt: Date.now() }, message: `已添加字段 ${t.name}.${fname}` }
    }
    case 'updateField': {
      const t = findTableByName(model, op?.table)
      if (!t) return { ok: false, error: `未找到表: ${op?.table}` }
      const f = findFieldByName(t, op?.field)
      if (!f) return { ok: false, error: `未找到字段: ${t.name}.${op?.field}` }
      const updated: Field = { ...f, ...(op.patch ?? {}), id: f.id }
      return { ok: true, model: { ...model, tables: model.tables.map((x) => (x.id === t.id ? { ...x, fields: x.fields.map((y) => (y.id === f.id ? updated : y)) } : x)), updatedAt: Date.now() }, message: `已更新字段 ${t.name}.${f.name}` }
    }
    case 'removeField': {
      const t = findTableByName(model, op?.table)
      if (!t) return { ok: false, error: `未找到表: ${op?.table}` }
      const f = findFieldByName(t, op?.field)
      if (!f) return { ok: false, error: `未找到字段: ${t.name}.${op?.field}` }
      return {
        ok: true,
        model: {
          ...model,
          tables: model.tables.map((x) => (x.id === t.id ? { ...x, fields: x.fields.filter((y) => y.id !== f.id) } : x)),
          relationships: model.relationships.filter((r) => r.sourceFieldId !== f.id && r.targetFieldId !== f.id),
          indexes: model.indexes.map((i) => ({ ...i, fieldIds: i.fieldIds.filter((id) => id !== f.id) })).filter((i) => i.fieldIds.length > 0),
          updatedAt: Date.now()
        },
        message: `已删除字段 ${t.name}.${f.name}`
      }
    }
    case 'addRelationship': {
      const rel = op?.relationship ?? {}
      const sTable = findTableByName(model, rel.sourceTable)
      const tTable = findTableByName(model, rel.targetTable)
      if (!sTable) return { ok: false, error: `未找到源表: ${rel.sourceTable}` }
      if (!tTable) return { ok: false, error: `未找到目标表: ${rel.targetTable}` }
      const sField = findFieldByName(sTable, rel.sourceField)
      const tField = findFieldByName(tTable, rel.targetField)
      if (!sField) return { ok: false, error: `未找到源字段: ${sTable.name}.${rel.sourceField}` }
      if (!tField) return { ok: false, error: `未找到目标字段: ${tTable.name}.${rel.targetField}` }
      const key = `${sTable.id}:${sField.id}:${tTable.id}:${tField.id}`
      if (model.relationships.some((r) => `${r.sourceTableId}:${r.sourceFieldId}:${r.targetTableId}:${r.targetFieldId}` === key)) return { ok: false, error: '关系已存在' }
      const relationship = createRelationship({
        name: rel.name ?? null,
        sourceTableId: sTable.id, sourceFieldId: sField.id,
        targetTableId: tTable.id, targetFieldId: tField.id,
        sourceCardinality: (rel.sourceCardinality as Cardinality) ?? 'one',
        targetCardinality: (rel.targetCardinality as Cardinality) ?? 'many'
      })
      return { ok: true, model: { ...model, relationships: [...model.relationships, relationship], updatedAt: Date.now() }, message: `已创建关系 ${sTable.name}.${sField.name} → ${tTable.name}.${tField.name}` }
    }
    case 'removeRelationship': {
      const target = model.relationships.find((r) => r.id === op?.relationship)
      if (!target) return { ok: false, error: `未找到关系: ${op?.relationship}` }
      return { ok: true, model: { ...model, relationships: model.relationships.filter((r) => r.id !== target.id), updatedAt: Date.now() }, message: '已删除关系' }
    }
    case 'addEnum': {
      const name = op?.enum?.name
      if (typeof name !== 'string' || !name) return { ok: false, error: '缺少 enum.name' }
      if (model.enums.some((e) => e.name.toLowerCase() === name.toLowerCase())) return { ok: false, error: `枚举已存在: ${name}` }
      const enumType = createEnumType({
        name,
        values: (op.enum.values ?? []).map((v: any) => ({ id: createId('enumv'), name: v.name, comment: v.comment ?? null }))
      })
      return { ok: true, model: { ...model, enums: [...model.enums, enumType], updatedAt: Date.now() }, message: `已创建枚举 ${name}` }
    }
    case 'removeEnum': {
      const target = model.enums.find((e) => e.id === op?.enum || e.name.toLowerCase() === (op?.enum ?? '').toLowerCase())
      if (!target) return { ok: false, error: `未找到枚举: ${op?.enum}` }
      return { ok: true, model: { ...model, enums: model.enums.filter((e) => e.id !== target.id), updatedAt: Date.now() }, message: `已删除枚举 ${target.name}` }
    }
    case 'addIndex': {
      const t = findTableByName(model, op?.index?.table)
      if (!t) return { ok: false, error: `未找到表: ${op?.index?.table}` }
      const fieldIds = (op.index.fields ?? []).map((fname: string) => findFieldByName(t, fname)?.id).filter((id: string | undefined): id is string => !!id)
      if (fieldIds.length === 0) return { ok: false, error: 'addIndex 需至少一个有效字段' }
      const index: Index = {
        id: createId('idx'),
        name: op.index.name ?? `idx_${t.name}_${fieldIds.length}`,
        tableId: t.id, fieldIds,
        unique: op.index.unique ?? false,
        type: op.index.type ?? 'btree',
        createdAt: Date.now()
      }
      return { ok: true, model: { ...model, indexes: [...model.indexes, index], updatedAt: Date.now() }, message: `已创建索引 ${index.name}` }
    }
    case 'removeIndex': {
      const target = model.indexes.find((i) => i.id === op?.index || i.name === op?.index)
      if (!target) return { ok: false, error: `未找到索引: ${op?.index}` }
      return { ok: true, model: { ...model, indexes: model.indexes.filter((i) => i.id !== target.id), updatedAt: Date.now() }, message: `已删除索引 ${target.name}` }
    }
    default:
      return { ok: false, error: `未知操作: ${kind}` }
  }
}

// ============ 写入：DBML 文本导入 ============

const importDbmlTool: ToolDef = {
  name: 'import_dbml',
  description: '将一段 DBML 文本解析并导入当前数据模型。mode=replace 整体替换；mode=merge 按表名去重并入。适合用户提供了既有 DBML/SQL DDL 文本时快速导入。',
  parameters: {
    type: 'object',
    properties: {
      dbml: { type: 'string', description: 'DBML 格式的 schema 文本' },
      mode: { type: 'string', enum: ['replace', 'merge'], description: 'replace=整体替换，merge=并入。默认 replace' }
    },
    required: ['dbml']
  },
  execute: (model, args: any, ctx) => {
    if (!ctx?.parseDbml) return { model, result: err('DBML 解析器未注入（仅主进程可用）') }
    let imported: DataModel
    try {
      imported = ctx.parseDbml(args.dbml, model.name)
    } catch (e) {
      return { model, result: err(`DBML 解析失败: ${e instanceof Error ? e.message : String(e)}`) }
    }
    if (args.mode === 'merge') return mergeModel(model, imported)
    const replaced: DataModel = { ...imported, id: model.id, name: model.name, updatedAt: Date.now() }
    return { model: replaced, result: ok({ mode: 'replace', tables: replaced.tables.length, relationships: replaced.relationships.length }, `已用 DBML 替换模型：${replaced.tables.length} 表 / ${replaced.relationships.length} 关系`) }
  }
}

// ============ 写入：DBML 文件导入 ============

const importDbmlFileTool: ToolDef = {
  name: 'import_dbml_file',
  description: '从指定文件路径读取 DBML 文件并导入当前数据模型。mode=replace 整体替换；mode=merge 按表名去重并入。适合用户提供了 DBML/SQL DDL 文件时快速导入。',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'DBML 文件的绝对路径' },
      mode: { type: 'string', enum: ['replace', 'merge'], description: 'replace=整体替换，merge=并入。默认 replace' }
    },
    required: ['path']
  },
  execute: (model, args: any, ctx) => {
    if (!ctx?.readFile) return { model, result: err('文件读取能力未注入（仅主进程可用）') }
    if (!ctx?.parseDbml) return { model, result: err('DBML 解析器未注入（仅主进程可用）') }
    let content: string
    try {
      content = ctx.readFile(args.path)
    } catch (e) {
      return { model, result: err(`读取文件失败: ${e instanceof Error ? e.message : String(e)}`) }
    }
    let imported: DataModel
    try {
      imported = ctx.parseDbml(content, 'DBML 文件导入')
    } catch (e) {
      return { model, result: err(`DBML 解析失败: ${e instanceof Error ? e.message : String(e)}`) }
    }
    if (args.mode === 'merge') return mergeModel(model, imported)
    const replaced: DataModel = { ...imported, id: model.id, name: model.name, updatedAt: Date.now() }
    return { model: replaced, result: ok({ mode: 'replace', tables: replaced.tables.length, relationships: replaced.relationships.length }, `已从文件导入并替换模型：${replaced.tables.length} 表 / ${replaced.relationships.length} 关系`) }
  }
}

// ============ 文件层：导出完整工程文件 ============

const exportModelFileTool: ToolDef = {
  name: 'export_model_file',
  description: '将当前数据模型的完整工程内容（含布局、索引、枚举引用等全部信息）导出为 JSON 文件到指定路径。适合超大模型：AI 可先导出文件，再通过文件读取/编辑全量内容，避免在对话中传输过大 JSON。',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: '导出文件的绝对路径（建议 .dmv.json 后缀）' }
    },
    required: ['path']
  },
  execute: (model, args: any, ctx) => {
    if (!ctx?.writeFile) return { model, result: err('文件写入能力未注入（仅主进程可用）') }
    const payload = JSON.stringify({ version: 1, model, updatedAt: Date.now() }, null, 2)
    try {
      ctx.writeFile(args.path, payload)
    } catch (e) {
      return { model, result: err(`写入文件失败: ${e instanceof Error ? e.message : String(e)}`) }
    }
    return { model, result: ok({ path: args.path, tables: model.tables.length }, `已导出工程文件到 ${args.path}`) }
  }
}

// ============ 文件层：导入完整工程文件 ============

const importModelFileTool: ToolDef = {
  name: 'import_model_file',
  description: '从指定路径读取完整工程文件（.dmv.json，含布局、索引、枚举引用等全部信息）并导入当前数据模型。mode=replace 整体替换；mode=merge 按表名去重并入。适合超大模型经文件导入。',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: '工程文件的绝对路径（.dmv.json）' },
      mode: { type: 'string', enum: ['replace', 'merge'], description: 'replace=整体替换，merge=并入。默认 replace' }
    },
    required: ['path']
  },
  execute: (model, args: any, ctx) => {
    if (!ctx?.readFile) return { model, result: err('文件读取能力未注入（仅主进程可用）') }
    let content: string
    try {
      content = ctx.readFile(args.path)
    } catch (e) {
      return { model, result: err(`读取文件失败: ${e instanceof Error ? e.message : String(e)}`) }
    }
    let incoming: DataModel
    try {
      const raw = JSON.parse(content)
      incoming = raw?.model ?? raw
      if (!incoming?.tables || !Array.isArray(incoming.tables)) {
        return { model, result: err('工程文件格式不正确：缺少 tables 数组') }
      }
    } catch (e) {
      return { model, result: err(`解析工程文件失败: ${e instanceof Error ? e.message : String(e)}`) }
    }
    if (args.mode === 'merge') return mergeModel(model, incoming)
    const replaced: DataModel = {
      ...incoming,
      id: model.id,
      name: incoming.name ?? model.name,
      relationships: incoming.relationships ?? [],
      indexes: incoming.indexes ?? [],
      enums: incoming.enums ?? [],
      updatedAt: Date.now()
    }
    return { model: replaced, result: ok({ mode: 'replace', tables: replaced.tables.length, relationships: replaced.relationships.length }, `已从工程文件导入并替换模型：${replaced.tables.length} 表 / ${replaced.relationships.length} 关系`) }
  }
}

// ============ 合并逻辑（按表名去重并入） ============

function mergeModel(model: DataModel, incoming: DataModel): ToolExecResult {
  const normalized = normalizeModel(incoming)
  const existingNames = new Set(model.tables.map((t) => t.name.toLowerCase()))
  const newTables = normalized.tables.filter((t) => !existingNames.has(t.name.toLowerCase()))
  const allTables = [...model.tables, ...newTables]
  const incomingTableIdToName = new Map(normalized.tables.map((t) => [t.id, t.name.toLowerCase()]))
  const incomingFieldIdToName = new Map<string, string>()
  for (const t of normalized.tables) {
    for (const f of t.fields) incomingFieldIdToName.set(`${t.id}:${f.id}`, f.name.toLowerCase())
  }
  const existingRelKeys = new Set(model.relationships.map((r) => `${r.sourceTableId}:${r.sourceFieldId}:${r.targetTableId}:${r.targetFieldId}`))
  const newRels = normalized.relationships
    .map((rel) => {
      const sName = incomingTableIdToName.get(rel.sourceTableId)
      const tName = incomingTableIdToName.get(rel.targetTableId)
      if (!sName || !tName) return null
      const sFieldName = incomingFieldIdToName.get(`${rel.sourceTableId}:${rel.sourceFieldId}`)
      const tFieldName = incomingFieldIdToName.get(`${rel.targetTableId}:${rel.targetFieldId}`)
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
  return { model: merged, result: ok({ mode: 'merge', addedTables: newTables.length, addedRelationships: newRels.length, totalTables: merged.tables.length }, `并入完成：新增 ${newTables.length} 表 / ${newRels.length} 关系（共 ${merged.tables.length} 表）`) }
}

// ============ 布局剥离（减小体积） ============

function stripLayout(model: DataModel): DataModel {
  const tables: Table[] = model.tables.map((t) => ({
    ...t,
    x: 0, y: 0, width: 260, color: '#71717a', expanded: true
  }))
  return { ...model, tables }
}

// ============ registry ============

export const MODEL_TOOLS: ToolDef[] = [
  getModelMetaTool,
  getModelJsonTool,
  setModelJsonTool,
  patchModelTool,
  importDbmlTool,
  importDbmlFileTool,
  exportModelFileTool,
  importModelFileTool
]

export function getToolByName(name: string): ToolDef | undefined {
  return MODEL_TOOLS.find((t) => t.name === name)
}
