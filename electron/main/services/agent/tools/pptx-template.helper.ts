/**
 * pptx-template.helper.ts
 *
 * 在 office_exec 沙箱中以 `require('pptx-template')` 暴露的本地模块。
 * 基于 adm-zip 直接操作 OOXML，提供 PPTX 原地编辑能力：
 *   1. inspect：列出各幻灯片的文本内容
 *   2. replaceText：跨幻灯片文本查找替换，保留排版
 *
 * 不引入新的 npm 依赖（adm-zip 已在项目依赖中）。
 *
 * 设计说明：
 * - pptx 文件本质是 ZIP，幻灯片在 ppt/slides/slideN.xml
 * - 文本在 <a:t> 元素中（<a:r> run → <a:t> text）
 * - 同一逻辑文本可能被拆分到多个 run，replaceText 采用直接在单个 <a:t> 内替换的方式
 */

import * as fs from 'fs'
import * as path from 'path'
import AdmZip from 'adm-zip'

// ---------------------------------------------------------------------------
// 类型定义
// ---------------------------------------------------------------------------

export interface SlideInfo {
  /** 幻灯片编号（1-based） */
  slideNumber: number
  /** 幻灯片中所有文本内容（每个 <a:t> 元素一条） */
  texts: string[]
}

interface ReplacePair {
  from: string
  to: string
}

// ---------------------------------------------------------------------------
// 基础工具
// ---------------------------------------------------------------------------

function assertFileExists(p: string): void {
  if (!fs.existsSync(p)) {
    throw new Error(`文件不存在: ${p}`)
  }
}

function escapeXml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
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

// ---------------------------------------------------------------------------
// adm-zip 读写工具
// ---------------------------------------------------------------------------

/** 读取 pptx 内指定 entry 的文本 */
function readEntry(zip: AdmZip, entry: string): string {
  const buf = zip.getEntry(entry)?.getData()
  if (!buf) throw new Error(`pptx 内未找到 ${entry}`)
  return buf.toString('utf8')
}

/** 写入 pptx 内指定 entry 的文本 */
function setEntry(zip: AdmZip, entry: string, content: string): void {
  zip.updateFile(entry, Buffer.from(content, 'utf8'))
}

// ---------------------------------------------------------------------------
// 幻灯片处理工具
// ---------------------------------------------------------------------------

/**
 * 获取 pptx 内所有幻灯片 entry，按编号升序排序。
 * 仅匹配 ppt/slides/slideN.xml。
 */
function getSlideEntries(zip: AdmZip): string[] {
  const entries: { name: string; num: number }[] = []
  for (const entry of zip.getEntries()) {
    const m = entry.entryName.match(/^ppt\/slides\/slide(\d+)\.xml$/)
    if (m) {
      entries.push({ name: entry.entryName, num: parseInt(m[1], 10) })
    }
  }
  entries.sort((a, b) => a.num - b.num)
  return entries.map(e => e.name)
}

/**
 * 从幻灯片 XML 中提取所有 <a:t> 文本内容（反转义）。
 * 自闭合 <a:t/> 不含 </a:t>，自然不会匹配，予以跳过。
 */
function extractTextsFromSlide(xml: string): string[] {
  const texts: string[] = []
  const re = /<a:t>([^<]*)<\/a:t>/g
  let m: RegExpExecArray | null
  while ((m = re.exec(xml)) !== null) {
    texts.push(unescapeXml(m[1]))
  }
  return texts
}

/**
 * 在幻灯片 XML 的 <a:t> 元素内执行查找/替换。
 * 对每个 <a:t> 元素：反转义内容 → 依次应用所有替换 → 若有变化则重新转义并回填。
 * 返回更新后的 XML 与替换发生次数。
 */
