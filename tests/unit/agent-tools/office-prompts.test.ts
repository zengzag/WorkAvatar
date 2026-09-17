import { describe, it, expect, vi, beforeEach } from 'vitest'

/** 可控的 Office 模块加载状态（office-prompts 通过 javascript-exec 的模块状态决定输出分支） */
const moduleStatus = vi.hoisted(() => ({
  value: {} as Record<string, { loaded: boolean; error?: string }>,
}))

vi.mock('../../../electron/main/services/agent/tools/javascript-exec.tool', () => ({
  getJavascriptModuleStatus: () => moduleStatus.value,
  javascriptExecTool: { id: 'javascript_exec' },
}))

const { buildOfficeGuide } = await import('../../../electron/main/services/agent/tools/office-prompts')

const ALL_LOADED = {
  docx: { loaded: true },
  pptxgenjs: { loaded: true },
  xlsx: { loaded: true },
  'adm-zip': { loaded: true },
}

describe('agent/tools/office-prompts / buildOfficeGuide', () => {
  beforeEach(() => {
    moduleStatus.value = { ...ALL_LOADED }
  })

  it('无任何 Office 模块时直接返回不可用提示（不带格式清单）', () => {
    moduleStatus.value = {
      docx: { loaded: false, error: 'boom' },
      pptxgenjs: { loaded: false },
      xlsx: { loaded: false },
      'adm-zip': { loaded: false },
    }
    const out = buildOfficeGuide()
    expect(out).toBe('当前环境未加载任何Office文档模块，无法创建或编辑Office文档。')
  })

  it('概览模式（不传 formats）：列出可用格式与引号规则，不含各格式陷阱细节', () => {
    const out = buildOfficeGuide()
    expect(out).toContain('## Office 文档规则与陷阱')
    expect(out).toContain('### 格式选择')
    expect(out).toContain('- **docx** —')
    expect(out).toContain('- **pptx** —')
    expect(out).toContain('- **xlsx** —')
    expect(out).toContain('## 字符串引号（SyntaxError 头号原因）')
    expect(out).not.toContain('## Word (docx) 陷阱')
  })

  it('概览模式按实际加载状态筛选格式（缺 xlsx 时不列出）', () => {
    moduleStatus.value = { docx: { loaded: true }, pptxgenjs: { loaded: false }, xlsx: { loaded: false }, 'adm-zip': { loaded: false } }
    const out = buildOfficeGuide()
    expect(out).toContain('- **docx** —')
    expect(out).not.toContain('- **pptx** —')
    expect(out).not.toContain('- **xlsx** —')
  })

  it('详细模式：formats=docx 输出 Word 陷阱且大小写不敏感', () => {
    const out = buildOfficeGuide(undefined, ['DOCX'])
    expect(out).toContain('## Word (docx) 陷阱')
    expect(out).not.toContain('## PowerPoint (pptx) 陷阱')
    expect(out).not.toContain('## Excel (xlsx) 陷阱')
    expect(out).toContain('## 字符串引号')
  })

  it('详细模式：多格式按 docx → pptx → xlsx 顺序拼接', () => {
    const out = buildOfficeGuide(undefined, ['xlsx', 'docx', 'pptx'])
    const iDocx = out.indexOf('## Word (docx) 陷阱')
    const iPptx = out.indexOf('## PowerPoint (pptx) 陷阱')
    const iXlsx = out.indexOf('## Excel (xlsx) 陷阱')
    expect(iDocx).toBeGreaterThan(-1)
    expect(iDocx).toBeLessThan(iPptx)
    expect(iPptx).toBeLessThan(iXlsx)
  })

  it('adm-zip 缺失时不输出"修改已有文档"段', () => {
    moduleStatus.value = { docx: { loaded: true }, pptxgenjs: { loaded: true }, xlsx: { loaded: true }, 'adm-zip': { loaded: false } }
    const withZip = buildOfficeGuide(undefined, ['docx', 'pptx'])
    expect(withZip).not.toContain('### 修改已有 docx（adm-zip）')
    expect(withZip).not.toContain('### 修改已有 pptx（adm-zip）')

    moduleStatus.value = { ...ALL_LOADED }
    const full = buildOfficeGuide(undefined, ['docx', 'pptx'])
    expect(full).toContain('### 修改已有 docx（adm-zip）')
    expect(full).toContain('### 修改已有 pptx（adm-zip）')
  })

  it('请求了未加载的格式时该格式被跳过，仅保留可用部分', () => {
    moduleStatus.value = { docx: { loaded: true }, pptxgenjs: { loaded: false }, xlsx: { loaded: false }, 'adm-zip': { loaded: true } }
    const out = buildOfficeGuide(undefined, ['docx', 'pptx', 'xlsx'])
    expect(out).toContain('## Word (docx) 陷阱')
    expect(out).not.toContain('## PowerPoint (pptx) 陷阱')
    expect(out).not.toContain('## Excel (xlsx) 陷阱')
  })

  it('formats 全为非法值时进入详细模式但无任何格式段（仅引号规则）', () => {
    const out = buildOfficeGuide(undefined, ['txt', '   '])
    expect(out).toContain('## 字符串引号')
    expect(out).not.toContain('### 格式选择')
    expect(out).not.toContain('## Word (docx) 陷阱')
  })

  it('formats 为空数组时按概览模式处理', () => {
    const out = buildOfficeGuide(undefined, [])
    expect(out).toContain('### 格式选择')
  })

  it('传入 workspacePath 时输出当前工作区', () => {
    const out = buildOfficeGuide('D:\\ws\\task-1')
    expect(out).toContain('当前工作区: `D:\\ws\\task-1`')
  })

  it('工作区字段始终提示删除走 file_delete（避免脚本删除被拒）', () => {
    const out = buildOfficeGuide()
    expect(out).toContain('file_delete')
    expect(out).toContain('### 长文档分步执行（强制规则）')
  })
})
