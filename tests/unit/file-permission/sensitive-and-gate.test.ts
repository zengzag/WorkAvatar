/**
 * 新增安全能力回归：
 * - 敏感路径识别与"强制确认"语义（不受高权限/始终允许影响）
 * - 工具前置权限门（声明式级别、自授权工具跳过、拒绝短路）
 * - unified diff 预览
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import FilePermissionService from '../../../electron/main/services/file-permission.service'
import UnifiedInteractionService, {
  interactionContext,
} from '../../../electron/main/services/unified-interaction.service'
import {
  createToolPermissionGate,
  isIrreversibleTool,
  resolveToolPermission,
} from '../../../electron/main/services/agent/tools/tool-permission'
import { buildUnifiedDiff } from '../../../electron/main/services/agent/tools/text-diff'
import type { ToolDefinition } from '../../../electron/main/services/agent/tools/types'

let root = ''
const service = FilePermissionService.getInstance()

function withCtx<T>(ctx: Record<string, unknown>, fn: () => Promise<T>): Promise<T> {
  return interactionContext.run(
    { sessionId: 's', employeeId: 'e1', workspacePath: root, ...ctx } as never,
    fn,
  )
}

function mockInteraction(response: Record<string, unknown>) {
  return vi.spyOn(UnifiedInteractionService.getInstance(), 'request').mockResolvedValue(response as never)
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-sec-'))
})

afterEach(() => {
  vi.restoreAllMocks()
  fs.rmSync(root, { recursive: true, force: true })
})

describe('file-permission / 敏感路径识别', () => {
  it('凭据、密钥与版本库内部路径视为敏感', () => {
    expect(service.isSensitivePath(path.join(root, '.env'))).toBe(true)
    expect(service.isSensitivePath(path.join(root, '.env.local'))).toBe(true)
    expect(service.isSensitivePath(path.join(root, '.git', 'config'))).toBe(true)
    expect(service.isSensitivePath(path.join(root, '.ssh', 'id_rsa'))).toBe(true)
    expect(service.isSensitivePath(path.join(root, 'server.key'))).toBe(true)
    expect(service.isSensitivePath(path.join(root, 'cert.pem'))).toBe(true)
    expect(service.isSensitivePath(path.join(root, 'credentials.json'))).toBe(true)
  })

  it('模板类与普通文件不视为敏感（含公钥）', () => {
    expect(service.isSensitivePath(path.join(root, '.env.example'))).toBe(false)
    expect(service.isSensitivePath(path.join(root, '.env.sample'))).toBe(false)
    expect(service.isSensitivePath(path.join(root, 'readme.md'))).toBe(false)
    expect(service.isSensitivePath(path.join(root, 'id_rsa.pub'))).toBe(false)
  })

  it('工作区内敏感文件仍需确认，且高权限模式不可绕过（forced）', async () => {
    const target = path.join(root, '.env')
    await withCtx({ highPermission: true }, async () => {
      const req = mockInteraction({ id: '', confirmed: true, cancelled: false })
      const result = await service.authorizeFileOperation('写入', [target])
      expect(result.allowed).toBe(true)
      expect(req).toHaveBeenCalledTimes(1)
      const request = req.mock.calls[0][0] as any
      expect(request.forced).toBe(true)
      expect(request.dirScope).toBeUndefined()
    })
  })

  it('工作区内普通文件仍自动放行（不弹窗）', async () => {
    const target = path.join(root, 'a.txt')
    await withCtx({}, async () => {
      const req = mockInteraction({ id: '', confirmed: true, cancelled: false })
      const result = await service.authorizeFileOperation('写入', [target])
      expect(result.allowed).toBe(true)
      expect(req).not.toHaveBeenCalled()
    })
  })

  it('不可逆操作（irreversible）确认强制，且不提供"始终允许此文件夹"', async () => {
    const outside = path.join(root, '..', `wa-del-${Date.now()}`, 'a.txt')
    await withCtx({ highPermission: true }, async () => {
      const req = mockInteraction({ id: '', confirmed: true, cancelled: false })
      const result = await service.authorizeFileOperation('删除', [outside], { irreversible: true })
      expect(result.allowed).toBe(true)
      const request = req.mock.calls[0][0] as any
      expect(request.forced).toBe(true)
      expect(request.dirScope).toBeUndefined()
    })
  })
})

describe('agent/tools/tool-permission / 策略与前置门', () => {
  const makeTool = (overrides: Partial<ToolDefinition>): ToolDefinition => ({
    id: 'x', name: 'x', title: 'X', description: '', parameters: { type: 'object', properties: {} },
    handler: () => ({ success: true }), source: 'builtin', ...overrides,
  })

  it('未声明 permission 按 safe 处理；不可逆工具集合固定', () => {
    expect(resolveToolPermission(makeTool({}))).toBe('safe')
    expect(resolveToolPermission(makeTool({ permission: 'dangerous' }))).toBe('dangerous')
    expect(isIrreversibleTool('file_delete')).toBe(true)
    expect(isIrreversibleTool('file_write')).toBe(false)
  })

  it('safe / 自授权工具不弹窗', async () => {
    await withCtx({}, async () => {
      const req = mockInteraction({ id: '', confirmed: true, cancelled: false })
      const gate = createToolPermissionGate()
      expect(await gate.check(makeTool({ permission: 'safe' }), {})).toBeNull()
      expect(await gate.check(makeTool({ permission: 'dangerous', selfAuthorized: true }), {})).toBeNull()
      expect(req).not.toHaveBeenCalled()
    })
  })

  it('dangerous 工具确认通过则放行，拒绝则短路返回失败', async () => {
    await withCtx({}, async () => {
      const allow = mockInteraction({ id: '', confirmed: true, cancelled: false })
      const gate = createToolPermissionGate()
      expect(await gate.check(makeTool({ name: 'run_skill_script', permission: 'dangerous' }), {})).toBeNull()
      expect(allow).toHaveBeenCalledTimes(1)

      vi.restoreAllMocks()
      mockInteraction({ id: '', cancelled: true })
      const denied = await createToolPermissionGate().check(
        makeTool({ name: 'run_skill_script', permission: 'dangerous' }), {},
      )
      expect(denied?.success).toBe(false)
      expect(denied?.toolName).toBe('run_skill_script')
    })
  })
})

describe('agent/tools/text-diff / buildUnifiedDiff', () => {
  it('无改动返回空内容', () => {
    expect(buildUnifiedDiff('a\nb', 'a\nb')).toEqual({ content: '', truncated: false })
  })

  it('裁剪公共前后缀，仅输出变化块并带行号头', () => {
    const diff = buildUnifiedDiff('a\nb\nc', 'a\nB\nc')
    expect(diff.content).toContain('@@ -2,1 +2,1 @@')
    expect(diff.content).toContain('-b')
    expect(diff.content).toContain('+B')
    expect(diff.truncated).toBe(false)
  })

  it('新增文件：全部为 + 行', () => {
    const diff = buildUnifiedDiff('', 'x\ny')
    expect(diff.content).toContain('+x')
    expect(diff.content).toContain('+y')
    expect(diff.content).not.toContain('-x')
  })

  it('超过行数上限时截断并标记', () => {
    const before = ''
    const after = Array.from({ length: 50 }, (_, i) => `line-${i}`).join('\n')
    const diff = buildUnifiedDiff(before, after, 10)
    expect(diff.truncated).toBe(true)
    expect(diff.content).toContain('diff 已截断')
  })
})
