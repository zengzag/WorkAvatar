/**
 * docx-template.helper.ts
 *
 * 在 office_exec 沙箱中以 `require('docx-template')` 暴露的本地模块。
 * 基于 adm-zip 直接操作 OOXML，提供两类 docx 能力：
 *   1. 基于模板生成：保留模板的样式定义/页面设置/页眉页脚，仅替换正文内容
 *   2. 原地编辑：替换占位符/文本/指定段落文本，保留全部排版
 *
 * 不引入新的 npm 依赖（adm-zip 已在项目依赖中）。
 *
 * 设计说明：
 * - docx 文件本质是 ZIP，正文在 word/document.xml，样式在 word/styles.xml，
 *   页眉页脚在 word/header*.xml / word/footer*.xml。
 * - 段落 <w:p> 不可嵌套，可用扫描方式安全提取。
 * - 文本可能被 Word 拆分到多个 <w:t> run 中（同一逻辑文本跨多个 run），
 *   占位符/查找替换采用"合并所有 <w:t> 文本 → 在合并文本上定位 → 回填到 run"的方式处理。
 */

import * as fs from 'fs'
import * as path from 'path'
import AdmZip from 'adm-zip'

// ---------------------------------------------------------------------------
// 类型定义
// ---------------------------------------------------------------------------

export interface TemplateStyle {
  styleId: string
  name: string
  type: string
}

/** 段落直接格式信息（从 <w:pPr> 与首 run 的 <w:rPr> 提取，未通过样式解析） */
export interface ParagraphFormatting {
  /** 字体名（优先 eastAsia，回退 ascii） */
  font?: string
  /** 字号，单位磅（pt），如 16 表示 16pt */
  fontSize?: number
  bold?: boolean
  italic?: boolean
  /** 颜色 hex，如 "FF0000" */
  color?: string
  /** 对齐方式 */
  alignment?: string
}

export interface ParagraphInfo {
  /** 在文档中的顺序索引（含表格内段落），供 setParagraphText / cloneFrom 使用 */
  index: number
  /** 段落样式 ID（来自 <w:pStyle w:val="..."/>），无样式则为 undefined */
  styleId?: string
  /** 段落纯文本（合并所有 <w:t>） */
  text: string
  /** 段落直接格式（字体/字号/加粗/对齐等），用于判断模板是否使用直接格式 */
  formatting: ParagraphFormatting
}

export interface DocBlock {
  /** 段落文本，空字符串表示空段落（用于间距） */
  text: string
  /** 段落样式 ID，应来自 listStyles 返回值，如 "Heading1"、"Normal" */
  style?: string
  /**
   * 从模板的指定段落克隆排版（完整复制其 <w:pPr> 与首 run 的 <w:rPr>），
   * 用于模板使用"直接格式设置"（非命名样式）的场景。
   * 设置 cloneFrom 后，style 字段被忽略；font/fontSize/bold/italic/color
   * 作为 run 级覆盖（任一存在则丢弃克隆的 rPr 改用字段重建）；
   * alignment/pageBreakBefore 仍可覆盖克隆的 pPr。
   */
  cloneFrom?: number
  /** 字体名（同时设置 ascii/hAnsi/eastAsia/cs） */
  font?: string
  /** 字号，单位磅（pt） */
  fontSize?: number
  bold?: boolean
  italic?: boolean
  /** 颜色 hex，如 "FF0000" */
  color?: string
  /** 对齐方式 */
  alignment?: 'left' | 'center' | 'right' | 'both'
  /** 段前分页 */
  pageBreakBefore?: boolean
}

// ---------------------------------------------------------------------------
// XML 工具
// ---------------------------------------------------------------------------

function escapeXml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

function unescapeXml(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
}

/** 文本首尾含空白时需要 xml:space="preserve" 防止 Word 丢弃空格 */
function needsPreserve(text: string): boolean {
  return /^\s|\s$/.test(text)
}

/** 在已有 <w:t ...> 开标签上确保 xml:space="preserve" */
function ensurePreserveSpace(openTag: string, text: string): string {
  if (!needsPreserve(text)) return openTag
  if (/xml:space\s*=/.test(openTag)) return openTag
  // openTag 形如 <w:t> 或 <w:t xml:lang="en">，统一在结尾 '>' 前插入属性
  return openTag.replace(/>$/, ' xml:space="preserve">')
}

