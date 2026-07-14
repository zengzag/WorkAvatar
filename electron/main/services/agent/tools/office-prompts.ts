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

  const parts: string[] = []

  parts.push('## Office 文档')
  parts.push('用 `office_exec` 在 Node.js 沙箱中执行 JS，创建/编辑 Office 文档。')

  parts.push('\n### 可用模块')
  const moduleDescriptions: Record<string, string> = {
    'docx': '从零创建 Word（.docx）',
    'pptxgenjs': '从零创建 PowerPoint（.pptx）',
    'xlsx': '创建/编辑 Excel（.xlsx），读写已有文件',
    'adm-zip': 'ZIP 压缩/解压 — Office 文件本质是 ZIP，改已有 docx/pptx 用它操作内部 XML',
  }
  for (const name of availableModules) {
    parts.push(`- \`${name}\` — ${moduleDescriptions[name] || name}`)
  }
  parts.push('- `fs` — 只读（readFileSync/readdirSync/statSync）')
  parts.push('- `path` — 路径处理')
  parts.push('- 全局 `file` — **异步写入**（save/append/copy/move/delete/createFolder/exists）')

  parts.push('\n### 文件写入')
  parts.push('**必须用 `file` 对象**，`fs.writeFileSync` 已禁用：')
  parts.push('```js')
  parts.push('await file.save(path.join(__workspaceDir, "out.docx"), buffer);')
  parts.push('```')
  if (workspacePath) {
    parts.push(`工作区: ${workspacePath}`)
  }

  if (!requestedFormats) {
    parts.push('\n### 格式概览')
    parts.push('传 `formats` 获取详细指南（模板+陷阱）：')
    if (moduleStatus['docx']?.loaded) {
      parts.push('- **docx** — Word 文档。`docx` 模块从零创建；`adm-zip` 操作 XML 修改已有文件。`formats: ["docx"]`')
    }
    if (moduleStatus['pptxgenjs']?.loaded) {
      parts.push('- **pptx** — PowerPoint。`pptxgenjs` 从零创建；`adm-zip` 操作 XML 修改已有文件。`formats: ["pptx"]`')
    }
    if (moduleStatus['xlsx']?.loaded) {
      parts.push('- **xlsx** — Excel。创建/修改均用 `xlsx` 模块。`formats: ["xlsx"]`')
    }
    parts.push('')
    parts.push(buildCommonRules())
    return parts.join('\n')
  }

  const fmt = (name: string) => requestedFormats.includes(name)

  if (fmt('docx') && moduleStatus['docx']?.loaded) {
    parts.push(buildDocxGuide(moduleStatus))
  }

  if (fmt('pptx') && moduleStatus['pptxgenjs']?.loaded) {
    parts.push(buildPptxGuide(moduleStatus))
  }

  if (fmt('xlsx') && moduleStatus['xlsx']?.loaded) {
    parts.push(buildXlsxGuide(moduleStatus))
  }

  parts.push(buildCommonRules())

  return parts.join('\n')
}

