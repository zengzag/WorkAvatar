import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import * as path from 'path'
import * as fs from 'fs'
import * as os from 'os'
import FilePermissionService, { buildScriptConfirmMessage } from '../../../electron/main/services/file-permission.service'
import { normalizePath } from '../../../electron/main/services/path-normalize'
import UnifiedInteractionService, { interactionContext } from '../../../electron/main/services/unified-interaction.service'

function makeTempRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'wa-perm-'))
}

const IS_WINDOWS = process.platform === 'win32'

interface TestCtx {
  sessionId: string
  employeeId: string
  workspacePath: string
  conversationId?: string
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

  it('文件工具触发：仍按文件视角措辞，不下发脚本内容', async () => {
    const ctx: TestCtx = { sessionId: 's15', employeeId: 'e1', workspacePath: root }
    const outside = path.join(root, '..', 'fs-view', 'a.txt')
    await withCtx(ctx, async () => {
      const req = mockInteraction({ id: '', confirmed: true, cancelled: false })

      await service.authorizeFileOperation('修改', [outside])
      const request = req.mock.calls[0][0]
      expect(request.title).toBe('确认修改工作区外文件')
      expect(request.message).toContain('即将修改工作区外的路径')
      expect(request.script).toBeUndefined()

      req.mockRestore()
    })
  })

  it('脚本触发：按脚本视角措辞并携带原始脚本内容', async () => {
    const ctx: TestCtx = { sessionId: 's16', employeeId: 'e1', workspacePath: root }
    const outside = path.join(root, '..', 'script-view', 'a.txt')
    const code = 'Set-Content -Path "$out\\a.txt" -Value hi'
    await withCtx(ctx, async () => {
      const req = mockInteraction({ id: '', confirmed: true, cancelled: false })

      const result = await service.authorizeFileOperation('修改', [outside], {
        script: { language: 'powershell', content: code },
      })
      expect(result.allowed).toBe(true)

      const request = req.mock.calls[0][0]
      expect(request.title).toBe('确认执行脚本')
      expect(request.message).toContain('即将执行脚本，疑似会修改或删除')
      expect(request.message).toContain('共 1 个')
      expect(request.message).toContain('script-view')
      expect(request.message).not.toContain('即将修改工作区外的路径')
      expect(request.script).toEqual({ language: 'powershell', content: code, truncated: false })

      req.mockRestore()
    })
  })

  it('脚本原文超过展示上限时截断并标记', async () => {
    const ctx: TestCtx = { sessionId: 's17', employeeId: 'e1', workspacePath: root }
    const outside = path.join(root, '..', 'script-long', 'a.txt')
    await withCtx(ctx, async () => {
      const req = mockInteraction({ id: '', confirmed: true, cancelled: false })

      await service.authorizeFileOperation('修改', [outside], {
        script: { language: 'javascript', content: 'x'.repeat(20001) },
      })
      const request = req.mock.calls[0][0]
      expect(request.script?.truncated).toBe(true)
      expect(request.script?.content.length).toBe(20000)

      req.mockRestore()
    })
  })

  it('脚本目标无法静态判定：文案说明无法判定且不含路径列表', async () => {
    expect(buildScriptConfirmMessage([])).toContain('无法判定是否位于工作区内')
    expect(buildScriptConfirmMessage([])).toContain('原始脚本内容如下')
    expect(buildScriptConfirmMessage([])).not.toContain('- ')
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

  it('授权范围为盘根/文件系统根时视为过宽，不提供"始终允许此文件夹"', async () => {
    const ctx: TestCtx = { sessionId: 's13', employeeId: 'e1', workspacePath: root }
    const fsRoot = path.parse(root).root
    const target = path.join(fsRoot, 'wa-perm-root-out.txt')
    await withCtx(ctx, async () => {
      const req = mockInteraction({ id: '', confirmed: true, cancelled: false, allowAlwaysDir: true })

      const result = await service.authorizeFileOperation('删除', [target], { scopeDir: fsRoot })
      expect(result.allowed).toBe(true)
      expect(req.mock.calls[0][0].dirScope).toBeUndefined()

      // 未落目录授权：仅缓存该精确路径，同盘其他路径仍需再次确认
      expect(service.isPathAuthorized(target)).toBe(true)
      expect(service.isPathAuthorized(path.join(fsRoot, 'wa-perm-root-other.txt'))).toBe(false)

      req.mockRestore()
    })
  })

  it('过宽判定只看路径形状：与 dataDir/home 不同盘的盘根同样过宽（Windows）', async () => {
    if (!IS_WINDOWS) return
    const ctx: TestCtx = { sessionId: 's14', employeeId: 'e1', workspacePath: root }
    await withCtx(ctx, async () => {
      const req = mockInteraction({ id: '', confirmed: true, cancelled: false, allowAlwaysDir: true })
      // 不存在的盘符：dataDir/home（都在系统盘）不可能是它的子路径，只能由路径形状拦下
      await service.authorizeFileOperation('删除', ['Z:\\wa-perm-z.txt'], { scopeDir: 'Z:\\' })
      expect(req.mock.calls[0][0].dirScope).toBeUndefined()
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

  it('本轮任务高权限模式：开启后区外路径直接通过，清理后恢复弹窗', async () => {
    const interactionService = UnifiedInteractionService.getInstance()
    const ctx: TestCtx = { sessionId: 's11', employeeId: 'e1', workspacePath: root, conversationId: 'conv-task-hp' }
    const outside = path.join(root, '..', 'task-hp', 'a.txt')
    await withCtx(ctx, async () => {
      const req = mockInteraction({ id: '', confirmed: true, cancelled: false })

      interactionService.setTaskHighPermission('conv-task-hp', true)
      const allowed = await service.authorizeFileOperation('写入', [outside])
      expect(allowed.allowed).toBe(true)
      expect(req).not.toHaveBeenCalled()

      // 会话删除：clearAllowedSources 撤销任务级高权限后恢复弹窗
      interactionService.clearAllowedSources('conv-task-hp')
      service.clearAuthorizations('conv-task-hp')
      const asked = await service.authorizeFileOperation('写入', [outside])
      expect(asked.allowed).toBe(true)
      expect(req).toHaveBeenCalledTimes(1)

      req.mockRestore()
    })
  })

  it('本轮任务高权限模式：仅作用于登记会话，不波及其他会话', async () => {
    const interactionService = UnifiedInteractionService.getInstance()
    interactionService.setTaskHighPermission('conv-hp-a', true)
    const ctx: TestCtx = { sessionId: 's12', employeeId: 'e1', workspacePath: root, conversationId: 'conv-hp-b' }
    await withCtx(ctx, async () => {
      // 未登记的会话仍走弹窗（开关打开时 isTaskHighPermission 才为 true）
      expect(interactionService.isTaskHighPermission()).toBe(false)
      const req = mockInteraction({ id: '', confirmed: true, cancelled: false })
      await service.authorizeFileOperation('写入', [path.join(root, '..', 'task-hp-b.txt')])
      expect(req).toHaveBeenCalledTimes(1)
      req.mockRestore()
    })
    // 会话 A 的上下文仍视为高权限
    expect(interactionService.isTaskHighPermission('conv-hp-a')).toBe(true)
    interactionService.clearAllowedSources('conv-hp-a')
    expect(interactionService.isTaskHighPermission('conv-hp-a')).toBe(false)
  })
})