interface ParagraphSpan {
  /** 整个 <w:p>...</w:p>（或自闭合 <w:p/>）在 xml 中的起始偏移 */
  start: number
  /** 整个段落在 xml 中的结束偏移（不含） */
  end: number
  /** 开标签后、闭标签前的内容（自闭合时为空） */
  content: string
}

/**
 * 扫描 document.xml 提取所有 <w:p> 段落（含表格内段落），按文档顺序返回。
 * <w:p> 不会嵌套，因此可用"找下一个 </w:p>"的方式安全配对。
 */
function extractParagraphs(xml: string): ParagraphSpan[] {
  const result: ParagraphSpan[] = []
  const re = /<w:p\b/g
  let m: RegExpExecArray | null
  while ((m = re.exec(xml)) !== null) {
    const tagStart = m.index
    const gt = xml.indexOf('>', tagStart)
    if (gt === -1) break
    const openTag = xml.slice(tagStart, gt + 1)
    if (openTag.endsWith('/>')) {
      result.push({ start: tagStart, end: gt + 1, content: '' })
      re.lastIndex = gt + 1
      continue
    }
    const closeIdx = xml.indexOf('</w:p>', gt + 1)
    if (closeIdx === -1) break
    const end = closeIdx + '</w:p>'.length
    result.push({ start: tagStart, end, content: xml.slice(gt + 1, closeIdx) })
    re.lastIndex = end
  }
  return result
}

/** 从段落内容中提取首个 <w:pStyle w:val="..."/> */
function extractParagraphStyle(content: string): string | undefined {
  const m = content.match(/<w:pStyle\s+w:val="([^"]+)"/)
  return m ? m[1] : undefined
}

/** 从段落内容中合并所有 <w:t> 文本（反转义） */
function extractParagraphText(content: string): string {
  const re = /<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>/g
  let m: RegExpExecArray | null
  let text = ''
  while ((m = re.exec(content)) !== null) {
    text += unescapeXml(m[1])
  }
  return text
}

/** 从段落内容中提取首个 <w:rPr>...</w:rPr>（用于保留 run 级排版） */
function extractFirstRunProps(content: string): string | undefined {
  const m = content.match(/<w:rPr>([\s\S]*?)<\/w:rPr>/)
  return m ? m[0] : undefined
}

/** 从段落内容中提取 <w:pPr>...</w:pPr> 原始字符串，无则返回空串 */
function extractPPrString(content: string): string {
  const m = content.match(/<w:pPr>([\s\S]*?)<\/w:pPr>/)
  return m ? m[0] : ''
}

/**
 * 从段落内容提取直接格式信息（<w:pPr> 的对齐 + 首 run 的 <w:rPr> 字体/字号/加粗等）。
 * 注意：仅提取直接格式，不解析样式定义；若段落依赖命名样式，相应字段可能为空。
 */
function extractFormatting(content: string): ParagraphFormatting {
  const pPrMatch = content.match(/<w:pPr>([\s\S]*?)<\/w:pPr>/)
  const pPr = pPrMatch ? pPrMatch[1] : ''
  const rPrMatch = content.match(/<w:rPr>([\s\S]*?)<\/w:rPr>/)
  const rPr = rPrMatch ? rPrMatch[1] : ''

  const alignment = pPr.match(/<w:jc\s+w:val="([^"]+)"/)?.[1]

  let font: string | undefined
  const rFontsMatch = rPr.match(/<w:rFonts\b[^>]*>/)
  if (rFontsMatch) {
    font = rFontsMatch[0].match(/w:eastAsia="([^"]+)"/)?.[1]
      || rFontsMatch[0].match(/w:ascii="([^"]+)"/)?.[1]
  }

  const szMatch = rPr.match(/<w:sz\s+w:val="([^"]+)"/)
  const fontSize = szMatch ? Math.round(parseInt(szMatch[1], 10) / 2) : undefined

  const hasBold = /<w:b\b[^>]*>/.test(rPr)
  const boldOff = /<w:b\b[^>]*w:val="(?:0|false)"/.test(rPr)
  const bold = hasBold && !boldOff ? true : undefined

  const hasItalic = /<w:i\b[^>]*>/.test(rPr)
  const italicOff = /<w:i\b[^>]*w:val="(?:0|false)"/.test(rPr)
  const italic = hasItalic && !italicOff ? true : undefined

  const color = rPr.match(/<w:color\s+w:val="([^"]+)"/)?.[1]

  const fmt: ParagraphFormatting = {}
  if (font) fmt.font = font
  if (fontSize != null) fmt.fontSize = fontSize
  if (bold) fmt.bold = bold
  if (italic) fmt.italic = italic
  if (color) fmt.color = color
  if (alignment) fmt.alignment = alignment
  return fmt
}

