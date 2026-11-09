// @vitest-environment jsdom
import { describe, it, expect, vi, beforeAll, afterEach } from 'vitest'
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { ConfigProvider, App as AntApp } from 'antd'

import '../../../src/i18n'
import ChatInput from '../../../src/components/workbench/ChatInput'

/**
 * 输入框待发送队列：
 * 回复进行中输入消息先入队，回复结束后自动续发；支持编辑、删除、立即发送。
 */

beforeAll(() => {
  ;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true
  ;(globalThis as any).ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
})

const pendings: Array<() => Promise<void>> = []
afterEach(async () => {
  while (pendings.length) await pendings.pop()!()
  vi.restoreAllMocks()
})

let convSeq = 0

async function renderInput(isStreaming: boolean, overrides: Record<string, any> = {}) {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  const onSend = vi.fn()
  const onStop = vi.fn()
  convSeq += 1
  const props = {
    onSend,
    onStop,
    isStreaming,
    placeholder: 'test',
    providers: [],
    attachedImages: [],
    onImagesChange: vi.fn(),
    selectedModels: [],
    onModelsChange: vi.fn(),
    selectedCollectionIds: [],
    onSelectedCollectionIdsChange: vi.fn(),
    allCollections: [],
    minimalMode: false,
    onMinimalModeChange: vi.fn(),
    canToggleMinimalMode: true,
    conversationId: `conv_queue_test_${convSeq}`,
    ...overrides,
  }

  const render = async (streaming: boolean) => {
    await act(async () => {
      root.render(
        <ConfigProvider>
          <AntApp>
            <ChatInput {...props} isStreaming={streaming} />
          </AntApp>
        </ConfigProvider>
      )
    })
  }

  await render(isStreaming)
  pendings.push(async () => {
    await act(async () => { root.unmount() })
    container.remove()
  })

  return { container, onSend, onStop, render }
}

function typeMessage(container: HTMLElement, text: string) {
  const editor = container.querySelector('.workbench-input') as HTMLElement
  expect(editor).toBeTruthy()
  act(() => {
    editor.innerHTML = text
    editor.dispatchEvent(new Event('input', { bubbles: true }))
  })
  act(() => {
    editor.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
  })
}

describe('ChatInput 待发送队列', () => {
  it('回复进行中发送消息进入队列，回复结束后自动续发', async () => {
    const { container, onSend, render } = await renderInput(true)

    typeMessage(container, '排队消息一')

    expect(onSend).not.toHaveBeenCalled()
    expect(container.textContent).toContain('待发送队列（1）')
    expect(container.textContent).toContain('排队消息一')

    await render(false)
    expect(onSend).toHaveBeenCalledTimes(1)
    expect(onSend).toHaveBeenCalledWith('排队消息一', [], [], { highPermission: false, fromQueue: true })
    expect(container.textContent).not.toContain('待发送队列')
  })

  it('支持内联编辑与删除', async () => {
    const { container, onSend, render } = await renderInput(true)

    typeMessage(container, '原始消息')
    const editButton = container.querySelector('button[aria-label="编辑"]') as HTMLElement
    expect(editButton).toBeTruthy()
    act(() => { editButton.dispatchEvent(new MouseEvent('click', { bubbles: true })) })

    const textarea = container.querySelector('textarea') as HTMLTextAreaElement
    expect(textarea).toBeTruthy()
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!
    act(() => {
      setter.call(textarea, '修改后的消息')
      textarea.dispatchEvent(new Event('input', { bubbles: true }))
    })
    const saveButton = container.querySelector('button[aria-label="保存"]') as HTMLElement
    act(() => { saveButton.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    expect(container.textContent).toContain('修改后的消息')

    await render(false)
    expect(onSend).toHaveBeenCalledWith('修改后的消息', [], [], { highPermission: false, fromQueue: true })

    // 删除后队列清空
    const second = await renderInput(true)
    typeMessage(second.container, '待删除消息')
    const deleteButton = second.container.querySelector('button[aria-label="删除"]') as HTMLElement
    act(() => { deleteButton.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    expect(second.container.textContent).not.toContain('待发送队列')
    await second.render(false)
    expect(second.onSend).not.toHaveBeenCalled()
  })

  it('立即发送会停止当前回复并优先发送目标项', async () => {
    const { container, onSend, onStop, render } = await renderInput(true)

    typeMessage(container, '第一条')
    typeMessage(container, '第二条')
    expect(container.textContent).toContain('待发送队列（2）')

    const sendNowButtons = container.querySelectorAll('button[aria-label="立即发送"]')
    expect(sendNowButtons.length).toBe(2)
    act(() => { (sendNowButtons[1] as HTMLElement).dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    expect(onStop).toHaveBeenCalledTimes(1)

    await render(false)
    expect(onSend).toHaveBeenCalledTimes(1)
    expect(onSend).toHaveBeenCalledWith('第二条', [], [], { highPermission: false, fromQueue: true })
    // 第一条仍在队列中，等待本轮回复结束后继续发送
    expect(container.textContent).toContain('第一条')
  })
})
