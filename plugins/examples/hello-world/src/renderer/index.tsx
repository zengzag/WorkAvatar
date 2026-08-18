import { useEffect, useState } from 'react'
import { Button, Card, Space, Typography } from 'antd'
import type { PluginRendererEntry, PluginRendererHost } from '@workavatar/plugin-sdk/renderer'

let hostRef: PluginRendererHost | null = null

function HelloPage() {
  const [message, setMessage] = useState('')
  const [count, setCount] = useState(0)

  useEffect(() => {
    // 订阅主进程广播事件（count-changed）
    const unsub = hostRef?.bridge.onEvent('count-changed', (payload) => {
      setCount((payload as { count?: number })?.count ?? 0)
    })
    return () => unsub?.()
  }, [])

  const greet = async () => {
    const res = await hostRef?.bridge.invoke<{ message: string }>('greet', { name: 'Plugin' })
    setMessage(res?.message ?? '')
  }

  const bump = async () => {
    await hostRef?.bridge.invoke('count')
  }

  return (
    <Card title="Hello World 示例插件" style={{ maxWidth: 480, margin: 24 }}>
      <Space direction="vertical">
        <Typography.Text>这是一个最小示例插件，演示 IPC 调用与事件发布。</Typography.Text>
        <Space>
          <Button onClick={greet}>调用 greet</Button>
          <Button onClick={bump}>计数 +1</Button>
        </Space>
        {message && <Typography.Text type="success">{message}</Typography.Text>}
        <Typography.Text>当前计数（经事件推送）：{count}</Typography.Text>
      </Space>
    </Card>
  )
}

const entry: PluginRendererEntry = {
  routes: [{ path: '', component: HelloPage }],
  init(host: PluginRendererHost): void {
    hostRef = host
  },
  dispose(): void {
    hostRef = null
  },
}

export default entry