// ---------------------------------------------------------------------------
// <w:t> 跨 run 文本替换核心
// ---------------------------------------------------------------------------

interface TextNode {
  /** 开标签 "<w:t ...>" 在 xml 中的起始偏移 */
  tagStart: number
  /** 文本起始偏移（开标签 '>' 之后） */
  textStart: number
  /** 文本结束偏移（'</w:t>' 之前） */
  textEnd: number
  /** 反转义后的逻辑文本 */
  text: string
}

/** 提取 xml 中所有 <w:t>...</w:t> 节点（跳过自闭合 <w:t/>） */
function extractTextNodes(xml: string): TextNode[] {
  const nodes: TextNode[] = []
  const re = /<w:t\b[^>]*>/g
  let m: RegExpExecArray | null
  while ((m = re.exec(xml)) !== null) {
    const tagStart = m.index
    const openTag = m[0]
    if (openTag.endsWith('/>')) continue // 自闭合空文本节点，跳过
    const textStart = tagStart + openTag.length
    const closeIdx = xml.indexOf('</w:t>', textStart)
    if (closeIdx === -1) break
    const textEnd = closeIdx
    nodes.push({
      tagStart,
      textStart,
      textEnd,
      text: unescapeXml(xml.slice(textStart, textEnd)),
    })
    re.lastIndex = closeIdx + '</w:t>'.length
  }
  return nodes
}

interface ReplacePair {
  find: string
  replace: string
}

interface MatchOccurrence {
  /** 在合并文本中的起始偏移 */
  start: number
  /** 在合并文本中的结束偏移（不含） */
  end: number
  value: string
  /** 覆盖的第一个 node 索引 */
  firstNodeIdx: number
  /** 覆盖的最后一个 node 索引 */
  lastNodeIdx: number
}

/**
 * 在 xml 的 <w:t> 文本上执行查找/替换，正确处理跨 run 拆分的情况。
 * 替换值只在匹配覆盖的第一个 run 中写入，其余被覆盖的 run 文本清空，
 * 从而保留首个 run 的 <w:rPr> 排版。
 */
