import { getJavascriptModuleStatus } from './javascript-exec.tool'

export function buildOfficeGuide(workspacePath?: string, formats?: string[]): string {
  const moduleStatus = getJavascriptModuleStatus()
  const availableModules = Object.entries(moduleStatus)
    .filter(([, s]) => s.loaded)
    .map(([name]) => name)

  if (availableModules.length === 0) {
    return '当前环境未加载任何Office文档模块，无法创建或编辑Office文档。'
  }

  const validFormats = ['docx', 'pptx', 'xlsx']
  const requestedFormats = Array.isArray(formats) && formats.length > 0
    ? formats.map(f => String(f).toLowerCase()).filter(f => validFormats.includes(f))
    : null

  const hasDocx = moduleStatus['docx']?.loaded
  const hasPptx = moduleStatus['pptxgenjs']?.loaded
  const hasXlsx = moduleStatus['xlsx']?.loaded
  const hasAdmZip = moduleStatus['adm-zip']?.loaded

  const parts: string[] = []

  // ===== 头部：核心规则 =====
  parts.push('## Office 文档规则与陷阱')
  parts.push('')
  parts.push('**必须用 `javascript_exec`，禁止 `shell_exec` 调外部脚本。**')
  parts.push('')

  // ===== 语法预检查 =====
  parts.push('### 语法预检查（自动）')
  parts.push('执行前**自动校验 JS 语法**，语法错误立即返回（不执行），含行号、代码上下文、修复建议。')
  parts.push('- 语法错误时**根据返回的行号和上下文精确定位修复**，不要重写整个文件')
  parts.push('')

  // ===== 长文档分步执行（核心规则） =====
  parts.push('### 长文档分步执行（强制规则）')
  parts.push('生成超长文档（≥1500字）时**必须分步**，禁止一次性生成全部代码：')
  parts.push('')
  parts.push('```js')
  parts.push('// 步骤1：file_write 写入骨架代码（含 Document 结构 + 前 1-2 个章节）')
  parts.push('file_write({ path: "/workspace/gen-doc.js", content: "..." })')
  parts.push('')
  parts.push('// 步骤2：javascript_exec 执行骨架，生成基础文档')
  parts.push('javascript_exec({ code_file: "/workspace/gen-doc.js" })')
  parts.push('')
  parts.push('// 步骤3：file_edit 在 sections.children 数组中追加章节内容')
  parts.push('file_edit({ operation: "insert", path: "/workspace/gen-doc.js", after_string: "/* SECTION_END */", content: "..." })')
  parts.push('')
  parts.push('// 步骤4：重复 javascript_exec 验证，逐步完善')
  parts.push('javascript_exec({ code_file: "/workspace/gen-doc.js" })')
  parts.push('```')
  parts.push('')
  parts.push('**分步原则**：')
  parts.push('- 每次追加 1-2 个章节，单次代码增量 ≤ 800 字')
  parts.push('- 用 `/* SECTION_END */` 等锚点标记插入位置，便于 file_edit 精确定位')
  parts.push('- 每步执行后检查输出，确认无错再继续下一步')
  parts.push('')

  // ===== 代码传入方式 =====
  parts.push('### 代码传入方式')
  parts.push('- **短代码（<800字）**：直接传 `code` 参数')
  parts.push('- **长代码（≥800字）**：先用 `file_write` 写入 `.js` 文件，再传 `code_file` 参数（避免 JSON 转义导致引号 SyntaxError）')
  parts.push('- **任务完成清理**：临时代码文件（如 `gen-doc.js`）在文档生成成功后及时删除')
  parts.push('')

  // ===== 沙箱环境 =====
  parts.push('### 沙箱环境')
  parts.push('可用模块：`docx`、`pptxgenjs`、`xlsx`、`adm-zip`、`fs`（只读）、`path`、`os`、`stream`、`buffer`、`util`、`crypto`')
  parts.push('- 全局 `file` — 异步写入（save/append/copy/move/delete/createFolder/exists），**fs 写方法已禁用**')
  parts.push('- 全局 `__workspaceDir` — 工作目录绝对路径；`Buffer`/`console` 可直接用')
  parts.push('```js')
  parts.push('await file.save(path.join(__workspaceDir, "output.docx"), buffer);')
  parts.push('const exists = file.exists(path.join(__workspaceDir, "template.docx"));')
  parts.push('```')
  if (workspacePath) {
    parts.push(`当前工作区: \`${workspacePath}\``)
  }

  // ===== 概览模式 =====
  if (!requestedFormats) {
    parts.push('\n### 格式选择')
    parts.push('传 `formats` 获取对应格式的陷阱清单：')
    if (hasDocx) {
      parts.push('- **docx** — 从零创建用 `docx` 模块；修改已有用 `adm-zip`')
    }
    if (hasPptx) {
      parts.push('- **pptx** — 从零创建用 `pptxgenjs`；修改已有用 `adm-zip`')
    }
    if (hasXlsx) {
      parts.push('- **xlsx** — 创建/修改均用 `xlsx`')
    }
    parts.push('')
    parts.push(buildQuoteRules())
    return parts.join('\n')
  }

  // ===== 详细模式 =====
  const fmt = (name: string) => requestedFormats.includes(name)

  if (fmt('docx') && hasDocx) {
    parts.push(buildDocxGuide(hasAdmZip))
  }
  if (fmt('pptx') && hasPptx) {
    parts.push(buildPptxGuide(hasAdmZip))
  }
  if (fmt('xlsx') && hasXlsx) {
    parts.push(buildXlsxGuide(hasAdmZip))
  }

  parts.push(buildQuoteRules())

  return parts.join('\n')
}

