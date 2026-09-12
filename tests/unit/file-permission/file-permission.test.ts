import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import * as path from 'path'
import * as fs from 'fs'
import * as os from 'os'
import FilePermissionService from '../../../electron/main/services/file-permission.service'
import { normalizePath } from '../../../electron/main/services/path-normalize'
import UnifiedInteractionService, { interactionContext } from '../../../electron/main/services/unified-interaction.service'

function makeTempRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'wa-perm-'))
}

interface TestCtx {
  sessionId: string
  employeeId: string
  workspacePath: string
}

function withCtx<T>(ctx: TestCtx, fn: () => Promise<T>): Promise<T> {
  return interactionContext.run(ctx as never, fn)
}

/** 模拟交互弹窗响应，返回可断言调用次数的 mock */
function mockInteraction(response: Record<string, unknown>) {
  return vi.spyOn(UnifiedInteractionService.getInstance(), 'request').mockResolvedValue(response as never)
}

describe('FilePermissionService', () => {
  let root: string
  let service: FilePermissionService

  beforeEach(() => {
    root = makeTempRoot()
    service = FilePermissionService.getInstance()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('工作区内路径直接放行，不弹窗', async () => {
    const ctx: TestCtx = { sessionId: 's1', employeeId: 'e1', workspacePath: root }
    await withCtx(ctx, async () => {
      const result = await service.authorizeFileOperation('写入', [path.join(root, 'a.txt')])
      expect(result.allowed).toBe(true)
    })
  })

  it('无交互上下文（后台任务）时区外操作默认拒绝', async () => {
    const result = await service.authorizeFileOperation('写入', [path.join(root, '..', 'outside.txt')])
    expect(result.allowed).toBe(false)
    expect(result.error).toContain('无交互上下文')
  })

  it('区外路径弹窗确认，仅本次确认后同路径自动通过', async () => {
    const ctx: TestCtx = { sessionId: 's2', employeeId: 'e1', workspacePath: root }
    const outside = path.join(root, '..', 'perm-out', 'x.txt')
    await withCtx(ctx, async () => {
      const req = mockInteraction({ id: '', confirmed: true, cancelled: false })

      const first = await service.authorizeFileOperation('写入', [outside])
      expect(first.allowed).toBe(true)
      expect(req).toHaveBeenCalledTimes(1)

      // 同路径第二次自动通过（精确路径缓存）
      const second = await service.authorizeFileOperation('写入', [outside])
      expect(second.allowed).toBe(true)
      expect(req).toHaveBeenCalledTimes(1)

      req.mockRestore()
    })
  })

  it('用户取消时拒绝并返回原因', async () => {
    const ctx: TestCtx = { sessionId: 's3', employeeId: 'e1', workspacePath: root }
    await withCtx(ctx, async () => {
      const req = mockInteraction({ id: '', cancelled: true })
      const result = await service.authorizeFileOperation('删除', [path.join(root, '..', 'y.txt')])
      expect(result.allowed).toBe(false)
      expect(result.error).toContain('取消')
      req.mockRestore()
    })
  })

  it('"始终允许此文件夹"授权整个目录子树', async () => {
    const ctx: TestCtx = { sessionId: 's4', employeeId: 'e1', workspacePath: root }
    const dir = path.join(root, '..', 'perm-dir')
    const fileA = path.join(dir, 'a.txt')
    const fileB = path.join(dir, 'sub', 'b.txt')
    await withCtx(ctx, async () => {
      const req = mockInteraction({ id: '', confirmed: true, cancelled: false, allowAlwaysDir: true })

      const first = await service.authorizeFileOperation('写入', [fileA])
      expect(first.allowed).toBe(true)

      // 同目录其他文件与子目录文件自动通过（目录级缓存）
      const second = await service.authorizeFileOperation('写入', [fileB])
      expect(second.allowed).toBe(true)
      expect(req).toHaveBeenCalledTimes(1)

      req.mockRestore()
    })
  })

  it('批量路径合并为一次弹窗', async () => {
    const ctx: TestCtx = { sessionId: 's5', employeeId: 'e1', workspacePath: root }
    const p1 = path.join(root, '..', 'batch-a', '1.txt')
    const p2 = path.join(root, '..', 'batch-a', '2.txt')
    await withCtx(ctx, async () => {
      const req = mockInteraction({ id: '', confirmed: true, cancelled: false })

      const result = await service.authorizeFileOperation('修改', [p1, p2])
      expect(result.allowed).toBe(true)
      expect(req).toHaveBeenCalledTimes(1)
      expect(req.mock.calls[0][0].message).toContain('共 2 个')
      expect(req.mock.calls[0][0].message).toContain('batch-a')

      req.mockRestore()
    })
  })

  it('scopeDir：目标本身是目录时"始终允许"授权该目录自身（非其父目录）', async () => {
    const ctx: TestCtx = { sessionId: 's7', employeeId: 'e1', workspacePath: root }
    const cwd = path.join(root, '..', 'perm-cwd-dir')
    fs.mkdirSync(cwd, { recursive: true })
    const child = path.join(cwd, 'sub', 'a.txt')
    const sibling = path.join(root, '..', 'perm-cwd-sibling.txt')
    await withCtx(ctx, async () => {
      const req = mockInteraction({ id: '', confirmed: true, cancelled: false, allowAlwaysDir: true })

      const first = await service.authorizeFileOperation('修改', [cwd], { scopeDir: cwd })
      expect(first.allowed).toBe(true)
      // 弹窗携带的 dirScope 必须是 cwd 本身
      expect(normalizePath(req.mock.calls[0][0].dirScope)).toBe(normalizePath(cwd))

      // cwd 子树内路径自动通过；cwd 的同级路径不允许
      expect(service.isPathAuthorized(child)).toBe(true)
      expect(service.isPathAuthorized(sibling)).toBe(false)

      req.mockRestore()
    })
  })

  it('未显式 scopeDir 时，单文件目标默认授权其父目录', async () => {
    const ctx: TestCtx = { sessionId: 's8', employeeId: 'e1', workspacePath: root }
    const file = path.join(root, '..', 'perm-parent', 'a.txt')
    await withCtx(ctx, async () => {
      const req = mockInteraction({ id: '', confirmed: true, cancelled: false, allowAlwaysDir: true })
      await service.authorizeFileOperation('写入', [file])
      expect(normalizePath(req.mock.calls[0][0].dirScope)).toBe(normalizePath(path.dirname(file)))
      req.mockRestore()
    })
  })

  it('高权限模式区外路径直接通过且不弹窗', async () => {
    const ctx = { sessionId: 's9', employeeId: 'e1', workspacePath: root, highPermission: true }
    await interactionContext.run(ctx as never, async () => {
      const req = mockInteraction({} as never)
      const result = await service.authorizeFileOperation('写入', [path.join(root, '..', 'hp.txt')])
      expect(result.allowed).toBe(true)
      expect(req).not.toHaveBeenCalled()
      req.mockRestore()
    })
  })

  it('clearAuthorizations 清理缓存后重新弹窗', async () => {
    const ctx: TestCtx = { sessionId: 's6', employeeId: 'e1', workspacePath: root }
    const outside = path.join(root, '..', 'perm-clear', 'z.txt')
    await withCtx(ctx, async () => {
      const req = mockInteraction({ id: '', confirmed: true, cancelled: false })

      await service.authorizeFileOperation('写入', [outside])
      await service.authorizeFileOperation('写入', [outside])
      expect(req).toHaveBeenCalledTimes(1)

      service.clearAuthorizations('s6')
      await service.authorizeFileOperation('写入', [outside])
      expect(req).toHaveBeenCalledTimes(2)

      req.mockRestore()
    })
  })
})
