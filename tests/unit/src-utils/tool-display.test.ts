import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest'

/**
 * src/utils/tool-display：工具文案多级回退
 * 1) 插件命名空间 toolNames.<name> → 2) title 本身是插件 i18n key（旧模式）
 * 3) 宿主 workbench.toolNames.<name> / workbench.toolDescriptions.<name> → 4) 兜底 title → 5) 工具原名
 * 依赖 mock：../i18n（可控翻译表）与 window.electronAPI.tool.listBuiltin
 */

const i18nTable: Record<string, string> = {
  'translation:workbench.toolNames.file_read': '读取文件',
  'translation:workbench.toolNames.only_host': '仅宿主有',
  'translation:workbench.toolDescriptions.file_read': '读取文件说明',
  'demo:toolNames.plug_tool': '插件工具名',
  'demo:toolDescriptions.plug_tool': '插件工具说明',
  'demo:hello-world': '你好世界',
}

const i18nT = vi.fn((key: string, opts?: { ns?: string; defaultValue?: string }) => {
  const ns = opts?.ns ?? 'translation'
  const hit = i18nTable[`${ns}:${key}`]
  if (hit !== undefined) return hit
  return opts?.defaultValue ?? key
})

vi.mock('../../../src/i18n', () => ({ default: { t: i18nT } }))

const catalog = [
  { name: 'file_read', title: '后端标题', pluginId: undefined },
  { name: 'plug_tool', title: '后端插件标题', pluginId: 'demo' },
  { name: 'mcp_remote_tool', title: 'MCP 工具标题' },
]

const listBuiltin = vi.fn(async () => catalog)

vi.stubGlobal('window', { electronAPI: { tool: { listBuiltin } } })

const {
  loadToolDisplayNames,
  resolveToolLabel,
  resolveToolDescription,
  getToolDisplayName,
} = await import('../../../src/utils/tool-display')

beforeEach(() => {
  // 仅清调用记录，保留模块级 catalog / loadingPromise（与生产一致：模块加载即拉取一次）
  i18nT.mockClear()
})

describe('tool-display / resolveToolLabel', () => {
  it('插件命名空间命中 toolNames.<name>', () => {
    expect(resolveToolLabel('plug_tool', '后端插件标题', 'demo')).toBe('插件工具名')
    expect(i18nT).toHaveBeenCalledWith('toolNames.plug_tool', { ns: 'demo', defaultValue: '' })
  })

  it('插件命名空间未命中 → 回退 title 作为插件 i18n key（旧模式）', () => {
    expect(resolveToolLabel('unknown_tool', 'hello-world', 'demo')).toBe('你好世界')
  })

  it('插件命名空间与 title key 均未命中 → 返回兜底 title', () => {
    expect(resolveToolLabel('unknown_tool', '原始标题', 'demo')).toBe('原始标题')
  })

  it('插件工具无兜底 title → 返回工具原名', () => {
    expect(resolveToolLabel('unknown_tool', undefined, 'demo')).toBe('unknown_tool')
  })

  it('兜底 title 为空串时按缺失处理 → 返回工具原名', () => {
    expect(resolveToolLabel('unknown_tool', '', 'demo')).toBe('unknown_tool')
  })

  it('宿主工具命中 workbench.toolNames.<name>', () => {
    expect(resolveToolLabel('file_read', '后端标题')).toBe('读取文件')
    expect(i18nT).toHaveBeenCalledWith('workbench.toolNames.file_read', { defaultValue: '' })
  })

  it('宿主工具未命中 → 兜底 title → 工具原名', () => {
    expect(resolveToolLabel('mcp_remote_tool', 'MCP 工具标题')).toBe('MCP 工具标题')
    expect(resolveToolLabel('mcp_remote_tool')).toBe('mcp_remote_tool')
  })

  it('pluginId 为空串时走宿主分支（不作为命名空间）', () => {
    expect(resolveToolLabel('file_read', '后端标题', '')).toBe('读取文件')
  })

  it('Unicode 工具名不丢失', () => {
    expect(resolveToolLabel('工具_😀', undefined)).toBe('工具_😀')
  })
})

describe('tool-display / resolveToolDescription', () => {
  it('宿主工具命中文案', () => {
    expect(resolveToolDescription('file_read', 'LLM 描述')).toBe('读取文件说明')
  })

  it('插件工具命中插件命名空间', () => {
    expect(resolveToolDescription('plug_tool', 'LLM 描述', 'demo')).toBe('插件工具说明')
    expect(i18nT).toHaveBeenCalledWith('toolDescriptions.plug_tool', { ns: 'demo', defaultValue: '' })
  })

  it('未命中 → 兜底 description → 空串', () => {
    expect(resolveToolDescription('nope', 'LLM 描述', 'demo')).toBe('LLM 描述')
    expect(resolveToolDescription('nope')).toBe('')
    expect(resolveToolDescription('nope', undefined, 'demo')).toBe('')
  })
})

describe('tool-display / getToolDisplayName（依赖后端目录）', () => {
  it('目录中的插件工具走插件命名空间解析', async () => {
    await loadToolDisplayNames()
    expect(getToolDisplayName('plug_tool')).toBe('插件工具名')
  })

  it('目录中的宿主工具命中宿主 locale', async () => {
    await loadToolDisplayNames()
    expect(getToolDisplayName('file_read')).toBe('读取文件')
  })

  it('目录未命中（MCP 外部工具）→ 使用目录 title', async () => {
    await loadToolDisplayNames()
    expect(getToolDisplayName('mcp_remote_tool')).toBe('MCP 工具标题')
  })

  it('目录与 locale 均无 → 工具原名', async () => {
    await loadToolDisplayNames()
    expect(getToolDisplayName('totally_unknown')).toBe('totally_unknown')
  })

  it('loadToolDisplayNames 幂等：重复调用不重复拉取', async () => {
    const first = loadToolDisplayNames()
    const second = loadToolDisplayNames()
    expect(first).toBe(second)
    await first
    await first
    expect(listBuiltin).toHaveBeenCalledTimes(1)
  })
})

describe('tool-display / 目录加载异常与缺失', () => {
  it('listBuiltin 拒绝时静默降级（不阻塞、退回原名）', async () => {
    vi.resetModules()
    const failing = vi.fn(async () => { throw new Error('ipc down') })
    vi.stubGlobal('window', { electronAPI: { tool: { listBuiltin: failing } } })
    const mod = await import('../../../src/utils/tool-display')
    await expect(mod.loadToolDisplayNames()).resolves.toBeUndefined()
    expect(mod.getToolDisplayName('plug_tool')).toBe('plug_tool')
    expect(failing).toHaveBeenCalledTimes(1)
  })

  it('listBuiltin 返回非法结构时降级（tool 字段缺失）', async () => {
    vi.resetModules()
    vi.stubGlobal('window', { electronAPI: {} })
    const mod = await import('../../../src/utils/tool-display')
    await expect(mod.loadToolDisplayNames()).resolves.toBeUndefined()
    expect(mod.getToolDisplayName('file_read')).toBe('读取文件')
  })
})

afterAll(() => {
  vi.unstubAllGlobals()
})