// ==================== Word (docx) 陷阱 ====================
function buildDocxGuide(hasAdmZip: boolean): string {
  const parts: string[] = []
  parts.push('\n---\n')
  parts.push('## Word (docx) 陷阱')

  parts.push('\n### 从零创建（docx 库）')
  parts.push('**关键陷阱**：')
  parts.push('- bullet 用 `LevelFormat.BULLET`，**不要用 unicode 字符**（如 `"•"`）')
  parts.push('- 换行用新 `Paragraph`，**不要用 `\\n`**（docx 不识别）')
  parts.push('- `PageBreak` 必须放在 `Paragraph.children` 内，**不能直接放 section children**')
  parts.push('- `ImageRun` **必须指定 `type`**（如 `type: "png"`），否则报错')
  parts.push('- 表格宽度用 `WidthType.DXA`（twips），**不要用 PERCENTAGE**（兼容性差）')
  parts.push('- 底纹用 `ShadingType.CLEAR` + `fill`，**不要用 SOLID**')
  parts.push('- `size` 单位是**半磅**（28=14pt），`color` **不带 `#` 前缀**')
  parts.push('- Document 必须显式设 `page.size`（默认尺寸可能不符预期），页边距单位 twips（1 英寸 = 1440）')
  parts.push('- 长文档**必须分步生成**：先骨架后填充，单次代码 ≤ 800 字')

  if (hasAdmZip) {
    parts.push('\n### 修改已有 docx（adm-zip）')
    parts.push('docx = ZIP 包。正文 `word/document.xml`，页眉 `word/header*.xml`，页脚 `word/footer*.xml`。')
    parts.push('')
    parts.push('**文本替换陷阱**：')
    parts.push('- **文本拆分**：Word 会把同一段拆到多个 `<w:t>`（如"科技有限公司"→3 个 run），导致 `replace` 失败。**先打印 `<w:t>` 列表确认**：`console.log(docXml.match(/<w:t[^>]*>[^<]*<\\/w:t>/g)?.slice(0, 30))`')
    parts.push('- 只能改 `<w:t>` 文本，**不要动 XML 标签/属性**（会损坏文档）')
    parts.push('- 同步替换页眉页脚（`word/header*.xml` / `word/footer*.xml`）')
    parts.push('- 始终输出到新文件，**禁止覆盖原文件**')
    parts.push('- 替换用 `split(old).join(new)`，**不要用 `replace`**（只替换第一个）')
  }
  return parts.join('\n')
}