function replaceTextInXml(xml: string, pairs: ReplacePair[]): string {
  const nodes = extractTextNodes(xml)
  if (nodes.length === 0) return xml

  // 合并所有 <w:t> 文本，建立"合并文本字符 → node 索引"映射
  let combined = ''
  const charToNode: number[] = []
  const nodeCStart: number[] = []
  for (let i = 0; i < nodes.length; i++) {
    nodeCStart.push(combined.length)
    for (let j = 0; j < nodes[i].text.length; j++) {
      charToNode.push(i)
    }
    combined += nodes[i].text
  }

  // 收集所有匹配出现位置
  const occurrences: MatchOccurrence[] = []
  for (const p of pairs) {
    if (!p.find) continue
    let idx = combined.indexOf(p.find)
    while (idx !== -1) {
      const end = idx + p.find.length
      occurrences.push({
        start: idx,
        end,
        value: p.replace,
        firstNodeIdx: charToNode[idx] ?? 0,
        lastNodeIdx: end > 0 ? charToNode[end - 1] ?? nodes.length - 1 : charToNode[idx] ?? 0,
      })
      idx = combined.indexOf(p.find, end)
    }
  }
  if (occurrences.length === 0) return xml

  // 按起始位置排序；去重叠（保留先出现的）
  occurrences.sort((a, b) => a.start - b.start)
  const filtered: MatchOccurrence[] = []
  let lastEnd = -1
  for (const o of occurrences) {
    if (o.start >= lastEnd) {
      filtered.push(o)
      lastEnd = o.end
    }
  }

  // 逐 node 重建文本：在原始文本上跳过被覆盖区间，并在首个覆盖 node 插入替换值
  const newTexts: string[] = new Array(nodes.length)
  for (let i = 0; i < nodes.length; i++) {
    const nodeStart = nodeCStart[i]
    const nodeText = nodes[i].text
    const nodeEnd = nodeStart + nodeText.length
    // 覆盖本 node 的匹配（按 start 排序）
    const touching = filtered
      .filter(o => o.firstNodeIdx <= i && o.lastNodeIdx >= i && o.start < nodeEnd && o.end > nodeStart)
      .sort((a, b) => a.start - b.start)

    if (touching.length === 0) {
      newTexts[i] = nodeText
      continue
    }
    let result = ''
    let cursor = 0 // 本 node 原始文本内的局部游标
    for (const o of touching) {
      const localStart = Math.max(0, o.start - nodeStart)
      const localEnd = Math.min(nodeText.length, o.end - nodeStart)
      result += nodeText.slice(cursor, localStart)
      if (i === o.firstNodeIdx) result += o.value
      cursor = localEnd
    }
    result += nodeText.slice(cursor)
    newTexts[i] = result
  }

  // 拼接回 xml：保留每个 <w:t> 开标签，仅在需要时补 xml:space="preserve"
  let out = xml.slice(0, nodes[0].tagStart)
  for (let i = 0; i < nodes.length; i++) {
    const n = nodes[i]
    const openTag = xml.slice(n.tagStart, n.textStart)
    const newOpenTag = ensurePreserveSpace(openTag, newTexts[i])
    out += newOpenTag + escapeXml(newTexts[i]) + '</w:t>'
    const nextTagStart = i + 1 < nodes.length ? nodes[i + 1].tagStart : xml.length
    // n.textEnd 之后紧跟 '</w:t>'（6 字符），跳过它取到下一个 node 之前的间隙
    out += xml.slice(n.textEnd + '</w:t>'.length, nextTagStart)
  }
  return out
}

// ---------------------------------------------------------------------------
// adm-zip 读写工具
// ---------------------------------------------------------------------------

/** 读取 docx 内指定 entry 的文本 */
function readEntry(zip: AdmZip, entry: string): string {
  const buf = zip.getEntry(entry)?.getData()
  if (!buf) throw new Error(`docx 内未找到 ${entry}`)
  return buf.toString('utf8')
}

/** 写入 docx 内指定 entry 的文本 */
function setEntry(zip: AdmZip, entry: string, content: string): void {
  zip.updateFile(entry, Buffer.from(content, 'utf8'))
}

/** 需要执行占位符/文本替换的 entry 列表（正文 + 页眉页脚） */
function getProcessableEntries(zip: AdmZip): string[] {
  const targets: string[] = ['word/document.xml']
  for (const entry of zip.getEntries()) {
    if (/^word\/(header|footer)\d*\.xml$/.test(entry.entryName)) {
      targets.push(entry.entryName)
    }
  }
  return targets
}

function assertFileExists(p: string): void {
  if (!fs.existsSync(p)) {
    throw new Error(`文件不存在: ${p}`)
  }
}

// ---------------------------------------------------------------------------
// 公开 API
// ---------------------------------------------------------------------------

/**
 * 列出 docx 中定义的段落样式（styleId + 名称），供 createFromTemplate 引用。
 */
export function listStyles(docxPath: string): TemplateStyle[] {
  assertFileExists(docxPath)
  const zip = new AdmZip(docxPath)
  const xml = readEntry(zip, 'word/styles.xml')
  const styles: TemplateStyle[] = []
  const re = /<w:style\s+w:type="([^"]+)"\s+w:styleId="([^"]+)"[^>]*>([\s\S]*?)<\/w:style>/g
  let m: RegExpExecArray | null
  while ((m = re.exec(xml)) !== null) {
    const type = m[1]
    const styleId = m[2]
    const body = m[3]
    const nameMatch = body.match(/<w:name\s+w:val="([^"]+)"/)
    styles.push({
      type,
      styleId,
      name: nameMatch ? nameMatch[1] : styleId,
    })
  }
  return styles
}

/**
 * 检视 docx 的段落结构，返回每个段落的索引、样式 ID、文本与直接格式。
 * 用于编辑前定位段落，以及判断模板是否使用直接格式（font/fontSize 非空即直接格式）。
 */
