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

  // 解析 formats 参数：null 表示概览模式（不指定具体格式），返回所有格式的简要说明
  const validFormats = ['docx', 'pptx', 'xlsx', 'docx-template', 'pptx-template']
  const requestedFormats = Array.isArray(formats) && formats.length > 0
    ? formats.map(f => String(f).toLowerCase()).filter(f => validFormats.includes(f))
    : null

  const parts: string[] = []

  parts.push('## Office文档能力')
  parts.push('你可以使用 `office_exec` 工具在Node.js沙箱中执行JavaScript代码，创建和编辑Office文档。')

  parts.push('\n### 可用模块')
  const moduleDescriptions: Record<string, string> = {
    'docx': '创建Word文档（.docx，从零构建）',
    'pptxgenjs': '创建PowerPoint演示文稿（.pptx，从零构建）',
    'xlsx': '创建/编辑Excel电子表格（.xlsx，支持读写已有文件）',
    'adm-zip': 'ZIP压缩/解压（Office文件本质是ZIP）',
    'docx-template': '基于模板生成/原地编辑docx，保留模板排版（字体字号/页眉页脚等）',
    'pptx-template': '原地编辑pptx，跨幻灯片文本查找替换，保留排版',
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

  // 概览模式：返回各格式简要说明，提示用 formats 参数获取详细指南
  if (!requestedFormats) {
    parts.push('\n### 格式概览')
    parts.push('以下格式可用，调用 `office_guide` 并指定 `formats` 参数获取对应格式的详细指南（代码模板+关键陷阱）：')
    if (moduleStatus['docx']?.loaded) {
      parts.push('- **docx** — 从零创建 Word 文档（.docx）。适合无模板的新文档生成。`formats: ["docx"]`')
    }
    if (moduleStatus['docx-template']?.loaded) {
      parts.push('- **docx-template** — 基于模板生成/原地编辑 docx，保留排版（字体字号/页眉页脚/直接格式）。适合按模板格式生成或只改内容不改排版。`formats: ["docx-template"]`')
    }
    if (moduleStatus['pptx-template']?.loaded) {
      parts.push('- **pptx-template** — 原地编辑 pptx，跨幻灯片文本查找替换，保留排版。适合只改 PPT 文字内容不改排版的场景。`formats: ["pptx-template"]`')
    }
    if (moduleStatus['pptxgenjs']?.loaded) {
      parts.push('- **pptx** — 从零创建 PowerPoint 演示文稿（.pptx）。`formats: ["pptx"]`')
    }
    if (moduleStatus['xlsx']?.loaded) {
      parts.push('- **xlsx** — 创建/编辑 Excel 电子表格（.xlsx）。`formats: ["xlsx"]`')
    }
    parts.push('')
    parts.push('可多选：如 `formats: ["docx", "docx-template"]` 同时获取 Word 从零创建和基于模板的详细指南。')
    parts.push('')
    parts.push(buildCommonRules(moduleStatus))
    return parts.join('\n')
  }

  // 详细模式：只返回指定格式的详细指南
  const fmt = (name: string) => requestedFormats.includes(name)

  if (fmt('docx') && moduleStatus['docx']?.loaded) {
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

  if (fmt('docx-template') && moduleStatus['docx-template']?.loaded) {
    parts.push('\n### 基于模板生成 / 原地编辑 docx（docx-template）')
    parts.push('`require("docx")` 只能从零创建文档，无法复用已有 docx 的排版。当需求是「按模板排版生成」或「只改内容不改排版」时，**必须优先**使用 `require("docx-template")`，它直接操作 OOXML，保留模板的样式定义/页面设置/页眉页脚/直接格式。')
    parts.push('')
    parts.push('**⚠️ 关键：判断模板类型（决定使用 style 还是 cloneFrom）**')
    parts.push('用户提供的"模板"通常是普通 docx，可能用两种方式设置排版：')
    parts.push('- **命名样式驱动**：段落通过 `<w:pStyle>` 引用 styles.xml 中定义的样式（如 Heading1/Normal）→ 用 `style` 字段引用')
    parts.push('- **直接格式设置**：段落字体字号直接写在 run 的 `<w:rPr>` 上（如仿宋_GB2312三号、黑体三号），未通过样式名映射 → **必须用 `cloneFrom` 克隆模板段落的完整排版**')
    parts.push('')
    parts.push('**判断方法**：调用 `inspect(templatePath)`，查看返回的 `paragraphs[].formatting`：')
    parts.push('- 若 `formatting.font` / `formatting.fontSize` 有值 → 模板使用**直接格式设置**，createFromTemplate 的 `style` 字段无效，必须用 `cloneFrom`')
    parts.push('- 若 `formatting` 为空对象且 `styleId` 有值 → 模板使用**命名样式驱动**，可用 `style` 字段引用 styleId')
    parts.push('```javascript')
    parts.push('const tpl = require("docx-template");')
    parts.push('const path = require("path");')
    parts.push('const tplPath = path.join(__workspaceDir, "template.docx");')
    parts.push('const info = tpl.inspect(tplPath);')
    parts.push('// 查看每段的样式与直接格式')
    parts.push('info.paragraphs.forEach(p => {')
    parts.push('  const fmt = p.formatting;')
    parts.push('  const direct = fmt.font || fmt.fontSize ? "直接格式" : "命名样式";')
    parts.push('  console.log(`#${p.index} [${direct}] styleId=${p.styleId||"无"} ` +')
    parts.push('    `font=${fmt.font||"-"} size=${fmt.fontSize||"-"} bold=${fmt.bold||"-"} ` +')
    parts.push('    `text="${p.text.slice(0,30)}"`);')
    parts.push('});')
    parts.push('```')
    parts.push('')
    parts.push('**场景一：模板填值（结构固定，仅替换内容）** — 模板中用 `{key}` 占位符，调用 renderTemplate 填充。**适合两种模板类型**（占位符替换不依赖样式机制）：')
    parts.push('```javascript')
    parts.push('const tpl = require("docx-template");')
    parts.push('const path = require("path");')
    parts.push('// 模板里已写好：标题：{title} / 作者：{author} / 日期：{date}')
    parts.push('tpl.renderTemplate(')
    parts.push('  path.join(__workspaceDir, "template.docx"),')
    parts.push('  { title: "2026年度报告", author: "张三", date: "2026-07-08" },')
    parts.push('  path.join(__workspaceDir, "report.docx")  // ⚠️ 必须与模板路径不同')
    parts.push(');')
    parts.push('console.log("已基于模板生成:", path.join(__workspaceDir, "report.docx"));')
    parts.push('```')
    parts.push('提示：在 Word 中编辑模板时，每个 `{key}` 占位符要一次性连续输入完成，不要中途切换格式，否则 Word 可能把占位符拆分到多个 run（虽能处理但建议避免）。')
    parts.push('')
    parts.push('**场景二A：命名样式模板生成新文档** — 模板用命名样式驱动（inspect 返回 formatting 为空），用 `style` 引用 listStyles 的 styleId：')
    parts.push('```javascript')
    parts.push('const tpl = require("docx-template");')
    parts.push('const path = require("path");')
    parts.push('const tplPath = path.join(__workspaceDir, "template.docx");')
    parts.push('const styles = tpl.listStyles(tplPath);')
    parts.push('console.log("可用样式:", styles.map(s => s.styleId + "(" + s.name + ")").join(", "));')
    parts.push('tpl.createFromTemplate(tplPath, [')
    parts.push('  { text: "项目周报", style: "Title", alignment: "center" },')
    parts.push('  { text: "一、本周进展", style: "Heading1" },')
    parts.push('  { text: "完成了 docx 模板生成功能。", style: "Normal" },')
    parts.push('  { text: "", style: "Normal" }, // 空段落做间距')
    parts.push('  { text: "二、下周计划", style: "Heading1", pageBreakBefore: true },')
    parts.push('  { text: "推进 Excel 模板能力。", style: "Normal", bold: true },')
    parts.push('], path.join(__workspaceDir, "weekly.docx"));  // ⚠️ 必须与模板路径不同')
    parts.push('```')
    parts.push('')
    parts.push('**场景二B：直接格式模板生成新文档（推荐，适用于普通 docx 模板）** — 模板用直接格式设置（inspect 返回 formatting.font/fontSize 有值），用 `cloneFrom` 克隆模板段落的完整 `<w:pPr>` + `<w:rPr>`：')
    parts.push('```javascript')
    parts.push('const tpl = require("docx-template");')
    parts.push('const path = require("path");')
    parts.push('const tplPath = path.join(__workspaceDir, "template.docx");')
    parts.push('const info = tpl.inspect(tplPath);')
    parts.push('// 假设 inspect 显示：#0 是封面标题（方正小标宋二号），#1 是正文（仿宋_GB2312三号）')
    parts.push('// 找到各种排版对应的模板段落索引')
    parts.push('const coverIdx = 0;    // 封面标题段落索引')
    parts.push('const bodyIdx = 1;     // 正文段落索引')
    parts.push('const headingIdx = 2;  // 一级标题段落索引')
    parts.push('')
    parts.push('tpl.createFromTemplate(tplPath, [')
    parts.push('  // cloneFrom 完整克隆模板段落的字体字号对齐等，text 替换为新内容')
    parts.push('  { text: "关于AI智能体对办公影响的报告", cloneFrom: coverIdx, alignment: "center" },')
    parts.push('  { text: "", cloneFrom: bodyIdx },  // 空段落做间距，沿用正文排版')
    parts.push('  { text: "一、概述", cloneFrom: headingIdx },')
    parts.push('  { text: "AI智能体是具备感知、规划、记忆与工具调用能力的智能系统。", cloneFrom: bodyIdx },')
    parts.push('  { text: "", cloneFrom: bodyIdx },')
    parts.push('  { text: "二、技术架构", cloneFrom: headingIdx, pageBreakBefore: true },')
    parts.push('  { text: "智能体技术由LLM、感知模块、规划模块、记忆模块与工具链组成。", cloneFrom: bodyIdx },')
    parts.push('], path.join(__workspaceDir, "report.docx"));  // ⚠️ 必须与模板路径不同')
    parts.push('console.log("已生成:", path.join(__workspaceDir, "report.docx"));')
    parts.push('```')
    parts.push('cloneFrom 的优先级高于 style；设置 cloneFrom 后：①完整克隆模板段落的 `<w:pPr>`（样式/对齐/缩进/行距）②克隆首 run 的 `<w:rPr>`（字体字号加粗）③若 block 同时提供 font/fontSize/bold/italic/color 任一字段，则丢弃克隆的 rPr 改用字段重建 run 级排版④alignment/pageBreakBefore 作为 pPr 覆盖叠加。')
    parts.push('')
    parts.push('**场景三：原地修改已有 docx（保留排版）** — 先 inspect 定位段落，再修改。**始终输出到新文件**，避免破坏原文档。按修改类型选择 API：')
    parts.push('- **文本级替换**（不改段落数）：用 `replaceText`（任意文本查找替换）')
    parts.push('- **单段文本替换**（不改段落数）：用 `setParagraphText`（按段落 index 替换整段文本）')
    parts.push('- **段落级编辑**（插入/删除/替换多段）：用 `spliceParagraphs`（**推荐，一步完成，不要回退到 adm-zip 手动操作 XML**）')
    parts.push('```javascript')
    parts.push('const tpl = require("docx-template");')
    parts.push('const path = require("path");')
    parts.push('const docPath = path.join(__workspaceDir, "contract.docx");')
    parts.push('const outPath = path.join(__workspaceDir, "contract_revised.docx");')
    parts.push('')
    parts.push('// 方式A：文本查找替换（任意文本，保留排版，不改段落数）')
    parts.push('tpl.replaceText(docPath, {')
    parts.push('  "甲方：原公司": "甲方：新公司",')
    parts.push('  "2026-01-01": "2026-07-08",')
    parts.push('}, outPath);')
    parts.push('')
    parts.push('// 方式B：按段落索引替换整段文本（保留段落样式与首 run 字体字号，不改段落数）')
    parts.push('const info = tpl.inspect(docPath);')
    parts.push('console.log("段落列表:", info.paragraphs.map(p => p.index + ":[" + (p.styleId||"") + "]" + p.text.slice(0,30)).join("\\n"));')
    parts.push('tpl.setParagraphText(docPath, 0, "新的合同标题", outPath);')
    parts.push('```')
    parts.push('')
    parts.push('**场景四：段落级编辑（插入/删除/替换多段，保留排版）** — 用 `spliceParagraphs`，类似 Array.splice。**当需要把一段拆成多段、在中间插入新段落、删除若干段落时，必须用此 API，不要用 adm-zip 手动操作 XML**：')
    parts.push('```javascript')
    parts.push('const tpl = require("docx-template");')
    parts.push('const path = require("path");')
    parts.push('const docPath = path.join(__workspaceDir, "report.docx");')
    parts.push('const outPath = path.join(__workspaceDir, "report_revised.docx");')
    parts.push('const info = tpl.inspect(docPath);')
    parts.push('// 假设 inspect 显示：#109 是"阶段四"标题，#110 是原描述段落，#111 是"阶段五"')
    parts.push('// 需求：把 #110 原描述段落替换为 4 个子步骤（每个子步骤=标题段+正文段，共8段）')
    parts.push('// 先找到一个子步骤标题段和正文段作为 cloneFrom 模板（如 #50 是"3.1 状态表示"标题，#51 是其正文）')
    parts.push('const subHeadingIdx = 50;  // 子步骤标题段落索引（克隆其排版）')
    parts.push('const subBodyIdx = 51;     // 子步骤正文段落索引（克隆其排版）')
    parts.push('')
    parts.push('const result = tpl.spliceParagraphs(docPath, 110, 1, [  // 从 #110 开始删 1 段，插入 8 段')
    parts.push('  { text: "4.1 状态表示", cloneFrom: subHeadingIdx },')
    parts.push('  { text: "用 R_best 表示最优状态。", cloneFrom: subBodyIdx },')
    parts.push('  { text: "4.2 动作选择", cloneFrom: subHeadingIdx },')
    parts.push('  { text: "根据 ε-greedy 策略选择动作。", cloneFrom: subBodyIdx },')
    parts.push('  { text: "4.3 奖励函数", cloneFrom: subHeadingIdx },')
    parts.push('  { text: "奖励 r = α·准确率 + β·效率。", cloneFrom: subBodyIdx },')
    parts.push('  { text: "4.4 状态转移", cloneFrom: subHeadingIdx },')
    parts.push('  { text: "状态根据动作更新为新状态。", cloneFrom: subBodyIdx },')
    parts.push('], outPath);')
    parts.push('console.log(`原 ${result.originalCount} 段 → 删 ${result.deleted} 段 + 插 ${result.inserted} 段 → 新 ${result.newCount} 段`);')
    parts.push('')
    parts.push('// 纯插入：在 #109 后插入 2 段（startIndex=110, deleteCount=0）')
    parts.push('// tpl.spliceParagraphs(docPath, 110, 0, [{text:"新段落",cloneFrom:51}], outPath);')
    parts.push('')
    parts.push('// 纯删除：删除 #110-#112 共 3 段（startIndex=110, deleteCount=3, insertBlocks=[]）')
    parts.push('// tpl.spliceParagraphs(docPath, 110, 3, [], outPath);')
    parts.push('```')
    parts.push('spliceParagraphs 一步完成删除+插入，保留未修改段落的完整排版；插入的新段落通过 cloneFrom 克隆原文档段落排版。返回 `{originalCount, deleted, inserted, newCount}` 便于验证。')
    parts.push('')
    parts.push('**docx-template API 速查**：')
    parts.push('- `listStyles(docxPath)` → `[{styleId, name, type}]`，列出模板/文档中定义的命名样式')
    parts.push('- `inspect(docxPath)` → `{paragraphs:[{index, styleId, text, formatting}]}`，列出段落结构（index 含表格内段落）；`formatting` 含 `{font, fontSize, bold, italic, color, alignment}`，用于判断模板是否使用直接格式')
    parts.push('- `renderTemplate(templatePath, {key:value}, outputPath)` → `{key}` 占位符替换，保留全部排版；适合两种模板类型')
    parts.push('- `createFromTemplate(templatePath, blocks, outputPath)` → 保留模板样式/页面/页眉页脚，用 blocks 重建正文')
    parts.push('  - block 字段：`{text, style?, cloneFrom?, font?, fontSize?, bold?, italic?, color?, alignment?("left"|"center"|"right"|"both"), pageBreakBefore?}`')
    parts.push('  - `cloneFrom`：从模板指定 index 段落克隆完整 `<w:pPr>`+`<w:rPr>`，**直接格式模板必须用此字段**')
    parts.push('  - `style`：引用命名样式 ID（直接格式模板无效）')
    parts.push('  - `font/fontSize/bold/italic/color`：直接指定 run 级格式（fontSize 单位磅 pt）')
    parts.push('- `replaceText(docxPath, {old:new}, outputPath)` → 任意文本查找替换，保留排版（文本级，不改段落数）')
    parts.push('- `setParagraphText(docxPath, paragraphIndex, newText, outputPath)` → 替换指定段落文本，保留段落样式与首 run 排版（单段文本级，不改段落数）')
    parts.push('- `spliceParagraphs(docxPath, startIndex, deleteCount, insertBlocks, outputPath)` → **段落级批量编辑**（插入/删除/替换多段），保留未修改段落排版，插入段落支持 cloneFrom；返回 `{originalCount, deleted, inserted, newCount}`')
    parts.push('**关键原则**: ①所有路径用绝对路径（path.join(__workspaceDir, ...)）②**outputPath 不能与模板/输入路径相同**（基于模板生成必须创建新文件，禁止覆盖原始模板）③renderTemplate/replaceText 同时处理正文与页眉页脚④createFromTemplate 不会保留模板正文原有内容，仅保留样式/页面/页眉页脚⑤文本含首尾空格时自动补 xml:space="preserve"⑥**遇到普通 docx 模板先用 inspect 判断是否直接格式，是则用 cloneFrom 而非 style**⑦**需要插入/删除/替换多段时用 spliceParagraphs，不要用 adm-zip 手动操作 XML**⑧**操作顺序**：先 inspect 定位段落 → 选 API（文本级用 replaceText/setParagraphText，段落级用 spliceParagraphs）→ 输出到新文件 → inspect 验证')
  }

  if (fmt('pptx-template') && moduleStatus['pptx-template']?.loaded) {
    parts.push('\n### 原地编辑 pptx（pptx-template）')
    parts.push('`require("pptxgenjs")` 只能从零创建演示文稿，无法读取/修改已有 pptx。当需求是「只改 PPT 文字内容不改排版」时，使用 `require("pptx-template")`，它直接操作 OOXML，跨幻灯片查找替换文本，保留字体/字号/颜色/动画等全部排版。')
    parts.push('')
    parts.push('**API 速查**：')
    parts.push('- `inspect(pptxPath)` → `{slides:[{slideNumber, texts:[...]}]}`，列出各幻灯片的文本内容')
    parts.push('- `replaceText(pptxPath, {old:new}, outputPath)` → 跨幻灯片文本查找替换，保留排版；同时处理幻灯片与演讲者备注；返回 `{slidesProcessed, replacementsMade}`')
    parts.push('')
    parts.push('**场景一：查看 PPT 文本结构** — 先 inspect 了解各幻灯片的文本内容，定位需要替换的文字：')
    parts.push('```javascript')
    parts.push('const tpl = require("pptx-template");')
    parts.push('const path = require("path");')
    parts.push('const pptxPath = path.join(__workspaceDir, "presentation.pptx");')
    parts.push('const info = tpl.inspect(pptxPath);')
    parts.push('info.slides.forEach(s => {')
    parts.push('  console.log(`--- 第 ${s.slideNumber} 页 ---`);')
    parts.push('  s.texts.forEach((t, i) => console.log(`  [${i}] ${t}`));')
    parts.push('});')
    parts.push('```')
    parts.push('')
    parts.push('**场景二：批量文本替换（保留排版）** — 替换 PPT 中的文字内容，不改变任何排版。**始终输出到新文件**：')
    parts.push('```javascript')
    parts.push('const tpl = require("pptx-template");')
    parts.push('const path = require("path");')
    parts.push('const result = tpl.replaceText(')
    parts.push('  path.join(__workspaceDir, "template.pptx"),')
    parts.push('  {')
    parts.push('    "公司名称": "科技有限公司",')
    parts.push('    "2026年度": "2027年度",')
    parts.push('    "张三": "李四",')
    parts.push('  },')
    parts.push('  path.join(__workspaceDir, "presentation_updated.pptx")  // ⚠️ 必须与输入路径不同')
    parts.push(');')
    parts.push('console.log(`处理 ${result.slidesProcessed} 页，替换 ${result.replacementsMade} 处`);')
    parts.push('```')
    parts.push('**关键原则**: ①所有路径用绝对路径 ②**outputPath 不能与输入路径相同**（禁止覆盖原始文件）③replaceText 在 `<a:t>` 元素内替换文本，保留 run 级排版 ④同一段文本被拆分到多个 run 时，只替换完整匹配的单个 `<a:t>` 内容 ⑤同时处理幻灯片与演讲者备注（notesSlides）')
  }

  if (fmt('pptx') && moduleStatus['pptxgenjs']?.loaded) {
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

  if (fmt('xlsx') && moduleStatus['xlsx']?.loaded) {
    parts.push('\n### Excel (xlsx) 关键规则')
    parts.push('xlsx 库支持从零创建和读取/修改已有文件。')
    parts.push('')
    parts.push('**场景一：从零创建新 Excel**：')
    parts.push('```javascript')
    parts.push('const XLSX = require("xlsx");')
    parts.push('const wb = XLSX.utils.book_new();')
    parts.push('const data = [["姓名","年龄"],["张三",25]];')
    parts.push('const ws = XLSX.utils.aoa_to_sheet(data);')
    parts.push('XLSX.utils.book_append_sheet(wb, ws, "Sheet1");')
    parts.push('const outPath = path.join(__workspaceDir, "output.xlsx");')
    parts.push('XLSX.writeFile(wb, outPath);')
    parts.push('```')
    parts.push('')
    parts.push('**场景二：读取/修改已有 Excel（保留其他数据）** — 读取已有文件 → 修改单元格 → 保存：')
    parts.push('```javascript')
    parts.push('const XLSX = require("xlsx");')
    parts.push('const path = require("path");')
    parts.push('const filePath = path.join(__workspaceDir, "existing.xlsx");')
    parts.push('')
    parts.push('// 读取已有文件')
    parts.push('const wb = XLSX.readFile(filePath);')
    parts.push('const ws = wb.Sheets[wb.SheetNames[0]];  // 取第一个工作表')
    parts.push('')
    parts.push('// 修改单元格（保留其他单元格不变）')
    parts.push('ws["A1"] = { t: "s", v: "新标题" };  // t:"s" 字符串, t:"n" 数字')
    parts.push('ws["B2"] = { t: "n", v: 42 };')
    parts.push('')
    parts.push('// 追加新行：找到最后一行，在其后追加')
    parts.push('const range = XLSX.utils.decode_range(ws["!ref"]);')
    parts.push('const newRow = range.e.r + 1;  // 新行号')
    parts.push('ws[XLSX.utils.encode_cell({ r: newRow, c: 0 })] = { t: "s", v: "王五" };')
    parts.push('ws[XLSX.utils.encode_cell({ r: newRow, c: 1 })] = { t: "n", v: 30 };')
    parts.push('ws["!ref"] = XLSX.utils.encode_range({ s: range.s, e: { r: newRow, c: range.e.c } });')
    parts.push('')
    parts.push('const outPath = path.join(__workspaceDir, "modified.xlsx");')
    parts.push('XLSX.writeFile(wb, outPath);')
    parts.push('console.log("已修改并保存:", outPath);')
    parts.push('```')
    parts.push('**关键陷阱**: ①修改单元格时需指定类型 `t`（"s" 字符串 / "n" 数字 / "b" 布尔）②追加行后需更新 `!ref` 范围③`XLSX.readFile` 会丢失部分格式（如公式、图表、样式），仅保留值和基本格式④如需完整保留格式，用 adm-zip 直接操作 xl/worksheets/sheet*.xml（类似 docx-template 的方式）')
  }

  parts.push(buildCommonRules(moduleStatus))

  return parts.join('\n')
}

/** 通用规则（概览模式和详细模式都包含） */
function buildCommonRules(
  moduleStatus: Record<string, { loaded: boolean; error?: string }>,
): string {
  const parts: string[] = []
  parts.push('\n### 通用规则')
  parts.push('- 可用模块: docx(Word从零创建), docx-template(基于模板生成/原地编辑docx保留排版), pptx-template(原地编辑pptx保留排版), pptxgenjs(PPT从零创建), xlsx(Excel创建/修改), adm-zip(ZIP), fs, path, os')
  parts.push('- **这些模块只在 `office_exec` 沙箱中可用，`shell_exec` 的 Node 环境未安装这些模块**。操作 Office 文件必须用 `office_exec`，不要用 `shell_exec` 调用 node + require("docx-template")（会报 Cannot find module）')
  parts.push('- 全局变量 __workspaceDir 为工作区路径，保存文件必须使用绝对路径')
  parts.push('- 代码支持 async/await')
  parts.push('- 保存文件后用 console.log 输出文件路径，方便确认')
  parts.push('- 代码在沙箱中执行，只能使用上述白名单模块')
  parts.push('- 如遇模块加载错误，检查错误信息中的可用模块列表')
  parts.push('- 执行超时默认60秒，复杂文档可设置更长时间（最大300秒）')
  parts.push('- **操作顺序**：先 `office_guide`（不传 formats 获取概览，或传 formats 获取详细指南）→ 再选工具')
  parts.push('- 选择模块：从零创建新文档用 docx/pptxgenjs/xlsx；基于已有 docx 模板生成或只改内容不改排版用 docx-template；只改 PPT 文字内容用 pptx-template；读取/修改已有 Excel 用 xlsx.readFile')
  if (moduleStatus['docx-template']?.loaded) {
    parts.push('- **基于模板生成时，outputPath 必须与模板路径不同（创建新文件，禁止覆盖原始模板）**')
    parts.push('- **使用 docx-template 前，先用 inspect 判断模板类型**：formatting.font/fontSize 有值→直接格式模板→用 cloneFrom；formatting 为空→命名样式模板→用 style')
    parts.push('- **修改文档时按修改类型选 API**：文本级替换用 replaceText/setParagraphText；段落级编辑（插入/删除/替换多段）用 spliceParagraphs。**不要用 adm-zip 手动操作 XML**（易损坏 docx）')
  }
  if (moduleStatus['pptx-template']?.loaded) {
    parts.push('- **pptx-template 只支持文本替换（replaceText），不支持插入/删除幻灯片**。如需从零创建用 pptxgenjs')
  }
  return parts.join('\n')
}

export function createOfficeGuideTool(workspacePath?: string): ToolDefinition {
  return {
    id: 'office_guide',
    name: 'office_guide',
    title: 'Office文档使用指南',
    description: '获取Office文档（Word/PowerPoint/Excel）创建和编辑的详细使用说明、代码模板和关键陷阱。支持按格式获取详细指南。不传 formats 参数返回概览（含各格式简要说明）；传 formats 参数返回指定格式的详细指南（代码模板+关键陷阱）。建议先不传 formats 获取概览，再按需传 formats 获取详细指南。',
    parameters: {
      type: 'object',
      properties: {
        formats: {
          type: 'array',
          items: { type: 'string', enum: ['docx', 'pptx', 'xlsx', 'docx-template', 'pptx-template'] },
          description: '指定要获取详细指南的格式（可多选）。不传则返回所有格式的概览。可选值：docx(Word从零创建)、docx-template(基于模板/原地编辑docx保留排版)、pptx-template(原地编辑pptx保留排版)、pptx(PowerPoint从零创建)、xlsx(Excel创建/修改)。如需同时获取多种格式：["docx","docx-template"]',
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
