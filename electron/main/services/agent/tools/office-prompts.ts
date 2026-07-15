import type { ToolDefinition } from './types'
import { getOfficeModuleStatus } from './office-exec.tool'

function buildOfficeGuide(workspacePath?: string, formats?: string[]): string {
  const moduleStatus = getOfficeModuleStatus()
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

  // ===== 头部 =====
  parts.push('## Office 文档操作指南')
  parts.push('')
  parts.push('**必须用 `office_exec`，不要用 `shell_exec` 调外部脚本。** 沙箱内置 docx/pptxgenjs/xlsx/adm-zip，文件通过 `file.save` 异步写入工作区。')
  parts.push('')
  parts.push('**工作流**：`office_guide({ formats: [...] })` 获取模板 → `office_exec({ code: "..." })` 执行。')

  // ===== 模块速览 =====
  parts.push('\n### 可用模块')
  const moduleDescriptions: Record<string, string> = {
    'docx': '从零创建 Word',
    'pptxgenjs': '从零创建 PowerPoint',
    'xlsx': '创建/读取/修改 Excel',
    'adm-zip': '修改已有 docx/pptx（操作内部 XML）',
  }
  for (const name of availableModules) {
    parts.push(`- \`require("${name}")\` — ${moduleDescriptions[name] || name}`)
  }
  parts.push('- `require("fs")` — 只读（**写方法已禁用**）；`require("path")` — 路径')
  parts.push('- 全局 `file` — 异步写入（save/append/copy/move/delete/createFolder/exists）')
  parts.push('- 全局 `__workspaceDir` — 工作目录绝对路径；`Buffer`/`console` 可直接用')

  // ===== 文件写入 =====
  parts.push('\n### 文件写入')
  parts.push('`fs.writeFileSync` 等**已禁用**，必须用 `file` 对象：')
  parts.push('```js')
  parts.push('await file.save(path.join(__workspaceDir, "output.docx"), buffer);')
  parts.push('const exists = file.exists(path.join(__workspaceDir, "template.docx"));')
  parts.push('await file.copy(sourcePath, path.join(__workspaceDir, "copy.docx"));  // 复制模板到工作区')
  parts.push('```')
  if (workspacePath) {
    parts.push(`当前工作区: \`${workspacePath}\``)
  }

  // ===== 概览模式 =====
  if (!requestedFormats) {
    parts.push('\n### 格式选择')
    parts.push('传 `formats` 获取完整代码模板与陷阱清单：')
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

// ==================== Word (docx) ====================
function buildDocxGuide(hasAdmZip: boolean): string {
  const parts: string[] = []
  parts.push('\n---\n')
  parts.push('## Word (docx)')

  // ---------- 从零创建 ----------
  parts.push('\n### 从零创建（docx 库）')
  parts.push('**API 速查**：')
  parts.push('| API | 用途 |')
  parts.push('|-----|------|')
  parts.push('| `new Document({ sections, numbering })` | 文档入口 |')
  parts.push('| `new Paragraph({ heading, children, alignment, numbering })` | 段落 |')
  parts.push('| `new TextRun({ text, bold, italics, size, color, font })` | 文本片段，`size` 单位半磅（28=14pt） |')
  parts.push('| `HeadingLevel.HEADING_1`~`6` | 标题级别 |')
  parts.push('| `new Table({ rows, width })` / `TableRow` / `TableCell` | 表格 |')
  parts.push('| `new ImageRun({ data, transformation, type })` | 图片，**必须指定 type** |')
  parts.push('| `new PageBreak()` | 分页符，**必须放在 Paragraph 内** |')
  parts.push('| `Packer.toBuffer(doc)` | 序列化为 Buffer |')

  parts.push('\n**示例 1：标题 + 段落 + 列表**')
  parts.push('```js')
  parts.push('const { Document, Packer, Paragraph, TextRun, HeadingLevel,')
  parts.push('  LevelFormat, AlignmentType } = require("docx");')
  parts.push('')
  parts.push('const doc = new Document({')
  parts.push('  numbering: { config: [{')
  parts.push('    reference: "bullets",')
  parts.push('    levels: [{ level: 0, format: LevelFormat.BULLET, text: "\\u2022",')
  parts.push('      alignment: AlignmentType.LEFT,')
  parts.push('      style: { paragraph: { indent: { left: 720, hanging: 360 } } } }]')
  parts.push('  }] },')
  parts.push('  sections: [{ properties: {')
  parts.push('    page: { size: { width: 12240, height: 15840 },')
  parts.push('           margin: { top: 1440, right: 1440, bottom: 1440, left: 1440 } }')
  parts.push('  }, children: [')
  parts.push('    new Paragraph({ heading: HeadingLevel.HEADING_1, alignment: AlignmentType.CENTER,')
  parts.push('      children: [new TextRun("项目周报")] }),')
  parts.push('    new Paragraph({ children: [new TextRun("本周完成：")] }),')
  parts.push('    new Paragraph({ numbering: { reference: "bullets", level: 0 }, children: [new TextRun("需求分析")] }),')
  parts.push('    new Paragraph({ numbering: { reference: "bullets", level: 0 }, children: [new TextRun("架构设计")] }),')
  parts.push('  ] }]')
  parts.push('});')
  parts.push('const buf = await Packer.toBuffer(doc);')
  parts.push('await file.save(path.join(__workspaceDir, "output.docx"), buf);')
  parts.push('```')

  parts.push('\n**示例 2：表格**')
  parts.push('```js')
  parts.push('const { Table, TableRow, TableCell, WidthType } = require("docx");')
  parts.push('')
  parts.push('// 在 section children 中添加：')
  parts.push('new Table({')
  parts.push('  width: { size: 9000, type: WidthType.DXA },')
  parts.push('  rows: [')
  parts.push('    new TableRow({ tableHeader: true, children: [')
  parts.push('      new TableCell({ children: [new Paragraph({ children: [')
  parts.push('        new TextRun({ text: "任务", bold: true, color: "FFFFFF" })]) }] }),')
  parts.push('      new TableCell({ children: [new Paragraph({ children: [')
  parts.push('        new TextRun({ text: "状态", bold: true, color: "FFFFFF" })]) }] }),')
  parts.push('    ] }),')
  parts.push('    new TableRow({ children: [')
  parts.push('      new TableCell({ children: [new Paragraph({ children: [new TextRun("需求分析")] })] }),')
  parts.push('      new TableCell({ children: [new Paragraph({ children: [new TextRun("已完成")] })] }),')
  parts.push('    ] }),')
  parts.push('  ]')
  parts.push('})')
  parts.push('```')

  parts.push('\n**示例 3：分页 + 多 run 富文本**')
  parts.push('```js')
  parts.push('// 分页：放在 Paragraph 的 children 内')
  parts.push('new Paragraph({ children: [new PageBreak()] }),')
  parts.push('')
  parts.push('// 多 run 富文本（同段落不同样式）')
  parts.push('new Paragraph({ children: [')
  parts.push('  new TextRun({ text: "红色加粗 ", bold: true, color: "FF0000", size: 28 }),')
  parts.push('  new TextRun({ text: "斜体灰色", italics: true, color: "888888", size: 24 }),')
  parts.push('] }),')
  parts.push('```')

  parts.push('\n**陷阱**：')
  parts.push('- bullet 用 `LevelFormat.BULLET`，**不要用 unicode**（如 `"•"`）')
  parts.push('- 换行用新 `Paragraph`，**不要用 `\\n`**')
  parts.push('- `PageBreak` 必须放在 `Paragraph.children`，**不能直接放在 section children**')
  parts.push('- `ImageRun` 必须指定 `type`（如 `type: "png"`）')
  parts.push('- 表格宽度用 `WidthType.DXA`（twips），**不要用 PERCENTAGE**')
  parts.push('- 底纹用 `ShadingType.CLEAR` + `fill`，**不要用 SOLID**')
  parts.push('- `size` 单位半磅（28=14pt），`color` 不带 `#` 前缀')
  parts.push('- Document 必须设 `page.size`（默认 A4 尺寸可能不符合预期）')
  parts.push('- 页边距单位 twips：1 英寸 = 1440')

  // ---------- 修改已有 ----------
  if (hasAdmZip) {
    parts.push('\n### 修改已有 docx（adm-zip）')
    parts.push('docx = ZIP 包。正文 `word/document.xml`，页眉 `word/header*.xml`，页脚 `word/footer*.xml`。')
    parts.push('')
    parts.push('**文本替换**（保留所有排版，只改 `<w:t>` 内文本）：')
    parts.push('```js')
    parts.push('const AdmZip = require("adm-zip");')
    parts.push('const zip = new AdmZip(inputPath);')
    parts.push('')
    parts.push('let docXml = zip.readAsText("word/document.xml");')
    parts.push('// 调试：查看 <w:t> 拆分情况 → console.log(docXml.match(/<w:t[^>]*>[^<]*<\\/w:t>/g)?.slice(0, 30));')
    parts.push('')
    parts.push('const replacements = { "原公司": "新公司", "2026-01-01": "2026-07-14" };')
    parts.push('let count = 0;')
    parts.push('for (const [old, neo] of Object.entries(replacements)) {')
    parts.push('  if (docXml.includes(old)) { docXml = docXml.split(old).join(neo); count++; }')
    parts.push('}')
    parts.push('')
    parts.push('// 同步替换页眉页脚')
    parts.push('for (const entry of zip.getEntries()) {')
    parts.push('  if (/word\\/(header|footer)\\d+\\.xml/.test(entry.name)) {')
    parts.push('    let xml = zip.readAsText(entry.name);')
    parts.push('    for (const [old, neo] of Object.entries(replacements)) xml = xml.split(old).join(neo);')
    parts.push('    zip.updateFile(entry.name, Buffer.from(xml, "utf-8"));')
    parts.push('  }')
    parts.push('}')
    parts.push('zip.updateFile("word/document.xml", Buffer.from(docXml, "utf-8"));')
    parts.push('await file.save(path.join(__workspaceDir, "modified.docx"), zip.toBuffer());')
    parts.push('console.log("替换完成:", count, "处");')
    parts.push('```')
    parts.push('')
    parts.push('**陷阱**：')
    parts.push('- **文本拆分**：Word 会把同一段拆到多个 `<w:t>`（如"科技有限公司"→3 个 run），导致 `replace` 失败。**先打印 `<w:t>` 列表确认**：文本必须在同一 run 内，否则需改模板')
    parts.push('- 只能改 `<w:t>` 文本，**不要动 XML 标签/属性**（会损坏文档）')
    parts.push('- 始终输出到新文件，**禁止覆盖原文件**')
  }
  return parts.join('\n')
}

// ==================== PowerPoint (pptx) ====================
function buildPptxGuide(hasAdmZip: boolean): string {
  const parts: string[] = []
  parts.push('\n---\n')
  parts.push('## PowerPoint (pptx)')

  // ---------- 从零创建 ----------
  parts.push('\n### 从零创建（pptxgenjs 库）')
  parts.push('**API 速查**：')
  parts.push('| API | 用途 |')
  parts.push('|-----|------|')
  parts.push('| `new pptxgen()` / `pres.layout = "LAYOUT_16x9"` | 创建演示文稿，16:9 宽屏 |')
  parts.push('| `pres.addSlide()` | 添加幻灯片，返回 slide |')
  parts.push('| `slide.addText(text, options)` | 添加文本，text 可为字符串或 `[{text, options}]` 数组 |')
  parts.push('| `slide.addTable(rows, options)` | 添加表格 |')
  parts.push('| `slide.addImage({ data, x, y, w, h })` | 添加图片，data 为 base64 |')
  parts.push('| `slide.addShape(pres.ShapeType.rect, opts)` | 添加形状 |')
  parts.push('| `slide.background = { color }` | 设置背景色 |')
  parts.push('| `slide.addNotes("备注")` | 添加演讲者备注 |')
  parts.push('')
  parts.push('**options 常用字段**：`x, y, w, h`（英寸）、`fontSize`、`bold`/`italic`、`color`（**不带 #**）、`align`、`fontFace`、`bullet`、`breakLine`、`fill`')

  parts.push('\n**示例 1：标题页 + 内容页（带列表）**')
  parts.push('```js')
  parts.push('const pptxgen = require("pptxgenjs");')
  parts.push('const pres = new pptxgen();')
  parts.push('pres.layout = "LAYOUT_16x9";')
  parts.push('')
  parts.push('// 标题页')
  parts.push('const s1 = pres.addSlide();')
  parts.push('s1.background = { color: "1A1A2E" };')
  parts.push('s1.addText("项目汇报", { x: 0.5, y: 2, w: 9, h: 1.2,')
  parts.push('  fontSize: 44, bold: true, color: "FFFFFF", align: "center", fontFace: "微软雅黑" });')
  parts.push('s1.addText("2026 年度", { x: 0.5, y: 3.3, w: 9, h: 0.6,')
  parts.push('  fontSize: 20, color: "AAAAAA", align: "center" });')
  parts.push('')
  parts.push('// 内容页（多行带 bullet）')
  parts.push('const s2 = pres.addSlide();')
  parts.push('s2.addText("本周进展", { x: 0.5, y: 0.3, w: 9, h: 0.8, fontSize: 32, bold: true, color: "333333" });')
  parts.push('s2.addText([')
  parts.push('  { text: "完成需求分析", options: { bullet: true, breakLine: true } },')
  parts.push('  { text: "完成架构设计", options: { bullet: true, breakLine: true } },')
  parts.push('  { text: "完成核心代码开发", options: { bullet: true, breakLine: true } },')
  parts.push('  { text: "完成单元测试", options: { bullet: true } },')
  parts.push('], { x: 0.8, y: 1.5, w: 8, h: 3, fontSize: 18, color: "555555" });')
  parts.push('```')

  parts.push('\n**示例 2：表格页**')
  parts.push('```js')
  parts.push('const s3 = pres.addSlide();')
  parts.push('s3.addText("任务统计", { x: 0.5, y: 0.3, w: 9, h: 0.7, fontSize: 28, bold: true, color: "333333" });')
  parts.push('s3.addTable([')
  parts.push('  [{ text: "任务", options: { bold: true, fill: { color: "4472C4" }, color: "FFFFFF" } },')
  parts.push('   { text: "状态", options: { bold: true, fill: { color: "4472C4" }, color: "FFFFFF" } }],')
  parts.push('  [{ text: "需求分析" }, { text: "已完成" }],')
  parts.push('  [{ text: "架构设计" }, { text: "进行中" }],')
  parts.push('], { x: 0.5, y: 1.5, w: 6, colW: [3, 3], fontSize: 14, border: { type: "solid", color: "CCCCCC" } });')
  parts.push('')
  parts.push('await pres.writeFile({ fileName: path.join(__workspaceDir, "output.pptx") });')
  parts.push('```')

  parts.push('\n**陷阱**：')
  parts.push('- 颜色**不带 `#` 前缀**：`"FF0000"` 而非 `"#FF0000"`')
  parts.push('- 透明度用 `opacity` 属性，**不要用 8 位 hex**')
  parts.push('- 项目符号用 `bullet: true`，**不要用 unicode**')
  parts.push('- 多行用数组 + `breakLine: true`，**不要用 `\\n`**')
  parts.push('- **不要复用 options 对象**（PptxGenJS 会修改它），每次 `addText` 用新对象')
  parts.push('- 坐标单位是英寸（16:9 幻灯片尺寸 10 × 5.625）')

  // ---------- 修改已有 ----------
  if (hasAdmZip) {
    parts.push('\n### 修改已有 pptx（adm-zip）')
    parts.push('pptx = ZIP 包。幻灯片 `ppt/slides/slide*.xml`，备注 `ppt/notesSlides/*.xml`。')
    parts.push('')
    parts.push('**文本替换**（保留所有排版，只改 `<a:t>` 内文本）：')
    parts.push('```js')
    parts.push('const AdmZip = require("adm-zip");')
    parts.push('const zip = new AdmZip(inputPath);')
    parts.push('')
    parts.push('const replacements = { "公司名称": "科技有限公司", "2026年度": "2027年度" };')
    parts.push('let total = 0;')
    parts.push('')
    parts.push('for (const entry of zip.getEntries()) {')
    parts.push('  if (/ppt\\/slides\\/slide\\d+\\.xml/.test(entry.name)) {')
    parts.push('    let xml = zip.readAsText(entry.name);')
    parts.push('    // 调试：console.log(entry.name, xml.match(/<a:t>[^<]*<\\/a:t>/g)?.slice(0, 20));')
    parts.push('    for (const [old, neo] of Object.entries(replacements)) {')
    parts.push('      if (xml.includes(old)) { xml = xml.split(old).join(neo); total++; }')
    parts.push('    }')
    parts.push('    zip.updateFile(entry.name, Buffer.from(xml, "utf-8"));')
    parts.push('  }')
    parts.push('}')
    parts.push('await file.save(path.join(__workspaceDir, "modified.pptx"), zip.toBuffer());')
    parts.push('console.log("替换完成:", total, "处");')
  parts.push('```')
  parts.push('')
  parts.push('**陷阱**：')
  parts.push('- **文本拆分**：同一段可能被拆到多个 `<a:t>`，先打印 `<a:t>` 列表确认文本在同一 run 内')
  parts.push('- 只能改 `<a:t>` 文本，**不要动 XML 结构**')
  parts.push('- 始终输出到新文件')
  }
  return parts.join('\n')
}

// ==================== Excel (xlsx) ====================
function buildXlsxGuide(hasAdmZip: boolean): string {
  const parts: string[] = []
  parts.push('\n---\n')
  parts.push('## Excel (xlsx)')

  parts.push('\n### 从零创建')
  parts.push('```js')
  parts.push('const XLSX = require("xlsx");')
  parts.push('')
  parts.push('const data = [')
  parts.push('  ["姓名", "年龄", "部门"],')
  parts.push('  ["张三", 28, "技术部"],')
  parts.push('  ["李四", 32, "产品部"],')
  parts.push('];')
  parts.push('const ws = XLSX.utils.aoa_to_sheet(data);')
  parts.push('ws["!cols"] = [{ wch: 10 }, { wch: 8 }, { wch: 12 }];  // 列宽')
  parts.push('')
  parts.push('const wb = XLSX.utils.book_new();')
  parts.push('XLSX.utils.book_append_sheet(wb, ws, "员工信息");')
  parts.push('await XLSX.writeFile(wb, path.join(__workspaceDir, "output.xlsx"));')
  parts.push('```')

  parts.push('\n### 读取/修改已有文件')
  parts.push('```js')
  parts.push('const XLSX = require("xlsx");')
  parts.push('const wb = XLSX.readFile(inputPath);')
  parts.push('const ws = wb.Sheets[wb.SheetNames[0]];')
  parts.push('')
  parts.push('// 读取单元格（{ t: "s", v: "姓名" }）')
  parts.push('console.log("A1:", ws["A1"]?.v);')
  parts.push('')
  parts.push('// 修改单元格（必须指定类型 t）')
  parts.push('ws["A1"] = { t: "s", v: "员工姓名" };  // t: "s"字符串/"n"数字/"b"布尔')
  parts.push('ws["B2"] = { t: "n", v: 29 };')
  parts.push('')
  parts.push('// 追加行（必须更新 !ref 范围）')
  parts.push('const range = XLSX.utils.decode_range(ws["!ref"]);')
  parts.push('const newRow = range.e.r + 1;')
  parts.push('ws[XLSX.utils.encode_cell({ r: newRow, c: 0 })] = { t: "s", v: "赵六" };')
  parts.push('ws[XLSX.utils.encode_cell({ r: newRow, c: 1 })] = { t: "n", v: 27 };')
  parts.push('ws["!ref"] = XLSX.utils.encode_range({')
  parts.push('  s: range.s, e: { r: newRow, c: range.e.c }')
  parts.push('});')
  parts.push('await XLSX.writeFile(wb, path.join(__workspaceDir, "modified.xlsx"));')
  parts.push('```')

  parts.push('\n**API 速查**：')
  parts.push('| API | 用途 |')
  parts.push('|-----|------|')
  parts.push('| `XLSX.utils.aoa_to_sheet([[...], [...]])` | 二维数组转工作表 |')
  parts.push('| `XLSX.utils.json_to_sheet([{name, age}])` | JSON 数组转工作表 |')
  parts.push('| `XLSX.utils.book_new()` / `book_append_sheet(wb, ws, "名")` | 工作簿 |')
  parts.push('| `XLSX.readFile` / `XLSX.writeFile` | 读写文件 |')
  parts.push('| `XLSX.utils.encode_cell({r, c})` / `decode_range(str)` | 单元格地址与范围 |')

  parts.push('\n**陷阱**：')
  parts.push('- 修改/创建单元格**必须指定 `t` 类型**')
  parts.push('- 追加行后**必须更新 `!ref`**，否则新数据不可见')
  parts.push('- `XLSX.readFile` 会**丢失公式/图表/样式**，仅保留值和基本格式')
  if (hasAdmZip) {
    parts.push('- 需完整保留格式时，用 `adm-zip` 直接操作 `xl/worksheets/sheet*.xml`（同 docx/pptx 的 XML 操作方式）')
  }
  return parts.join('\n')
}

// ==================== 字符串引号 ====================
function buildQuoteRules(): string {
  return [
    '\n---\n',
    '## 字符串引号（SyntaxError 头号原因）',
    '',
    '中文文本含双引号时**必须用单引号定界**，否则 JS 解析错误：',
    '```js',
    "// ✅ 正确：外层用单引号",
    'const text = \'这是"引号"文本\';',
    '// ✅ 正确：用中文引号',
    'const text = "这是"引号"文本";',
    '// ❌ 错误：双引号内含双引号 → SyntaxError',
    'const text = "这是"引号"文本";',
    '```',
  ].join('\n')
}

export function createOfficeGuideTool(workspacePath?: string): ToolDefinition {
  return {
    id: 'office_guide',
    name: 'office_guide',
    title: 'Office文档使用指南',
    description: '获取Office文档(Word/PowerPoint/Excel)创建和编辑的完整指南。**创建或修改Office文档前必须先调用此工具获取指南**，然后用 office_exec 执行代码。包含代码模板、API速查、关键陷阱。',
    parameters: {
      type: 'object',
      properties: {
        formats: {
          type: 'array',
          items: { type: 'string', enum: ['docx', 'pptx', 'xlsx'] },
          description: '指定格式（可多选）。docx=Word文档，pptx=PowerPoint演示文稿，xlsx=Excel电子表格。不传返回概览。',
        },
      },
    },
    handler: (args: any) => {
      const formats = Array.isArray(args?.formats) ? args.formats : undefined
      return { success: true, guide: buildOfficeGuide(workspacePath, formats) }
    },
    source: 'builtin',
  }
}