export function inspect(docxPath: string): { paragraphs: ParagraphInfo[] } {
  assertFileExists(docxPath)
  const zip = new AdmZip(docxPath)
  const xml = readEntry(zip, 'word/document.xml')
  const paragraphs = extractParagraphs(xml).map((span, idx) => ({
    index: idx,
    styleId: extractParagraphStyle(span.content),
    text: extractParagraphText(span.content),
    formatting: extractFormatting(span.content),
  }))
  return { paragraphs }
}

/**
 * 基于模板生成 docx：用 {key} 占位符替换填充数据，保留全部排版。
 * 适用于模板中已设计好版式（标题/正文字体字号、页眉页脚等），仅需填入内容。
 *
 * 模板示例（在 Word 中编辑，键入占位符时一次性输入，避免被拆分到多个 run）：
 *   标题：{title}
 *   作者：{author}
 *   日期：{date}
 */
export function renderTemplate(
  templatePath: string,
  data: Record<string, string>,
  outputPath: string,
): void {
  assertFileExists(templatePath)
  if (path.resolve(outputPath) === path.resolve(templatePath)) {
    throw new Error('输出路径不能与模板路径相同：基于模板生成必须创建新文件，不能覆盖原始模板。请指定不同的 outputPath。')
  }
  const pairs: ReplacePair[] = Object.entries(data).map(([k, v]) => ({
    find: `{${k}}`,
    replace: v == null ? '' : String(v),
  }))
  const zip = new AdmZip(templatePath)
  for (const entry of getProcessableEntries(zip)) {
    const original = readEntry(zip, entry)
    const updated = pairs.length ? replaceTextInXml(original, pairs) : original
    if (updated !== original) setEntry(zip, entry, updated)
  }
  zip.writeZip(outputPath)
}

/**
 * 在已有 docx 上执行任意文本查找/替换，保留全部排版。
 * 与 renderTemplate 的区别：find 为任意文本而非 {key} 占位符。
 * 注意：find 文本若跨多个 run（被 Word 拆分），本函数会合并处理。
 */
export function replaceText(
  docxPath: string,
  replacements: Record<string, string>,
  outputPath: string,
): void {
  assertFileExists(docxPath)
  const pairs: ReplacePair[] = Object.entries(replacements).map(([find, replace]) => ({
    find,
    replace: replace == null ? '' : String(replace),
  }))
  const zip = new AdmZip(docxPath)
  for (const entry of getProcessableEntries(zip)) {
    const original = readEntry(zip, entry)
    const updated = pairs.length ? replaceTextInXml(original, pairs) : original
    if (updated !== original) setEntry(zip, entry, updated)
  }
  zip.writeZip(outputPath)
}

/**
 * 替换指定段落的文本，保留段落样式（<w:pPr>）与首个 run 的 run 级排版（<w:rPr>）。
 * paragraphIndex 来自 inspect 返回的 index。
 */
export function setParagraphText(
  docxPath: string,
  paragraphIndex: number,
  newText: string,
  outputPath: string,
): void {
  assertFileExists(docxPath)
  const zip = new AdmZip(docxPath)
  const xml = readEntry(zip, 'word/document.xml')
  const spans = extractParagraphs(xml)
  if (paragraphIndex < 0 || paragraphIndex >= spans.length) {
    throw new Error(`段落索引超出范围：${paragraphIndex}（共 ${spans.length} 段）`)
  }
  const span = spans[paragraphIndex]

  // 保留 <w:pPr>（段落属性：样式、对齐、缩进等）
  const pPrMatch = span.content.match(/<w:pPr>([\s\S]*?)<\/w:pPr>/)
  const pPr = pPrMatch ? pPrMatch[0] : ''
  // 保留首个 run 的 <w:rPr>（字体、字号、加粗等 run 级排版）
  const rPr = extractFirstRunProps(span.content) || ''

  const textTag = needsPreserve(newText)
    ? '<w:t xml:space="preserve">'
    : '<w:t>'
  const newParagraph =
    `<w:p>${pPr}<w:r>${rPr}${textTag}${escapeXml(newText)}</w:t></w:r></w:p>`

  const newXml = xml.slice(0, span.start) + newParagraph + xml.slice(span.end)
  setEntry(zip, 'word/document.xml', newXml)
  zip.writeZip(outputPath)
}