function buildDocxGuide(moduleStatus: Record<string, { loaded: boolean; error?: string }>): string {
  const parts: string[] = []
  const hasDocx = moduleStatus['docx']?.loaded
  const hasAdmZip = moduleStatus['adm-zip']?.loaded

  parts.push('\n### Word (docx)')

  if (hasDocx) {
    parts.push('')
    parts.push('#### 从零创建（docx 库）')
    parts.push('```js')
    parts.push('const { Document, Packer, Paragraph, TextRun, HeadingLevel, LevelFormat,')
    parts.push('  AlignmentType, Table, TableRow, TableCell, WidthType, ShadingType,')
    parts.push('  ImageRun, PageBreak } = require("docx");')
    parts.push('')
    parts.push('const doc = new Document({')
    parts.push('  numbering: { config: [{ reference: "bullets", levels: [')
    parts.push('    { level: 0, format: LevelFormat.BULLET, text: "\\u2022",')
    parts.push('      alignment: AlignmentType.LEFT,')
    parts.push('      style: { paragraph: { indent: { left: 720, hanging: 360 } } } }')
    parts.push('  ]}]},')
    parts.push('  sections: [{ properties: {')
    parts.push('    page: { size: { width: 12240, height: 15840 },')
    parts.push('           margin: { top: 1440, right: 1440, bottom: 1440, left: 1440 } }')
    parts.push('  }, children: [')
    parts.push('    new Paragraph({ heading: HeadingLevel.HEADING_1, children: [new TextRun("标题")] }),')
    parts.push('    new Paragraph({ numbering: { reference: "bullets", level: 0 }, children: [new TextRun("列表")] }),')
    parts.push('  ]}]')
    parts.push('});')
    parts.push('const buf = await Packer.toBuffer(doc);')
    parts.push('await file.save(path.join(__workspaceDir, "out.docx"), buf);')
    parts.push('```')
    parts.push('**陷阱**:')
    parts.push('- bullet 用 `LevelFormat.BULLET`，不要 unicode')
    parts.push('- 换行用新 `Paragraph`，不要 `\\n`')
    parts.push('- `PageBreak` 必须在 `Paragraph` 内')
    parts.push('- `ImageRun` 必须指定 `type`')
    parts.push('- 表格宽度用 `WidthType.DXA`，不用 PERCENTAGE')
    parts.push('- 底纹用 `ShadingType.CLEAR`，不用 SOLID')
    parts.push('- 务必设置 page size')
  }

  if (hasAdmZip) {
    parts.push('')
    parts.push('#### 修改已有 docx（adm-zip 操作 XML）')
    parts.push('docx = ZIP 包，正文在 `word/document.xml`，页眉页脚在 `word/header*.xml`/`word/footer*.xml`。')
    parts.push('')
    parts.push('**文本替换**（<w:t> 标签内替换，保留排版）：')
    parts.push('```js')
    parts.push('const AdmZip = require("adm-zip");')
    parts.push('const zip = new AdmZip(docxPath);')
    parts.push('')
    parts.push('function replaceInZip(xmlPath, oldText, newText) {')
    parts.push('  let xml = zip.readAsText(xmlPath);')
    parts.push('  // 直接替换 <w:t> 中的文本（文本未被拆分到多个 run 时有效）')
    parts.push('  const before = xml.length;')
    parts.push('  xml = xml.split(oldText).join(newText);')
    parts.push('  if (xml.length === before) return false;')
    parts.push('  zip.updateFile(xmlPath, Buffer.from(xml, "utf-8"));')
    parts.push('  return true;')
    parts.push('}')
    parts.push('')
    parts.push('let count = 0;')
    parts.push('// 同时替换正文和页眉页脚')
    parts.push('count += replaceInZip("word/document.xml", "原文本", "新文本") ? 1 : 0;')
    parts.push('zip.getEntries()')
    parts.push('  .filter(e => /word\\/(header|footer)\\d+\\.xml/.test(e.name))')
    parts.push('  .forEach(e => { count += replaceInZip(e.name, "原文本", "新文本") ? 1 : 0; });')
    parts.push('')
    parts.push('const buf = zip.toBuffer();')
    parts.push('await file.save(outPath, buf);')
    parts.push('```')
    parts.push('**关键陷阱**:')
    parts.push('- **文本可能拆分到多个 `<w:t>`**（如"科技有限公司"被拆成"科技"+"有限"+"公司"三个 run），直接 `replace` 会匹配失败。需先 `console.log(xml.match(/<w:t[^>]*>[^<]*<\\/w:t>/g)?.slice(0,30))` 查看结构')
    parts.push('- 跨 run 合并替换需手动拼接相邻 `<w:t>` 内容再写回，实现复杂；简单场景尽量确保待替换文本在单个 run 内（模板中统一样式输入）')
    parts.push('- 只能替换 `<w:t>` 节点内的文本，**不要删除/修改 XML 标签本身**（会损坏 docx）')
    parts.push('- 始终输出到新文件，禁止覆盖原文件')
    parts.push('- 替换后用 Word 打开验证排版是否正常')
  }

  parts.push('')
  parts.push('**共同陷阱**:')
  parts.push('- 中文文本含引号时用单引号定界：`\'这是"引号"文本\'`，否则 SyntaxError')
  parts.push('- 所有路径用 `path.join(__workspaceDir, ...)`')
  return parts.join('\n')
}

