// @vitest-environment jsdom
import { describe, it, expect, vi, beforeAll } from 'vitest'
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { ConfigProvider, App as AntApp, theme } from 'antd'

/**
 * useNotification 主题回归：
 * antd 静态 notification.open 渲染在独立 root，不消费 React 树中的 ConfigProvider 主题，
 * 暗色主题下弹窗仍是白底。这里验证通知实例确实取自 App 上下文（ConfigProvider 级
 * notification 配置能作用到弹窗），上下文实例与主题同源，暗色主题才能生效。
 */

/** 捕获 hook 订阅的 NOTIFY 回调，用于手动触发通知 */
let notifyHandler: ((payload: any) => void) | null = null

;(globalThis as any).window.electronAPI = {
  notification: {
    onNotify: (cb: (payload: any) => void) => { notifyHandler = cb; return () => { notifyHandler = null } },
    onNotifyClick: () => () => { /* noop */ },
  },
}

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))

const { useNotification } = await import('../../../src/hooks/useNotification')

const Harness: React.FC = () => {
  useNotification(() => { /* noop */ })
  return null
}

beforeAll(() => {
  ;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true
  if (!window.matchMedia) {
    Object.defineProperty(window, 'matchMedia', {
      writable: true,
      value: (query: string) => ({
        matches: false, media: query, onchange: null,
        addListener: () => { /* noop */ }, removeListener: () => { /* noop */ },
        addEventListener: () => { /* noop */ }, removeEventListener: () => { /* noop */ },
        dispatchEvent: () => false,
      }),
    })
  }
})

describe('useNotification 主题跟随', () => {
  it('暗色主题下通知走 App 上下文实例（消费 ConfigProvider 配置，而非静态独立 root）', async () => {
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    act(() => {
      root.render(
        <ConfigProvider
          theme={{ algorithm: theme.darkAlgorithm }}
          notification={{ className: 'ctx-notification-marker' }}
        >
          <AntApp>
            <Harness />
          </AntApp>
        </ConfigProvider>
      )
    })

    expect(notifyHandler).toBeTruthy()
    await act(async () => {
      notifyHandler!({ title: '任务完成', body: '自动化已执行完毕' })
    })

    const notice = document.querySelector('.ant-notification-notice')
    expect(notice).toBeTruthy()
    // 静态 API 的弹窗不带该 marker（不消费 ConfigProvider），暗色主题也就无从生效
    expect(notice!.classList.contains('ctx-notification-marker')).toBe(true)

    await act(async () => { root.unmount() })
    container.remove()
  })
})