/**
 * 基于模板生成全新 docx：保留模板的 styles.xml / 页面设置 / 页眉页脚，
 * 仅用 blocks 重建正文段落。
 *
 * 每个 block 的排版来源（按优先级）：
 *   1. cloneFrom：从模板指定段落完整克隆 <w:pPr> 与首 run 的 <w:rPr>，
 *      用于模板使用"直接格式设置"（字体字号直接写在 run 上而非命名样式）的场景——
 *      这是 createFromTemplate 能保留直接格式的关键。
 *   2. style：引用 listStyles 返回的命名样式 ID（适用于样式驱动的模板）。
 *   3. font/fontSize/bold/italic/color：直接指定 run 级格式。
 * alignment/pageBreakBefore 在以上任何方式下都可作为覆盖。
 *
 * 重要：本函数始终创建新文件，outputPath 不能与 templatePath 相同（防止覆盖原始模板）。
 *
 * 与 renderTemplate 的区别：renderTemplate 适用于模板结构固定、仅填值；
 * createFromTemplate 适用于正文结构变化（段落数/顺序由代码决定），但希望
 * 每段沿用模板的排版。
 */
export function createFromTemplate(
  templatePath: string,
  blocks: DocBlock[],
  outputPath: string,
): void {
  assertFileExists(templatePath)
  if (path.resolve(outputPath) === path.resolve(templatePath)) {
    throw new Error('输出路径不能与模板路径相同：基于模板生成必须创建新文件，不能覆盖原始模板。请指定不同的 outputPath。')
  }
  const zip = new AdmZip(templatePath)
  const xml = readEntry(zip, 'word/document.xml')

  // 提取 body 内最后的 <w:sectPr>（页面设置：纸张、页边距、页眉页脚引用）
  const sectPr = extractLastSectPr(xml)
  // 提取模板所有段落，供 block.cloneFrom 引用排版
  const templateParagraphs = extractParagraphs(xml)

  // 构建新正文
  const bodyXml = blocks.map(b => buildParagraphXml(b, templateParagraphs)).join('')

  // 定位 <w:body>...</w:body> 并替换其内部内容
  const bodyOpen = matchBodyOpen(xml)
  if (!bodyOpen) {
    throw new Error('模板 document.xml 中未找到 <w:body> 元素')
  }
  const bodyCloseIdx = xml.lastIndexOf('</w:body>')
  if (bodyCloseIdx === -1) {
    throw new Error('模板 document.xml 中未找到 </w:body> 闭合标签')
  }
  const newInner = bodyXml + sectPr
  const newXml = xml.slice(0, bodyOpen.innerStart) + newInner + xml.slice(bodyCloseIdx)

  setEntry(zip, 'word/document.xml', newXml)
  zip.writeZip(outputPath)
}

/**
 * 段落级批量编辑：在指定索引处删除若干段落，并插入新段落。
 * 类似 Array.splice，一步完成「插入 / 删除 / 替换」段落：
 *   - 插入：deleteCount=0，在 startIndex 处插入 insertBlocks
 *   - 删除：insertBlocks=[]，删除从 startIndex 起的 deleteCount 段
 *   - 替换：deleteCount>0 + insertBlocks 非空，删除并插入（段落数可不同）
 *
 * 新插入段落支持 cloneFrom 克隆原文档段落排版（与 createFromTemplate 一致）。
 * 始终输出到新文件，不修改原文档。
 *
 * 适用场景：替换一段为多段、在指定位置插入若干段落、删除若干段落。
 * 这是比 setParagraphText（仅替换单段文本）更强的 API，避免回退到 adm-zip 手动操作 XML。
 */
