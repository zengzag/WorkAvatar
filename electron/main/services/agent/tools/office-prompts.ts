import type { ToolDefinition } from './types'
import { getOfficeModuleStatus } from './office-exec.tool'

function buildOfficeGuide(workspacePath?: string): string {
  const moduleStatus = getOfficeModuleStatus()
  const availableModules = Object.entries(moduleStatus)
    .filter(([, s]) => s.loaded)
    .map(([name]) => name)

  if (availableModules.length === 0) {
    return '当前环境未加载任何Office文档模块，无法创建或编辑Office文档。'
  }

  const parts: string[] = []

  parts.push('## Office文档能力')
  parts.push('你可以使用 `office_exec` 工具在Node.js沙箱中执行JavaScript代码，创建和编辑Office文档。')

  parts.push('\n### 可用模块')
  const moduleDescriptions: Record<string, string> = {
    'docx': '创建Word文档（.docx）',
    'pptxgenjs': '创建PowerPoint演示文稿（.pptx）',
    'xlsx': '创建/编辑Excel电子表格（.xlsx）',
    'adm-zip': 'ZIP压缩/解压（Office文件本质是ZIP）',
  }
  for (const name of availableModules) {
    parts.push(`- \`require("${name}")\` — ${moduleDescriptions[name] || name}`)
  }
  parts.push('- `require("fs")` — 文件系统读写')
  parts.push('- `require("path")` — 路径处理')

  parts.push('\n### 文件保存规则')
  parts.push('**必须使用绝对路径保存文件**，通过 `__workspaceDir` 变量构建路径：')
  parts.push('```javascript')
  parts.push('const fs = require("fs");')
  parts.push('const path = require("path");')
  parts.push('const outputPath = path.join(__workspaceDir, "output.docx");')
  parts.push('fs.writeFileSync(outputPath, buffer);')
  parts.push('console.log("文件已保存:", outputPath);')
  parts.push('```')
  if (workspacePath) {
    parts.push(`当前工作区路径: ${workspacePath}`)
  }

  if (moduleStatus['docx']?.loaded) {
    parts.push('\n### Word文档 (docx) 关键规则')
    parts.push('```javascript')
    parts.push('const { Document, Packer, Paragraph, TextRun, HeadingLevel,')
    parts.push('        LevelFormat, AlignmentType, Table, TableRow, TableCell,')
    parts.push('        WidthType, ShadingType, BorderStyle, ImageRun,')
    parts.push('        Header, Footer, PageNumber, PageBreak } = require("docx");')
    parts.push('')
    parts.push('const doc = new Document({')
    parts.push('  styles: { default: { document: { run: { font: "Arial", size: 24 } } } },')
    parts.push('  numbering: { config: [{')
    parts.push('    reference: "bullets",')
    parts.push('    levels: [{ level: 0, format: LevelFormat.BULLET, text: "\\u2022",')
    parts.push('      alignment: AlignmentType.LEFT,')
    parts.push('      style: { paragraph: { indent: { left: 720, hanging: 360 } } } }]')
    parts.push('  }] },')
    parts.push('  sections: [{')
    parts.push('    properties: {')
    parts.push('      page: { size: { width: 12240, height: 15840 },')
    parts.push('             margin: { top: 1440, right: 1440, bottom: 1440, left: 1440 } }')
    parts.push('    },')
    parts.push('    children: [')
    parts.push('      new Paragraph({ heading: HeadingLevel.HEADING_1,')
    parts.push('        children: [new TextRun("标题")] }),')
    parts.push('      new Paragraph({ numbering: { reference: "bullets", level: 0 },')
    parts.push('        children: [new TextRun("列表项")] }),')
    parts.push('    ]')
    parts.push('  }]')
    parts.push('});')
    parts.push('')
    parts.push('const buffer = await Packer.toBuffer(doc);')
    parts.push('fs.writeFileSync(path.join(__workspaceDir, "output.docx"), buffer);')
    parts.push('```')
    parts.push('**致命陷阱**: ①不用unicode bullet（用LevelFormat.BULLET）②不用\\n换行（用新Paragraph）③PageBreak必须在Paragraph内④ImageRun必须指定type⑤表格用WidthType.DXA不用PERCENTAGE⑥ShadingType.CLEAR不用SOLID⑦务必设置page size（默认A4）')
  }

  if (moduleStatus['pptxgenjs']?.loaded) {
    parts.push('\n### PowerPoint (pptxgenjs) 关键规则')
    parts.push('```javascript')
    parts.push('const pptxgen = require("pptxgenjs");')
    parts.push('const pres = new pptxgen();')
    parts.push('pres.layout = "LAYOUT_16x9";')
    parts.push('')
    parts.push('const slide = pres.addSlide();')
    parts.push('slide.background = { color: "FFFFFF" };')
    parts.push('slide.addText("标题", { x: 0.5, y: 0.3, w: 9, h: 0.8,')
    parts.push('  fontSize: 36, bold: true, color: "333333" });')
    parts.push('')
    parts.push('const outPath = path.join(__workspaceDir, "output.pptx");')
    parts.push('await pres.writeFile({ fileName: outPath });')
    parts.push('```')
    parts.push('**致命陷阱**: ①颜色不加#前缀（"FF0000"而非"#FF0000"）②不用8位hex编码透明度（用opacity属性）③不用unicode bullet（用bullet:true）④多行文本数组项用breakLine:true⑤不要复用option对象（PptxGenJS会修改对象）⑥每张幻灯片需要视觉元素，避免纯文字')
  }

  if (moduleStatus['xlsx']?.loaded) {
    parts.push('\n### Excel (xlsx) 关键规则')
    parts.push('```javascript')
    parts.push('const XLSX = require("xlsx");')
    parts.push('const wb = XLSX.utils.book_new();')
    parts.push('const data = [["姓名","年龄"],["张三",25]];')
    parts.push('const ws = XLSX.utils.aoa_to_sheet(data);')
    parts.push('XLSX.utils.book_append_sheet(wb, ws, "Sheet1");')
    parts.push('const outPath = path.join(__workspaceDir, "output.xlsx");')
    parts.push('XLSX.writeFile(wb, outPath);')
    parts.push('```')
  }

  parts.push('\n### 通用规则')
  parts.push('- 可用模块: docx(Word), pptxgenjs(PPT), xlsx(Excel), adm-zip(ZIP), fs, path, os')
  parts.push('- 全局变量 __workspaceDir 为工作区路径，保存文件必须使用绝对路径')
  parts.push('- 代码支持 async/await')
  parts.push('- 保存文件后用 console.log 输出文件路径，方便确认')
  parts.push('- 代码在沙箱中执行，只能使用上述白名单模块')
  parts.push('- 如遇模块加载错误，检查错误信息中的可用模块列表')
  parts.push('- 执行超时默认60秒，复杂文档可设置更长时间（最大300秒）')

  return parts.join('\n')
}

export function createOfficeGuideTool(workspacePath?: string): ToolDefinition {
  return {
    id: 'office_guide',
    name: 'office_guide',
    title: 'Office文档使用指南',
    description: '获取Office文档（Word/PowerPoint/Excel）创建和编辑的详细使用说明、代码模板和关键陷阱。当你需要创建或编辑.docx/.pptx/.xlsx文件时，先调用此工具获取指南，再使用office_exec执行代码。',
    parameters: {
      type: 'object',
      properties: {},
    },
    handler: () => {
      return { success: true, guide: buildOfficeGuide(workspacePath) }
    },
    source: 'builtin',
  }
}