function buildPptxGuide(moduleStatus: Record<string, { loaded: boolean; error?: string }>): string {
  const parts: string[] = []
  const hasPptxgenjs = moduleStatus['pptxgenjs']?.loaded
  const hasAdmZip = moduleStatus['adm-zip']?.loaded

  parts.push('\n### PowerPoint (pptx)')

  if (hasPptxgenjs) {
    parts.push('')
    parts.push('#### 从零创建（pptxgenjs 库）')
    parts.push('```js')
    parts.push('const pptxgen = require("pptxgenjs");')
    parts.push('const pres = new pptxgen();')
    parts.push('pres.layout = "LAYOUT_16x9";')
    parts.push('const slide = pres.addSlide();')
    parts.push('slide.addText("标题", { x: 0.5, y: 0.3, w: 9, h: 0.8,')
    parts.push('  fontSize: 36, bold: true, color: "333333" });')
    parts.push('await pres.writeFile({ fileName: path.join(__workspaceDir, "out.pptx") });')
    parts.push('```')
    parts.push('**陷阱**:')
    parts.push('- 颜色不加 `#` 前缀：`"FF0000"` 非 `"#FF0000"`')
    parts.push('- 透明度用 `opacity` 属性，不用 8 位 hex')
    parts.push('- 项目符号用 `bullet:true`，不用 unicode')
    parts.push('- 多行文本数组项用 `breakLine:true`')
    parts.push('- **不要复用 option 对象**（PptxGenJS 会修改它）')
  }

  if (hasAdmZip) {
    parts.push('')
    parts.push('#### 修改已有 pptx（adm-zip 操作 XML）')
    parts.push('pptx = ZIP 包，幻灯片在 `ppt/slides/slide*.xml`，备注在 `ppt/notesSlides/*.xml`。')
    parts.push('')
    parts.push('**文本替换**（<a:t> 标签内替换，保留排版）：')
    parts.push('```js')
    parts.push('const AdmZip = require("adm-zip");')
    parts.push('const zip = new AdmZip(pptxPath);')
    parts.push('')
    parts.push('const replacements = { "公司名称": "科技有限公司", "2026": "2027" };')
    parts.push('let total = 0;')
    parts.push('')
    parts.push('zip.getEntries()')
    parts.push('  .filter(e => /ppt\\/slides\\/slide\\d+\\.xml/.test(e.name))')
    parts.push('  .forEach(e => {')
    parts.push('    let xml = zip.readAsText(e.name);')
    parts.push('    for (const [old, neo] of Object.entries(replacements)) {')
    parts.push('      const before = xml.length;')
    parts.push('      xml = xml.split(old).join(neo);')
    parts.push('      if (xml.length !== before) total++;')
    parts.push('    }')
    parts.push('    zip.updateFile(e.name, Buffer.from(xml, "utf-8"));')
    parts.push('  });')
    parts.push('')
    parts.push('await file.save(outPath, zip.toBuffer());')
    parts.push('console.log("替换幻灯片数:", total);')
    parts.push('```')
    parts.push('**关键陷阱**:')
    parts.push('- 文本可能拆分到多个 `<a:t>`，直接 `replace` 匹配失败。先 `console.log(xml.match(/<a:t>[^<]*<\\/a:t>/g)?.slice(0,20))` 查看')
    parts.push('- 只能替换 `<a:t>` 节点内的文本，**不要动 XML 结构**')
    parts.push('- 始终输出到新文件')
    parts.push('- 替换后用 PowerPoint 打开验证')
  }

  parts.push('')
  parts.push('**共同陷阱**:')
  parts.push('- 中文文本含引号时用单引号定界，否则 SyntaxError')
  parts.push('- 所有路径用 `path.join(__workspaceDir, ...)`')
  return parts.join('\n')
}

