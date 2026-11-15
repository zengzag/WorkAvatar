// @vitest-environment jsdom
import { describe, it, expect, vi, beforeAll, afterEach } from 'vitest'
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { ConfigProvider, App as AntApp } from 'antd'

import '../../../src/i18n'
import ChatInput, { extractSelectionText } from '../../../src/components/workbench/ChatInput'

/**
 * 输入框复制：文件令牌以绝对路径写入剪贴板，
 * 避免选中令牌后复制结果丢失路径或只剩显示名。
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
  delete (window as any).electronAPI
  document.body.innerHTML = ''
})

function selectAll(editor: HTMLElement) {
  const range = document.createRange()
  range.selectNodeContents(editor)
  const sel = window.getSelection()!
  sel.removeAllRanges()
  sel.addRange(range)
}

const TOKEN_HTML =
  'hello <span class="chat-input-file-token" contenteditable="false" data-id="f1" data-name="a.pdf" data-path="C:\\tmp\\a.pdf">' +
  'a.pdf<span class="chat-input-file-token-close">×</span></span> world'

describe('extractSelectionText', () => {
  it('把选区中的文件令牌替换为绝对路径', () => {
    const editor = document.createElement('div')
    editor.innerHTML = TOKEN_HTML
    document.body.appendChild(editor)
    selectAll(editor)

    expect(extractSelectionText(editor)).toBe('hello C:\\tmp\\a.pdf world')
  })
})

describe('ChatInput 复制', () => {
  it('Ctrl+C 复制含文件令牌的选区时写入路径', async () => {
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    await act(async () => {
      root.render(
        <ConfigProvider>
          <AntApp>
            <ChatInput
              onSend={vi.fn()}
              onStop={vi.fn()}
              isStreaming={false}
              placeholder="test"
              providers={[]}
              attachedImages={[]}
              onImagesChange={vi.fn()}
              selectedModels={[]}
              onModelsChange={vi.fn()}
              selectedCollectionIds={[]}
              onSelectedCollectionIdsChange={vi.fn()}
              allCollections={[]}
              minimalMode={false}
              onMinimalModeChange={vi.fn()}
              canToggleMinimalMode
            />
          </AntApp>
        </ConfigProvider>
      )
    })
    pendings.push(async () => {
      await act(async () => { root.unmount() })
      container.remove()
    })

    const editor = container.querySelector('.workbench-input') as HTMLElement
    expect(editor).toBeTruthy()

    act(() => {
      editor.innerHTML = TOKEN_HTML
      selectAll(editor)
    })

    const setData = vi.fn()
    const event = new Event('copy', { bubbles: true, cancelable: true })
    Object.defineProperty(event, 'clipboardData', { value: { setData } })
    await act(async () => {
      editor.dispatchEvent(event)
    })

    expect(setData).toHaveBeenCalledWith('text/plain', 'hello C:\\tmp\\a.pdf world')
  })
})
