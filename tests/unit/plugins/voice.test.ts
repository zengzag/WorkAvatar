import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createMockContext } from '../../helpers/mock-plugin-context'

// mock electron（vitest node 环境无 electron；voice 用 desktopCapturer/dialog）
vi.mock('electron', () => ({
  desktopCapturer: { getSources: vi.fn(async () => []) },
  dialog: { showOpenDialog: vi.fn(async () => ({ canceled: true, filePaths: [] })) },
  app: { getPath: () => '/mock' },
  BrowserWindow: class {
    static getAllWindows() { return [] }
    loadURL() {}
    loadFile() {}
    on() {}
    once() {}
    close() {}
    destroy() {}
    isDestroyed() { return true }
    isVisible() { return false }
    show() {}
    hide() {}
    setSize() {}
    webContents = { send: vi.fn() }
  },
}))

/**
 * voice 插件单测：验证 activate 注册行为 + IPC handler 任务 CRUD。
 * 本地 STT（sherpa-onnx）在 mock 下 native.borrow 返回 null，仅验证注册与数据操作。
 */

async function loadPlugin() {
  vi.resetModules()
  const mod = await import('../../../plugins/voice/src/main/index')
  return mod
}

describe('voice 插件 activate', () => {
  let mock: ReturnType<typeof createMockContext>

  beforeEach(() => {
    mock = createMockContext('voice')
  })

  it('注册 25 个 IPC handler', async () => {
    const mod = await loadPlugin()
    mod.activate(mock.ctx)
    const channels = ['list-tasks', 'get-task', 'create-task', 'update-task', 'delete-task',
      'save-audio', 'save-secondary-audio', 'merge-dual-transcript',
      'transcribe', 'cancel-transcribe',
      'generate-minutes', 'cancel-minutes',
      'get-settings', 'set-settings',
      'get-audio-sources', 'check-local-model', 'select-directory',
      'realtime-start', 'realtime-feed', 'realtime-stop', 'realtime-cancel',
      'subtitle-show', 'subtitle-hide', 'subtitle-toggle', 'subtitle-get-visible']
    for (const c of channels) {
      expect(mock.ipc.handlers.has(c)).toBe(true)
    }
    expect(mock.ipc.handlers.size).toBe(25)
  })

  it('deactivate 不抛错', async () => {
    const mod = await loadPlugin()
    mod.activate(mock.ctx)
    expect(() => mod.deactivate()).not.toThrow()
  })
})

describe('voice 插件 IPC handler', () => {
  let mock: ReturnType<typeof createMockContext>

  beforeEach(async () => {
    mock = createMockContext('voice')
    const mod = await loadPlugin()
    mod.activate(mock.ctx)
  })

  it('create-task 创建语音任务', async () => {
    const handler = mock.ipc.handlers.get('create-task')!
    const res = await handler({ title: '录音任务' }) as { id?: string; error?: string }
    expect(res.error).toBeUndefined()
    expect(res.id).toBeTruthy()
  })

  it('list-tasks 返回已创建任务', async () => {
    const create = mock.ipc.handlers.get('create-task')!
    await create({ title: '任务A' })
    const list = mock.ipc.handlers.get('list-tasks')!
    const res = await list() as Array<{ title: string }>
    expect(res.length).toBe(1)
    expect(res[0].title).toBe('任务A')
  })

  it('get-task 返回指定任务', async () => {
    const create = mock.ipc.handlers.get('create-task')!
    const created = await create({ title: '任务B' }) as { id: string }
    const get = mock.ipc.handlers.get('get-task')!
    const res = await get(created.id) as { id?: string; error?: string }
    expect(res.id).toBe(created.id)
  })

  it('update-task 更新任务', async () => {
    const create = mock.ipc.handlers.get('create-task')!
    const created = await create({ title: '任务C' }) as { id: string }
    const update = mock.ipc.handlers.get('update-task')!
    const res = await update({ id: created.id, title: '任务C改' }) as { title?: string }
    expect(res.title).toBe('任务C改')
  })

  it('delete-task 删除任务', async () => {
    const create = mock.ipc.handlers.get('create-task')!
    const created = await create({ title: '任务D' }) as { id: string }
    const del = mock.ipc.handlers.get('delete-task')!
    const res = await del(created.id) as { success?: boolean; error?: string }
    expect(res.error).toBeUndefined()
  })

  it('get-settings 返回默认设置', async () => {
    const handler = mock.ipc.handlers.get('get-settings')!
    const res = await handler() as Record<string, unknown>
    expect(res).toBeTruthy()
  })
})

describe('voice 插件 IPC 边界 case', () => {
  let mock: ReturnType<typeof createMockContext>

  beforeEach(async () => {
    mock = createMockContext('voice')
    const mod = await loadPlugin()
    mod.activate(mock.ctx)
  })

  it('create-task 缺 title 仍创建（title 为空）', async () => {
    const handler = mock.ipc.handlers.get('create-task')!
    const res = await handler({}) as { id?: string; title?: string }
    expect(res.id).toBeTruthy()
    expect(res.title).toBe('')
  })

  it('get-task 不存在的任务返回 null', async () => {
    const handler = mock.ipc.handlers.get('get-task')!
    const res = await handler('nonexistent')
    expect(res).toBeNull()
  })

  it('update-task 缺 id 抛错（SQLite 参数绑定失败）', async () => {
    const handler = mock.ipc.handlers.get('update-task')!
    expect(() => handler({ title: 'x' })).toThrow()
  })

  it('update-task 不存在的任务返回 null', async () => {
    const handler = mock.ipc.handlers.get('update-task')!
    const res = await handler({ id: 'nonexistent', title: 'x' })
    expect(res).toBeNull()
  })

  it('delete-task 空 id 不报错', async () => {
    const handler = mock.ipc.handlers.get('delete-task')!
    expect(() => handler('')).not.toThrow()
  })

  it('set-settings 更新设置', async () => {
    const set = mock.ipc.handlers.get('set-settings')!
    const res = await set({ stt_mode: 'local' }) as { success?: boolean; error?: string }
    expect(res.error).toBeUndefined()
  })

  it('list-tasks 空数据返回空数组', async () => {
    const handler = mock.ipc.handlers.get('list-tasks')!
    const res = await handler() as unknown[]
    expect(res).toEqual([])
  })
})
