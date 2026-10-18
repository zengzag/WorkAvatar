import { describe, it, expect, beforeEach, vi } from 'vitest'

/**
 * dialog-path：Electron 43 起对话框不再记忆上次目录，这里自行记忆。
 * 覆盖：显式 defaultPath 优先、记住目录、取消/无效路径不污染记忆。
 */

async function freshModule() {
  vi.resetModules()
  return import('../../../electron/main/services/dialog-path')
}

describe('dialog-path', () => {
  beforeEach(() => {
    vi.resetModules()
  })

  it('首次调用无记忆：透传调用方 defaultPath（可为空）', async () => {
    const { resolveDialogDefaultPath } = await freshModule()
    expect(resolveDialogDefaultPath('C:/suggested/name.json')).toBe('C:/suggested/name.json')
    expect(resolveDialogDefaultPath()).toBeUndefined()
  })

  it('显式 defaultPath 始终优先于记忆目录', async () => {
    const { resolveDialogDefaultPath, rememberDialogPath } = await freshModule()
    rememberDialogPath('D:/work/a.txt')
    expect(resolveDialogDefaultPath('C:/suggested/name.json')).toBe('C:/suggested/name.json')
    expect(resolveDialogDefaultPath()).toBe('D:/work')
  })

  it('记住目录时忽略取消（空值）与无目录的路径', async () => {
    const { resolveDialogDefaultPath, rememberDialogPath } = await freshModule()
    rememberDialogPath(undefined)
    rememberDialogPath('')
    expect(resolveDialogDefaultPath()).toBeUndefined()
    // 相对文件名（无目录）不应写入记忆
    rememberDialogPath('name.json')
    expect(resolveDialogDefaultPath()).toBeUndefined()
    rememberDialogPath('D:/work/sub/b.txt')
    expect(resolveDialogDefaultPath()).toBe('D:/work/sub')
  })
})