// ==================== PowerPoint (pptx) 陷阱 ====================
function buildPptxGuide(hasAdmZip: boolean): string {
  const parts: string[] = []
  parts.push('\n---\n')
  parts.push('## PowerPoint (pptx) 陷阱')

  parts.push('\n### 从零创建（pptxgenjs 库）')
  parts.push('**关键陷阱**：')
  parts.push('- 颜色**不带 `#` 前缀**：`"FF0000"` 而非 `"#FF0000"`')
  parts.push('- 透明度用 `opacity` 属性，**不要用 8 位 hex**')
  parts.push('- 项目符号用 `bullet: true`，**不要用 unicode 字符**')
  parts.push('- 多行用数组 + `breakLine: true`，**不要用 `\\n`**')
  parts.push('- **不要复用 options 对象**（PptxGenJS 会修改它），每次 `addText` 用新对象')
  parts.push('- 坐标单位是**英寸**（16:9 幻灯片尺寸 10 × 5.625）')

  if (hasAdmZip) {
    parts.push('\n### 修改已有 pptx（adm-zip）')
    parts.push('pptx = ZIP 包。幻灯片 `ppt/slides/slide*.xml`，备注 `ppt/notesSlides/*.xml`。')
    parts.push('')
    parts.push('**文本替换陷阱**：')
    parts.push('- **文本拆分**：同一段可能被拆到多个 `<a:t>`，**先打印 `<a:t>` 列表确认文本在同一 run 内**')
    parts.push('- 只能改 `<a:t>` 文本，**不要动 XML 结构**')
    parts.push('- 始终输出到新文件')
  }
  return parts.join('\n')
}

// ==================== Excel (xlsx) 陷阱 ====================
function buildXlsxGuide(hasAdmZip: boolean): string {
  const parts: string[] = []
  parts.push('\n---\n')
  parts.push('## Excel (xlsx) 陷阱')

  parts.push('\n### 创建/修改（xlsx 库）')
  parts.push('**关键陷阱**：')
  parts.push('- 修改/创建单元格**必须指定 `t` 类型**（`t: "s"` 字符串 / `t: "n"` 数字 / `t: "b"` 布尔）')
  parts.push('- 追加行后**必须更新 `!ref`**，否则新数据不可见：`ws["!ref"] = XLSX.utils.encode_range({ s: range.s, e: { r: newRow, c: range.e.c } })`')
  parts.push('- `XLSX.readFile` 会**丢失公式/图表/样式**，仅保留值和基本格式')
  parts.push('- `XLSX.writeFile` 已被沙箱包装为异步，需 `await`')
  if (hasAdmZip) {
    parts.push('- 需完整保留格式时，用 `adm-zip` 直接操作 `xl/worksheets/sheet*.xml`')
  }
  return parts.join('\n')
}

// ==================== 字符串引号 ====================
function buildQuoteRules(): string {
  return [
    '\n---\n',
    '## 字符串引号（SyntaxError 头号原因）',
    '',
    '中文文本含双引号时**必须用单引号或反引号定界**：',
    '```js',
    "// ✅ 外层用单引号",
    "const text = '这是\"引号\"文本';",
    '// ✅ 外层用反引号（推荐，支持多行）',
    'const text = `这是"引号"文本`;',
    '// ❌ 双引号内含双引号 → SyntaxError',
    'const text = "这是"引号"文本";',
    '```',
    '',
    '**经验法则**：',
    '- 含双引号的中文文本**优先用反引号**（`` ` ``）定界，支持多行无需转义',
    '- 含反引号的代码示例**用单引号定界**，反引号转义为 `\\``',
    '- 长字符串（>200字）**拆分为数组**再 `join("")`，降低转义复杂度',
    '- 拼接长文本时用 `["行1", "行2", "行3"].join("\\n")` 优于多行字符串',
    '',
    '**语法错误自动检测**：执行前自动校验，错误时返回行号、上下文、修复建议，根据提示精确定位修复。',
  ].join('\n')
}

// office_guide 工具已移除：内容合并到 list_available_tools 的 javascript_exec 详情中（meta-tools.ts）