function replaceTextInSlide(xml: string, pairs: ReplacePair[]): { xml: string; count: number } {
  if (pairs.length === 0) return { xml, count: 0 }
  let count = 0
  // 匹配 <a:t> 或 <a:t attr="...">，保留开标签属性；自闭合 <a:t/> 不匹配
  const result = xml.replace(
    /<a:t(\s[^>]*)?>([^<]*)<\/a:t>/g,
    (match: string, attrs: string | undefined, rawText: string): string => {
      const text = unescapeXml(rawText)
      let newText = text
      let changed = false
      for (const p of pairs) {
        if (!p.from) continue
        if (newText.includes(p.from)) {
          const occurrences = newText.split(p.from).length - 1
          count += occurrences
          newText = newText.split(p.from).join(p.to)
          changed = true
        }
      }
      if (!changed) return match
      const attrStr = attrs ?? ''
      return `<a:t${attrStr}>${escapeXml(newText)}</a:t>`
    },
  )
  return { xml: result, count }
}

// ---------------------------------------------------------------------------
// 公开 API
// ---------------------------------------------------------------------------

/**
 * 检视 pptx 的幻灯片文本结构，返回每张幻灯片的编号与文本内容列表。
 * 用于编辑前定位需要替换的文本。
 */
export function inspect(pptxPath: string): { slides: SlideInfo[] } {
  assertFileExists(pptxPath)
  const zip = new AdmZip(pptxPath)
  const entries = getSlideEntries(zip)
  const slides: SlideInfo[] = entries.map((entry, idx) => {
    const xml = readEntry(zip, entry)
    const m = entry.match(/slide(\d+)\.xml$/)
    const slideNumber = m ? parseInt(m[1], 10) : idx + 1
    return {
      slideNumber,
      texts: extractTextsFromSlide(xml),
    }
  })
  return { slides }
}

/**
 * 在已有 pptx 上执行跨幻灯片文本查找/替换，保留全部排版。
 * 同时处理幻灯片正文（ppt/slides/slideN.xml）与演讲者备注
 * （ppt/notesSlides/notesSlideN.xml，若存在）。
 *
 * 注意：输出路径不能与输入路径相同（必须创建新文件，不能覆盖原始文件）。
 */
export function replaceText(
  pptxPath: string,
  replacements: Record<string, string>,
  outputPath: string,
): { slidesProcessed: number; replacementsMade: number } {
  assertFileExists(pptxPath)
  if (path.resolve(outputPath) === path.resolve(pptxPath)) {
    throw new Error('输出路径不能与输入路径相同：修改文档必须创建新文件，不能覆盖原始文件。请指定不同的 outputPath。')
  }
  const pairs: ReplacePair[] = Object.entries(replacements).map(([from, to]) => ({
    from,
    to: to == null ? '' : String(to),
  }))

  const zip = new AdmZip(pptxPath)
  let slidesProcessed = 0
  let replacementsMade = 0

  // 处理幻灯片正文
  const slideEntries = getSlideEntries(zip)
  for (const entry of slideEntries) {
    const original = readEntry(zip, entry)
    const { xml: updated, count } = replaceTextInSlide(original, pairs)
    if (updated !== original) setEntry(zip, entry, updated)
    slidesProcessed++
    replacementsMade += count
  }

  // 处理演讲者备注（若存在）
  const notesEntries: { name: string; num: number }[] = []
  for (const entry of zip.getEntries()) {
    const m = entry.entryName.match(/^ppt\/notesSlides\/notesSlide(\d+)\.xml$/)
    if (m) notesEntries.push({ name: entry.entryName, num: parseInt(m[1], 10) })
  }
  notesEntries.sort((a, b) => a.num - b.num)
  for (const { name } of notesEntries) {
    const original = readEntry(zip, name)
    const { xml: updated, count } = replaceTextInSlide(original, pairs)
    if (updated !== original) setEntry(zip, name, updated)
    replacementsMade += count
  }

  zip.writeZip(outputPath)
  return { slidesProcessed, replacementsMade }
}
