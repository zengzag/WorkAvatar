// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest'
import { copyImageToClipboard } from '../../../src/utils/clipboard'

afterEach(() => {
  vi.restoreAllMocks()
  delete (window as any).electronAPI
})

describe('copyImageToClipboard', () => {
  it('调用主进程复制接口并返回结果', async () => {
    const copyImage = vi.fn().mockResolvedValue({ success: true })
    ;(window as any).electronAPI = { attachment: { copyImage } }

    await expect(copyImageToClipboard('wa-attachment://local/a.png')).resolves.toBe(true)
    expect(copyImage).toHaveBeenCalledWith('wa-attachment://local/a.png')
  })

  it('主进程异常或返回失败时返回 false', async () => {
    const copyImage = vi.fn().mockRejectedValue(new Error('boom'))
    ;(window as any).electronAPI = { attachment: { copyImage } }

    await expect(copyImageToClipboard('data:image/png;base64,aaa')).resolves.toBe(false)
  })

  it('空来源直接失败，不触发 IPC', async () => {
    const copyImage = vi.fn()
    ;(window as any).electronAPI = { attachment: { copyImage } }

    await expect(copyImageToClipboard('')).resolves.toBe(false)
    expect(copyImage).not.toHaveBeenCalled()
  })
})