export function spliceParagraphs(
  docxPath: string,
  startIndex: number,
  deleteCount: number,
  insertBlocks: DocBlock[],
  outputPath: string,
): { originalCount: number; deleted: number; inserted: number; newCount: number } {
  assertFileExists(docxPath)
  if (path.resolve(outputPath) === path.resolve(docxPath)) {
    throw new Error('输出路径不能与输入路径相同：修改文档必须创建新文件，不能覆盖原始文件。请指定不同的 outputPath。')
  }
  const zip = new AdmZip(docxPath)
  const xml = readEntry(zip, 'word/document.xml')
  const spans = extractParagraphs(xml)

  if (!Number.isInteger(startIndex) || startIndex < 0 || startIndex > spans.length) {
    throw new Error(`startIndex 超出范围：${startIndex}（文档共 ${spans.length} 段，合法范围 0~${spans.length}）`)
  }
  if (!Number.isInteger(deleteCount) || deleteCount < 0) {
    throw new Error(`deleteCount 必须为非负整数：${deleteCount}`)
  }
  const actualDelete = Math.min(deleteCount, spans.length - startIndex)
  const blocks = Array.isArray(insertBlocks) ? insertBlocks : []

  // 构建插入段落的 XML（cloneFrom 引用原文档段落索引，spans 即原文档段落）
  const insertXml = blocks.map(b => buildParagraphXml(b, spans)).join('')

  // 计算保留范围的边界：
  // - keepBeforeEnd：删除范围前一段的结束位置（插入点）；startIndex=0 时用 body 内部起始
  // - keepAfterStart：删除范围后第一段的起始位置；删除到末尾时用 body 内部结束（保留 <w:sectPr>）
  const bodyOpen = matchBodyOpen(xml)
  const bodyCloseIdx = xml.lastIndexOf('</w:body>')
  const bodyInnerStart = bodyOpen ? bodyOpen.innerStart : 0
  const bodyInnerEnd = bodyCloseIdx !== -1 ? bodyCloseIdx : xml.length

  const keepBeforeEnd = startIndex > 0 ? spans[startIndex - 1].end : bodyInnerStart
  const keepAfterStart = startIndex + actualDelete < spans.length
    ? spans[startIndex + actualDelete].start
    : bodyInnerEnd

  const newXml = xml.slice(0, keepBeforeEnd) + insertXml + xml.slice(keepAfterStart)

  setEntry(zip, 'word/document.xml', newXml)
  zip.writeZip(outputPath)

  return {
    originalCount: spans.length,
    deleted: actualDelete,
    inserted: blocks.length,
    newCount: spans.length - actualDelete + blocks.length,
  }
}

/**
 * 构建 <w:p>...</w:p> 段落 XML。
 * 排版来源（按优先级）：
 *   1. cloneFrom：从模板指定段落完整克隆 <w:pPr> 与首 run 的 <w:rPr>，
 *      用于模板使用"直接格式设置"（字体字号直接写在 run 上）的场景。
 *   2. style：引用命名样式 ID（适用于样式驱动的模板）。
 *   3. font/fontSize/bold/italic/color：直接指定 run 级格式。
 * alignment/pageBreakBefore 在任何方式下都可作为 pPr 覆盖。
 */
function buildParagraphXml(block: DocBlock, templateParagraphs: ParagraphSpan[]): string {
  let pPr: string
  let rPr: string

  if (block.cloneFrom != null) {
    const src = templateParagraphs[block.cloneFrom]
    if (!src) {
      throw new Error(
        `cloneFrom 段落索引超出范围：${block.cloneFrom}（模板共 ${templateParagraphs.length} 段）`,
      )
    }
    // 完整克隆源段落的 <w:pPr>（含样式、对齐、缩进、行距等）
    pPr = extractPPrString(src.content)
    pPr = applyPPrOverrides(pPr, block.alignment, block.pageBreakBefore)
    // run 级排版：若 block 任一 run 级字段存在则丢弃克隆的 rPr 改用字段重建，
    // 否则直接复用克隆段落的 <w:rPr>（保留直接格式设置）
    rPr = hasRunLevelOverrides(block)
      ? buildRPrFromFields(block)
      : (extractFirstRunProps(src.content) || '')
  } else {
    pPr = buildPPrFromFields(block)
    rPr = buildRPrFromFields(block)
  }

  const text = block.text ?? ''
  const textTag = needsPreserve(text) ? '<w:t xml:space="preserve">' : '<w:t>'
  return `<w:p>${pPr}<w:r>${rPr}${textTag}${escapeXml(text)}</w:t></w:r></w:p>`
}

/** block 是否提供了任一 run 级格式字段（用于决定是否覆盖克隆的 rPr） */
function hasRunLevelOverrides(block: DocBlock): boolean {
  return (
    block.font != null ||
    block.fontSize != null ||
    block.bold != null ||
    block.italic != null ||
    block.color != null
  )
}

