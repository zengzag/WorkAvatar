// @vitest-environment jsdom
import { describe, it, expect } from 'vitest'
import { sanitizePluginIconHtml } from '../../../src/utils/sanitize-icon'

describe('utils/sanitize-icon / sanitizePluginIconHtml', () => {
  it('正常 SVG 图标保留（path/属性）', () => {
    const html = '<svg viewBox="0 0 16 16"><path d="M2 8 L8 2" fill="#1677ff" stroke="none"></path></svg>'
    const out = sanitizePluginIconHtml(html)
    expect(out).toContain('<svg viewBox="0 0 16 16">')
    expect(out).toContain('d="M2 8 L8 2"')
    expect(out).toContain('fill="#1677ff"')
  })

  it('事件属性被剥除（onerror/onload/click）', () => {
    const out = sanitizePluginIconHtml('<svg onload="alert(1)"><path d="M0 0" onerror="alert(2)"></path></svg>')
    expect(out).not.toContain('onload')
    expect(out).not.toContain('onerror')
    expect(out).not.toContain('alert')
    expect(out).toContain('d="M0 0"')
  })

  it('script/iframe/img 等非白名单标签被移除', () => {
    expect(sanitizePluginIconHtml('<script>alert(1)</script>')).toBe('')
    expect(sanitizePluginIconHtml('<img src=x onerror=alert(1)>')).toBe('')
    expect(sanitizePluginIconHtml('<iframe src="javascript:alert(1)"></iframe>')).toBe('')
  })

  it('javascript:/data: 属性值被拒', () => {
    const out = sanitizePluginIconHtml('<svg><path d="M0 0" fill="javascript:alert(1)"></path></svg>')
    expect(out).not.toContain('javascript:')
    const out2 = sanitizePluginIconHtml('<svg><a></a></svg>')
    expect(out2).not.toContain('<a')
  })

  it('纯文本/HTML 转义片段返回空（不产生可执行内容）', () => {
    expect(sanitizePluginIconHtml('hello')).toBe('')
    expect(sanitizePluginIconHtml('<b>bold</b>')).toBe('')
  })

  it('非字符串/空值/超长输入返回空串', () => {
    expect(sanitizePluginIconHtml(undefined)).toBe('')
    expect(sanitizePluginIconHtml(null)).toBe('')
    expect(sanitizePluginIconHtml(42 as any)).toBe('')
    expect(sanitizePluginIconHtml('   ')).toBe('')
    expect(sanitizePluginIconHtml('x'.repeat(5000))).toBe('')
  })

  it('嵌套白名单标签保留层级', () => {
    const out = sanitizePluginIconHtml('<svg viewBox="0 0 16 16"><g fill="red"><circle cx="4" cy="4" r="2"></circle></g></svg>')
    expect(out).toContain('<g fill="red">')
    expect(out).toContain('<circle cx="4" cy="4" r="2">')
    expect(out.indexOf('<g')).toBeLessThan(out.indexOf('<circle'))
  })
})