function buildXlsxGuide(moduleStatus: Record<string, { loaded: boolean; error?: string }>): string {
  const parts: string[] = []
  parts.push('\n### Excel (xlsx)')
  parts.push('')
  parts.push('**从零创建**：')
  parts.push('```js')
  parts.push('const XLSX = require("xlsx");')
  parts.push('const wb = XLSX.utils.book_new();')
  parts.push('const ws = XLSX.utils.aoa_to_sheet([["姓名","年龄"],["张三",25]]);')
  parts.push('XLSX.utils.book_append_sheet(wb, ws, "Sheet1");')
  parts.push('await XLSX.writeFile(wb, path.join(__workspaceDir, "out.xlsx"));')
  parts.push('```')
  parts.push('')
  parts.push('**读取/修改已有文件**：')
  parts.push('```js')
  parts.push('const wb = XLSX.readFile(filePath);')
  parts.push('const ws = wb.Sheets[wb.SheetNames[0]];')
  parts.push('ws["A1"] = { t: "s", v: "新标题" };  // t: "s"字符串 / "n"数字 / "b"布尔')
  parts.push('// 追加行：更新 !ref 范围')
  parts.push('const range = XLSX.utils.decode_range(ws["!ref"]);')
  parts.push('const newRow = range.e.r + 1;')
  parts.push('ws[XLSX.utils.encode_cell({ r: newRow, c: 0 })] = { t: "s", v: "王五" };')
  parts.push('ws["!ref"] = XLSX.utils.encode_range({ s: range.s, e: { r: newRow, c: range.e.c } });')
  parts.push('await XLSX.writeFile(wb, outPath);')
  parts.push('```')
  parts.push('**陷阱**:')
  parts.push('- 修改单元格必须指定 `t` 类型')
  parts.push('- 追加行后必须更新 `!ref`')
  parts.push('- `XLSX.readFile` 会丢失公式/图表/样式，仅保留值和基本格式')
  if (moduleStatus['adm-zip']?.loaded) {
    parts.push('- 需完整保留格式时，用 adm-zip 直接操作 `xl/worksheets/sheet*.xml`')
  }
  return parts.join('\n')
}

function buildCommonRules(): string {
  const parts: string[] = []
  parts.push('\n### 通用规则')
  parts.push('- **模块仅在 office_exec 沙箱可用**，shell_exec 无这些模块（会报 Cannot find module）')
  parts.push('- **写入用 `file.save(path, content)`**，`fs.writeFileSync` 已禁用')
  parts.push('- 路径用绝对路径（`path.join(__workspaceDir, ...)`），保存后 console.log 输出')
  parts.push('- 支持 async/await，超时默认 60s（最大 300s）')
  parts.push('')
  parts.push('**字符串引号（SyntaxError 头号原因）**：')
  parts.push('- 优先单引号定界：`\'这是"引号"文本\'`')
  parts.push('- 需要引号时用中文引号 `""` `「」`，或转义 `\\"`，或 Unicode `\\u201C`/`\\u201D`')
  parts.push('- ❌ `"这是"引号"文本"` → SyntaxError')
  return parts.join('\n')
}

export function createOfficeGuideTool(workspacePath?: string): ToolDefinition {
  return {
    id: 'office_guide',
    name: 'office_guide',
    title: 'Office文档使用指南',
    description: '获取Office文档创建和编辑的详细指南（代码模板+关键陷阱）。不传formats返回概览，传formats返回指定格式的详细指南。',
    parameters: {
      type: 'object',
      properties: {
        formats: {
          type: 'array',
          items: { type: 'string', enum: ['docx', 'pptx', 'xlsx'] },
          description: '指定格式（可多选）。docx=Word，pptx=PowerPoint，xlsx=Excel',
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