/** 从 block 字段构建 <w:rPr>...</w:rPr>，无任何字段时返回空串 */
function buildRPrFromFields(block: DocBlock): string {
  const parts: string[] = []
  if (block.font) {
    // 同时设置 ascii/hAnsi/eastAsia/cs，确保中英文都生效
    const f = escapeXml(block.font)
    parts.push(
      `<w:rFonts w:ascii="${f}" w:hAnsi="${f}" w:eastAsia="${f}" w:cs="${f}"/>`,
    )
  }
  if (block.fontSize != null) {
    // docx 字号单位为半磅，16pt → w:sz w:val="32"
    const halfPt = Math.round(block.fontSize * 2)
    parts.push(`<w:sz w:val="${halfPt}"/>`)
    parts.push(`<w:szCs w:val="${halfPt}"/>`)
  }
  if (block.bold) parts.push('<w:b/>')
  if (block.italic) parts.push('<w:i/>')
  if (block.color) {
    const c = escapeXml(block.color)
    parts.push(`<w:color w:val="${c}"/>`)
  }
  return parts.length ? `<w:rPr>${parts.join('')}</w:rPr>` : ''
}

/** 从 block 字段构建 <w:pPr>...</w:pPr>，无任何字段时返回空串 */
function buildPPrFromFields(block: DocBlock): string {
  const parts: string[] = []
  if (block.style) parts.push(`<w:pStyle w:val="${escapeXml(block.style)}"/>`)
  if (block.alignment) parts.push(`<w:jc w:val="${block.alignment}"/>`)
  if (block.pageBreakBefore) parts.push('<w:pageBreakBefore/>')
  return parts.length ? `<w:pPr>${parts.join('')}</w:pPr>` : ''
}

/**
 * 在已克隆的 <w:pPr>...</w:pPr> 上应用覆盖（alignment / pageBreakBefore）。
 * - alignment：替换或插入 <w:jc>
 * - pageBreakBefore：插入 <w:pageBreakBefore/>
 */
function applyPPrOverrides(
  pPr: string,
  alignment?: 'left' | 'center' | 'right' | 'both',
  pageBreakBefore?: boolean,
): string {
  if (!alignment && !pageBreakBefore) return pPr

  let inner: string
  let isWrapped: boolean
  if (pPr) {
    // 已有 <w:pPr>...</w:pPr>，提取内部内容
    const m = pPr.match(/^<w:pPr>([\s\S]*)<\/w:pPr>$/)
    inner = m ? m[1] : ''
    isWrapped = true
  } else {
    inner = ''
    isWrapped = false
  }

  if (alignment) {
    if (/<w:jc\b[^>]*>/.test(inner)) {
      inner = inner.replace(/<w:jc\b[^>]*\/?>/, `<w:jc w:val="${alignment}"/>`)
    } else {
      inner += `<w:jc w:val="${alignment}"/>`
    }
  }
  if (pageBreakBefore && !/<w:pageBreakBefore\b/.test(inner)) {
    inner += '<w:pageBreakBefore/>'
  }

  return isWrapped ? `<w:pPr>${inner}</w:pPr>` : (inner ? `<w:pPr>${inner}</w:pPr>` : '')
}

/** 提取 xml 中最后一个 <w:sectPr>...</w:sectPr>（含自闭合），找不到返回空串 */
function extractLastSectPr(xml: string): string {
  const re = /<w:sectPr\b/g
  let lastMatch: { start: number; end: number } | null = null
  let m: RegExpExecArray | null
  while ((m = re.exec(xml)) !== null) {
    const start = m.index
    const gt = xml.indexOf('>', start)
    if (gt === -1) break
    const openTag = xml.slice(start, gt + 1)
    if (openTag.endsWith('/>')) {
      lastMatch = { start, end: gt + 1 }
      re.lastIndex = gt + 1
      continue
    }
    const closeIdx = xml.indexOf('</w:sectPr>', gt + 1)
    if (closeIdx === -1) break
    lastMatch = { start, end: closeIdx + '</w:sectPr>'.length }
    re.lastIndex = lastMatch.end
  }
  return lastMatch ? xml.slice(lastMatch.start, lastMatch.end) : ''
}

interface BodyOpen {
  /** <w:body> 开标签结束位置（内部内容起始） */
  innerStart: number
}

/** 匹配 <w:body> 或 <w:body ...>，返回内部内容起始偏移 */
function matchBodyOpen(xml: string): BodyOpen | null {
  const m = xml.match(/<w:body\b[^>]*>/)
  if (!m) return null
  return { innerStart: m.index! + m[0].length }
}
