/**
 * 文件权限服务未覆盖分支补充（与 tests/unit/file-permission 互补）：
 * - 路径列表折叠
 * - 无上下文 / 无会话 key 时的拒绝语义与空路径短路
 * - 超时与确认失败（request 抛错）的文案分支
 * - dirScope 过宽判定的补充路径形状（用户主目录）
 * - 目录授权缓存的边界（空路径、未知 key 清理）
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import FilePermissionService from '../../../electron/main/services/file-permission.service'
import { normalizePath } from '../../../electron/main/services/path-normalize'
import UnifiedInteractionService, {
  interactionContext,
} from '../../../electron/main/services/unified-interaction.service'

const IS_WINDOWS = process.platform === 'win32'
const MAX_DISPLAY_PATHS = 15

let root = ''
let outsideDir = ''
const service = FilePermissionService.getInstance()

interface TestCtx {
  sessionId: string
  employeeId: string
  workspacePath: string
  conversationId?: string
}

function withCtx<T>(ctx: Partial<TestCtx>, fn: () => Promise<T>): Promise<T> {
  return interactionContext.run(
    { sessionId: 'default-session', employeeId: 'default-employee', workspacePath: root, ...ctx } as never,
    fn,
  )
}

function mockInteraction(response: Record<string, unknown>) {
  return vi.spyOn(UnifiedInteractionService.getInstance(), 'request').mockResolvedValue(response as never)
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-perm-b-'))
  outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-perm-out-'))
})

afterEach(() => {
  vi.restoreAllMocks()
  fs.rmSync(root, { recursive: true, force: true })
  fs.rmSync(outsideDir, { recursive: true, force: true })
})

describe('file-permission 补充 / 路径列表折叠', () => {
  it('路径数超过展示上限时折叠为一行统计', async () => {
    await withCtx({}, async () => {
      const req = mockInteraction({ id: '', confirmed: true, cancelled: false })
      const paths = Array.from({ length: 20 }, (_, i) => path.join(outsideDir, `f${i}.txt`))
      await service.authorizeFileOperation('写入', paths)
      const message = String(req.mock.calls[0][0].message)
      const bullets = message.split('\n').filter((line: string) => line.startsWith('- '))
      expect(bullets).toHaveLength(MAX_DISPLAY_PATHS + 1)
      expect(message).toContain('- ...（共 20 个路径）')
      req.mockRestore()
    })
  })

  it('恰好等于上限时不折叠', async () => {
    await withCtx({}, async () => {
      const req = mockInteraction({ id: '', confirmed: true, cancelled: false })
      const paths = Array.from({ length: MAX_DISPLAY_PATHS }, (_, i) => path.join(outsideDir, `g${i}.txt`))
      await service.authorizeFileOperation('写入', paths)
      expect(String(req.mock.calls[0][0].message)).not.toContain('...（共')
      req.mockRestore()
    })
  })
})

describe('file-permission 补充 / 无上下文与空路径', () => {
  it('无交互上下文时 getWorkspacePath 为 null，区外路径一律拒绝', async () => {
    expect(service.getWorkspacePath()).toBeNull()
    expect(service.isPathInWorkspace(path.join(outsideDir, 'a.txt'))).toBe(false)
    const r = await service.authorizeFileOperation('写入', [path.join(outsideDir, 'a.txt')])
    expect(r.allowed).toBe(false)
    expect(r.error).toContain('无交互上下文')
  })

  it('空白路径被跳过，无上下文也可直接放行', async () => {
    await expect(service.authorizeFileOperation('写入', ['', '   '])).resolves.toEqual({ allowed: true })
    await expect(service.authorizeFileOperation('写入', [])).resolves.toEqual({ allowed: true })
  })

  it('无会话 key（仅 employeeId）时不使用授权缓存，但工作区内仍放行', async () => {
    await interactionContext.run({ sessionId: undefined, employeeId: 'e1', workspacePath: root } as never, async () => {
      expect(service.isPathAuthorized(path.join(outsideDir, 'a.txt'))).toBe(false)
      const inside = await service.authorizeFileOperation('写入', [path.join(root, 'inside.txt')])
      expect(inside.allowed).toBe(true)
    })
  })

  it('isPathAuthorized 对空路径返回 false', () => {
    expect(service.isPathAuthorized('')).toBe(false)
    expect(service.isPathAuthorized('   ')).toBe(false)
  })

  it('allowDir 在无会话 key 时不产生缓存', async () => {
    await interactionContext.run({ sessionId: undefined, employeeId: 'e1', workspacePath: root } as never, () => {
      service.allowDir(outsideDir)
      expect(service.isPathAuthorized(path.join(outsideDir, 'a.txt'))).toBe(false)
    })
  })

  it('clearAuthorizations 对未知 key 是空操作', () => {
    expect(() => service.clearAuthorizations('never-existed')).not.toThrow()
  })
})

describe('file-permission 补充 / 超时与确认失败', () => {
  it('超时未响应：文案说明 5 分钟未响应', async () => {
    await withCtx({ conversationId: 'conv-timeout' }, async () => {
      const req = mockInteraction({ id: '', cancelled: true, timedOut: true })
      const r = await service.authorizeFileOperation('写入', [path.join(outsideDir, 't.txt')])
      expect(r.allowed).toBe(false)
      expect(r.error).toContain('5分钟内未响应')
      req.mockRestore()
    })
  })

  it('request 抛错时按确认失败处理', async () => {
    await withCtx({ conversationId: 'conv-throw' }, async () => {
      const req = vi
        .spyOn(UnifiedInteractionService.getInstance(), 'request')
        .mockRejectedValue(new Error('ipc boom') as never)
      const r = await service.authorizeFileOperation('删除', [path.join(outsideDir, 'x.txt')])
      expect(r).toEqual({ allowed: false, error: '删除确认失败，操作已取消' })
      req.mockRestore()
    })
  })

  it('confirm 返回非 true（未确认也未取消）时按取消处理', async () => {
    await withCtx({ conversationId: 'conv-partial' }, async () => {
      const req = mockInteraction({ id: '', cancelled: false })
      const r = await service.authorizeFileOperation('写入', [path.join(outsideDir, 'z.txt')])
      expect(r.allowed).toBe(false)
      expect(r.error).toContain('取消')
      req.mockRestore()
    })
  })
})

describe('file-permission 补充 / dirScope 过宽与授权缓存', () => {
  it('公共父目录为用户主目录时视为过宽，不提供"始终允许"', async () => {
    const target = path.join(os.homedir(), 'wa-perm-home-probe.txt')
    await withCtx({ conversationId: 'conv-home' }, async () => {
      const req = mockInteraction({ id: '', cancelled: true })
      await service.authorizeFileOperation('写入', [target])
      expect(req.mock.calls[0][0].dirScope).toBeUndefined()
      req.mockRestore()
    })
  })

  it('显式 scopeDir 为主目录时同样判为过宽', async () => {
    await withCtx({ conversationId: 'conv-home-2' }, async () => {
      const req = mockInteraction({ id: '', cancelled: true })
      await service.authorizeFileOperation('写入', [path.join(outsideDir, 'a.txt')], {
        scopeDir: os.homedir(),
      })
      expect(req.mock.calls[0][0].dirScope).toBeUndefined()
      req.mockRestore()
    })
  })

  it('可授权的普通目录：allowAlwaysDir 缓存整个子树', async () => {
    const nested = path.join(outsideDir, 'nested')
    fs.mkdirSync(nested, { recursive: true })
    await withCtx({ conversationId: 'conv-subtree' }, async () => {
      const req = mockInteraction({ id: '', confirmed: true, cancelled: false, allowAlwaysDir: true })
      const r = await service.authorizeFileOperation('写入', [path.join(outsideDir, 'a.txt')])
      expect(r.allowed).toBe(true)
      expect(normalizePath(req.mock.calls[0][0].dirScope)).toBe(normalizePath(outsideDir))

      expect(service.isPathAuthorized(path.join(nested, 'deep', 'b.txt'))).toBe(true)
      expect(service.isPathAuthorized(path.join(outsideDir, '..', 'sibling.txt'))).toBe(false)
      req.mockRestore()
    })
    service.clearAuthorizations('conv-subtree')
  })

  it('仅本次确认：精确路径缓存，父目录其他文件仍需确认', async () => {
    await withCtx({ conversationId: 'conv-exact' }, async () => {
      const req = mockInteraction({ id: '', confirmed: true, cancelled: false })
      await service.authorizeFileOperation('写入', [path.join(outsideDir, 'one.txt')])
      expect(service.isPathAuthorized(path.join(outsideDir, 'one.txt'))).toBe(true)
      expect(service.isPathAuthorized(path.join(outsideDir, 'two.txt'))).toBe(false)
      req.mockRestore()
    })
    service.clearAuthorizations('conv-exact')
  })

  it('混合批量：工作区内 + 已授权 + 区外路径只对区外弹窗', async () => {
    const authorized = path.join(outsideDir, 'cached.txt')
    await withCtx({ conversationId: 'conv-mixed' }, async () => {
      const first = mockInteraction({ id: '', confirmed: true, cancelled: false })
      await service.authorizeFileOperation('写入', [authorized])
      first.mockRestore()

      const req = mockInteraction({ id: '', confirmed: true, cancelled: false })
      await service.authorizeFileOperation('写入', [
        path.join(root, 'in-workspace.txt'),
        authorized,
        path.join(outsideDir, 'new.txt'),
      ])
      expect(req).toHaveBeenCalledTimes(1)
      expect(req.mock.calls[0][0].message).toContain('共 1 个')
      expect(req.mock.calls[0][0].message).not.toContain('cached.txt')
      req.mockRestore()
    })
    service.clearAuthorizations('conv-mixed')
  })

  it('若请求路径全部已授权则不弹窗', async () => {
    const p = path.join(outsideDir, 'all-cached.txt')
    await withCtx({ conversationId: 'conv-all' }, async () => {
      const first = mockInteraction({ id: '', confirmed: true, cancelled: false })
      await service.authorizeFileOperation('写入', [p])
      first.mockRestore()

      const req = mockInteraction({ id: '', confirmed: true, cancelled: false })
      const r = await service.authorizeFileOperation('写入', [p, p])
      expect(r.allowed).toBe(true)
      expect(req).not.toHaveBeenCalled()
      req.mockRestore()
    })
    service.clearAuthorizations('conv-all')
  })

  it('Windows 下大小写不同的同一路径命中精确缓存', async () => {
    if (!IS_WINDOWS) return
    const p = path.join(outsideDir, 'Case.txt')
    await withCtx({ conversationId: 'conv-case' }, async () => {
      const req = mockInteraction({ id: '', confirmed: true, cancelled: false })
      await service.authorizeFileOperation('写入', [p])
      expect(service.isPathAuthorized(p.toUpperCase())).toBe(true)
      req.mockRestore()
    })
    service.clearAuthorizations('conv-case')
  })

  it('授权 key 隔离：不同会话的目录授权互不可见', async () => {
    await withCtx({ conversationId: 'conv-iso-a' }, async () => {
      const req = mockInteraction({ id: '', confirmed: true, cancelled: false, allowAlwaysDir: true })
      await service.authorizeFileOperation('写入', [path.join(outsideDir, 'iso.txt')])
      req.mockRestore()
    })
    await withCtx({ conversationId: 'conv-iso-b' }, async () => {
      expect(service.isPathAuthorized(path.join(outsideDir, 'iso-other.txt'))).toBe(false)
    })
    service.clearAuthorizations('conv-iso-a')
    service.clearAuthorizations('conv-iso-b')
  })
})
