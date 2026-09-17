/**
 * 运行时环境服务单测（electron / i18n 打桩，真实探测本机 node）：
 * - detectAll 的结果结构与顺序、文案本地化键映射、installing 标记
 * - 并发安装守卫、cancelInstall 状态机（不真正触发安装/杀进程）
 * 说明：安装流程会真实下载安装包，测试只覆盖状态机与守卫，不调用 install 的真实分支。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const mockState = vi.hoisted(() => {
  const windows: any[] = []
  return { windows }
})

vi.mock('electron', () => ({
  BrowserWindow: { getAllWindows: () => mockState.windows },
  shell: { openExternal: vi.fn() },
}))

vi.mock('../../../electron/main/services/ui-i18n.service', () => ({
  default: { t: (key: string) => `T[${key}]` },
}))

import RuntimeEnvService from '../../../electron/main/services/runtime-env.service'

const service = RuntimeEnvService.getInstance()
const priv = service as any

beforeEach(() => {
  mockState.windows.length = 0
  priv.installingTool = null
  priv.currentChild = null
  priv.cancelled = false
})

describe('runtime-env / detectAll', () => {
  it('按 uv → python → node → pip 顺序返回且字段完整', async () => {
    const tools = await service.detectAll()
    expect(tools.map(t => t.id)).toEqual(['uv', 'python', 'node', 'pip'])
    for (const t of tools) {
      expect(typeof t.name).toBe('string')
      expect(t.name.length).toBeGreaterThan(0)
      expect(t.description.length).toBeGreaterThan(0)
      expect(typeof t.installed).toBe('boolean')
      expect(typeof t.installable).toBe('boolean')
      expect(t.installing).toBe(false)
    }
  })

  it('展示文案取自 i18n 文案键', async () => {
    const tools = await service.detectAll()
    const byId = new Map(tools.map(t => [t.id, t]))
    expect(byId.get('uv')!.description).toBe('T[runtimeUvDesc]')
    expect(byId.get('python')!.description).toBe('T[runtimePythonDesc]')
    expect(byId.get('python')!.installHint).toBe('T[runtimePythonHint]')
    expect(byId.get('pip')!.installHint).toBe('T[runtimePipHint]')
    expect(byId.get('node')!.description).toBe('T[runtimeNodeDesc]')
  })

  it('node 检测在 Node 运行环境下应命中（vitest 自身运行于 node）', async () => {
    const tools = await service.detectAll()
    const node = tools.find(t => t.id === 'node')!
    expect(node.installed).toBe(true)
    expect(node.version).toMatch(/^\d+\.\d+\.\d+/)
    expect(node.path).toBeTruthy()
  })

  it('installing 标记跟随当前安装中的工具', async () => {
    priv.installingTool = 'uv'
    const tools = await service.detectAll()
    expect(tools.find(t => t.id === 'uv')!.installing).toBe(true)
    expect(tools.find(t => t.id === 'node')!.installing).toBe(false)
  })

  it('检测结果互不影响：pip 结果与 python 的可用性一致', async () => {
    const tools = await service.detectAll()
    const python = tools.find(t => t.id === 'python')!
    const pip = tools.find(t => t.id === 'pip')!
    if (!python.installed) expect(pip.installed).toBe(false)
  })
})

describe('runtime-env / 安装状态机（不触发真实安装）', () => {
  it('初始不在安装中，cancelInstall 返回 false', () => {
    expect(service.isInstalling()).toBe(false)
    expect(service.cancelInstall()).toBe(false)
  })

  it('已有安装任务在进行时拒绝新的安装请求', async () => {
    priv.installingTool = 'uv'
    await expect(service.install('node')).resolves.toEqual({
      success: false,
      error: '已有安装任务正在进行，请等待完成或取消',
    })
    // 守卫不应改变当前安装标记
    expect(priv.installingTool).toBe('uv')
  })

  it('cancelInstall 在有安装任务但无子进程时置取消标志并返回 true', () => {
    priv.installingTool = 'python'
    expect(service.isInstalling()).toBe(true)
    expect(service.cancelInstall()).toBe(true)
    expect(priv.cancelled).toBe(true)
    expect(priv.installingTool).toBe('python') // 由 install 的 finally 负责清空
  })

  it('cancelInstall 幂等（重复调用仍返回 true 直到安装结束）', () => {
    priv.installingTool = 'uv'
    expect(service.cancelInstall()).toBe(true)
    expect(service.cancelInstall()).toBe(true)
  })
})
