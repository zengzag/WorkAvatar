/**
 * 插件图标 HTML 消毒：manifest.icon 来自可 ZIP 导入的第三方插件，
 * 渲染前经白名单（SVG 形状标签 + 无事件属性）重建，杜绝 XSS。
 */
const ALLOWED_TAGS = new Set([
  'svg', 'path', 'circle', 'ellipse', 'rect', 'line', 'polyline', 'polygon', 'g',
])

const ALLOWED_ATTRS = new Set([
  'xmlns', 'viewbox', 'width', 'height', 'd', 'fill', 'fill-opacity', 'fill-rule',
  'stroke', 'stroke-width', 'stroke-opacity', 'stroke-linecap', 'stroke-linejoin',
  'stroke-dasharray', 'opacity', 'transform', 'cx', 'cy', 'r', 'rx', 'ry',
  'x', 'y', 'x1', 'y1', 'x2', 'y2', 'points', 'clip-rule', 'preserveaspectratio',
])

function escapeAttr(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function serializeElement(el: Element): string {
  const tag = el.tagName.toLowerCase()
  if (!ALLOWED_TAGS.has(tag)) return ''
  const attrs: string[] = []
  for (const attr of Array.from(el.attributes)) {
    const name = attr.name.toLowerCase()
    // 拒绝事件属性（on*）、带协议的 URL 属性与未知属性
    if (!ALLOWED_ATTRS.has(name) || name.startsWith('on')) continue
    if (attr.value.trim().toLowerCase().match(/^(javascript|data|vbscript):/)) continue
    attrs.push(`${attr.name}="${escapeAttr(attr.value)}"`)
  }
  const attrText = attrs.length > 0 ? ' ' + attrs.join(' ') : ''
  const children = Array.from(el.childNodes)
    .map(node => (node.nodeType === Node.ELEMENT_NODE ? serializeElement(node as Element) : ''))
    .join('')
  return `<${tag}${attrText}>${children}</${tag}>`
}

export function sanitizePluginIconHtml(html: unknown): string {
  if (typeof html !== 'string' || !html.trim()) return ''
  if (html.length > 4096) return ''
  try {
    const doc = new DOMParser().parseFromString(`<svg-sanitize-root>${html}</svg-sanitize-root>`, 'text/html')
    const root = doc.body.firstChild
    if (!root || root.nodeType !== Node.ELEMENT_NODE) return ''
    return Array.from((root as Element).children)
      .map(child => serializeElement(child))
      .join('')
  } catch {
    return ''
  }
}
