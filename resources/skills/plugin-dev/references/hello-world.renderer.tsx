/**
 * Hello World 能力参考插件 — 渲染端（单文件、按 Tab 分组演示各项能力）。
 *
 * 覆盖能力：
 *  - bridge.invoke / bridge.onEvent（主进程 IPC 调用与广播订阅）
 *  - host.i18n.t（插件命名空间多语言）
 *  - entry.views（宿主 UI 注入：chat.toolbar）
 *  - hostCapabilities：主题/语言、剪贴板、文件对话框、外部文件订阅
 */
import { useEffect, useReducer, useRef, useState } from 'react'
import {
  Alert,
  Button,
  Card,
  Input,
  Space,
  Tabs,
  Tag,
  Typography,
} from 'antd'
import type { PluginRendererEntry, PluginRendererHost } from '@workavatar/plugin-sdk/renderer'

let hostRef: PluginRendererHost | null = null

const t = (key: string, options?: Record<string, unknown>): string =>
  hostRef?.i18n.t(key, options as never) ?? key

/** 订阅主进程广播事件（bridge.onEvent），自动管理取消 */
function usePluginEvent<T = unknown>(event: string, cb: (payload: T) => void): void {
  const cbRef = useRef(cb)
  cbRef.current = cb
  useEffect(() => {
    if (!hostRef) return
    return hostRef.bridge.onEvent(event, (p) => cbRef.current(p as T))
  }, [event])
}

/** 调用主进程 IPC，异常转为 { error } */
async function call<T = Record<string, unknown>>(channel: string, payload?: unknown): Promise<T | null> {
  try {
    return (await hostRef?.bridge.invoke<T>(channel, payload)) ?? null
  } catch (err: any) {
    return { error: err?.message ?? String(err) } as T
  }
}

/** 结果展示：主进程返回的 i18n key（helloWorld.*）翻译为本地化文案，其余原样 */
function localize(v: unknown): string {
  return typeof v === 'string' && v.startsWith('helloWorld.') ? t(v) : String(v)
}

/** 结果行（成功/错误/等待态） */
function Result({ value }: { value: string }) {
  if (!value) return null
  const isError = typeof value === 'string' && value.startsWith('error:')
  const text = isError ? value.slice(6) : value
  return (
    <Typography.Text type={isError ? 'danger' : 'success'} style={{ wordBreak: 'break-all' }}>
      {text}
    </Typography.Text>
  )
}

// ====== Tab 1：IPC 与存储 ======

function IpcTab() {
  const [greetResult, setGreetResult] = useState('')
  const [count, setCount] = useState(0)
  const [eventLine, setEventLine] = useState('')
  const [kvKey, setKvKey] = useState('')
  const [kvValue, setKvValue] = useState('')
  const [kvResult, setKvResult] = useState('')
  const [memo, setMemo] = useState('')
  const [memoResult, setMemoResult] = useState('')

  usePluginEvent<{ count: number }>('count-changed', (p) => setCount(p?.count ?? 0))

  const greet = async () => {
    const res = await call<{ message?: string; error?: string }>('greet', { name: 'Plugin' })
    setGreetResult(res?.error ? `error:${res.error}` : (res?.message ?? ''))
  }
  const countNow = async () => {
    // 用 IPC 返回值即时刷新；count-changed 广播负责跨窗口/后续同步
    const res = await call<{ count?: number }>('count')
    if (res?.count != null) setCount(res.count)
  }
  const kvSet = async () => {
    const res = await call('kv-set', { key: kvKey, value: kvValue })
    setKvResult(JSON.stringify(res))
  }
  const kvGet = async () => {
    const res = await call('kv-get', { key: kvKey })
    setKvResult(JSON.stringify(res))
  }
  const kvKeys = async () => {
    const res = await call('kv-keys')
    setKvResult(JSON.stringify(res))
  }
  const kvDelete = async () => {
    const res = await call('kv-delete', { key: kvKey })
    setKvResult(JSON.stringify(res))
  }
  const memoAdd = async () => {
    const res = await call<{ ok?: boolean; error?: string }>('memo-add', { content: memo })
    setMemoResult(res?.error ? `error:${localize(res.error)}` : JSON.stringify(res))
  }
  const memoList = async () => {
    const res = await call('memo-list')
    setMemoResult(JSON.stringify(res))
  }
  const memoCount = async () => {
    const res = await call('memo-count')
    setMemoResult(JSON.stringify(res))
  }
  const publishPing = async () => {
    const res = await call('publish-ping')
    setEventLine(JSON.stringify(res))
  }

  return (
    <Space direction="vertical" size="middle" style={{ width: '100%' }}>
      <Card size="small" title={t('helloWorld.card.ipc')}>
        <Space wrap>
          <Button onClick={greet}>{t('helloWorld.btn.greet')}</Button>
          <Button onClick={countNow}>{t('helloWorld.btn.count')}</Button>
          <Button onClick={publishPing}>{t('helloWorld.btn.publish')}</Button>
        </Space>
        <div style={{ marginTop: 8 }}>
          <Typography.Text>{t('helloWorld.event.count', { n: count })}</Typography.Text>
          {greetResult && <div><Result value={greetResult} /></div>}
          {eventLine && (
            <Typography.Text type="secondary">
              {t('helloWorld.event.publish', { v: eventLine })}
            </Typography.Text>
          )}
        </div>
      </Card>
      <Card size="small" title={t('helloWorld.card.kv')}>
        <Space wrap>
          <Input
            style={{ width: 140 }}
            placeholder={t('helloWorld.kv.key')}
            value={kvKey}
            onChange={(e) => setKvKey(e.target.value)}
          />
          <Input
            style={{ width: 140 }}
            placeholder={t('helloWorld.kv.value')}
            value={kvValue}
            onChange={(e) => setKvValue(e.target.value)}
          />
          <Button onClick={kvSet}>{t('helloWorld.kv.set')}</Button>
          <Button onClick={kvGet}>{t('helloWorld.kv.get')}</Button>
          <Button onClick={kvKeys}>{t('helloWorld.kv.keys')}</Button>
          <Button onClick={kvDelete}>{t('helloWorld.kv.delete')}</Button>
        </Space>
        <div style={{ marginTop: 8 }}><Result value={kvResult} /></div>
      </Card>
      <Card size="small" title={t('helloWorld.card.memo')}>
        <Space wrap>
          <Input
            style={{ width: 220 }}
            placeholder={t('helloWorld.memo.content')}
            value={memo}
            onChange={(e) => setMemo(e.target.value)}
          />
          <Button onClick={memoAdd}>{t('helloWorld.memo.add')}</Button>
          <Button onClick={memoList}>{t('helloWorld.memo.list')}</Button>
          <Button onClick={memoCount}>{t('helloWorld.memo.count')}</Button>
        </Space>
        <div style={{ marginTop: 8 }}><Result value={memoResult} /></div>
      </Card>
    </Space>
  )
}

// ====== Tab 2：系统能力 ======

function SystemTab() {
  const [schedulerState, setSchedulerState] = useState('')
  const [notifyResult, setNotifyResult] = useState('')
  const [windowResult, setWindowResult] = useState('')
  const [nativeResult, setNativeResult] = useState('')
  const [modulesResult, setModulesResult] = useState('')
  const [events, setEvents] = useState<string[]>([])

  usePluginEvent<{ ts?: number }>('tick', (p) =>
    setEvents((prev) => [...prev.slice(-4), t('helloWorld.event.tick', { ts: p?.ts ?? '-' })]))
  usePluginEvent<{ ts?: number }>('shortcut-pressed', (p) =>
    setEvents((prev) => [...prev.slice(-4), t('helloWorld.event.shortcut', { ts: p?.ts ?? '-' })]))

  const schedulerStart = async () => {
    const res = await call<{ jobId?: string; running?: boolean; error?: string }>('scheduler-start')
    if (res?.error) setSchedulerState(`error:${res.error}`)
    else setSchedulerState(t('helloWorld.sys.schedulerRunning', { id: String(res?.jobId ?? '-') }))
  }
  const schedulerStop = async () => {
    const res = await call('scheduler-stop')
    setSchedulerState(JSON.stringify(res))
  }
  const notify = async () => {
    const res = await call('notify', { title: t('helloWorld.sys.notify'), body: t('helloWorld.notify.body') })
    setNotifyResult(JSON.stringify(res))
  }
  const openWindow = async () => {
    const res = await call('window-open')
    setWindowResult(JSON.stringify(res))
  }
  const nativeBorrow = async () => {
    const res = await call<{ ok?: boolean; sqliteVersion?: string; error?: string }>('native-borrow')
    setNativeResult(res?.error ? `error:${localize(res.error)}` : JSON.stringify(res))
  }
  const nativeModules = async () => {
    const res = await call('host-native-modules')
    setModulesResult(JSON.stringify(res))
  }

  return (
    <Space direction="vertical" size="middle" style={{ width: '100%' }}>
      {events.length > 0 && (
        <Alert
          type="info"
          showIcon
          message={t('helloWorld.event.last')}
          description={<Space direction="vertical" size={0}>{events.map((e, i) => (
            <Typography.Text key={i} type="secondary">{e}</Typography.Text>
          ))}</Space>}
        />
      )}
      <Card size="small" title={t('helloWorld.card.scheduler')}>
        <Space wrap>
          <Button onClick={schedulerStart}>{t('helloWorld.sys.schedulerStart')}</Button>
          <Button onClick={schedulerStop}>{t('helloWorld.sys.schedulerStop')}</Button>
        </Space>
        <div style={{ marginTop: 8 }}><Result value={schedulerState} /></div>
      </Card>
      <Card size="small" title={t('helloWorld.card.notifyWindow')}>
        <Space wrap>
          <Button onClick={notify}>{t('helloWorld.sys.notify')}</Button>
          <Button onClick={openWindow}>{t('helloWorld.sys.window')}</Button>
        </Space>
        <div style={{ marginTop: 8 }}>
          <Result value={notifyResult} />
          <Result value={windowResult} />
        </div>
      </Card>
      <Card size="small" title={t('helloWorld.card.native')}>
        <Space wrap>
          <Button onClick={nativeBorrow}>{t('helloWorld.sys.native')}</Button>
          <Button onClick={nativeModules}>{t('helloWorld.sys.modules')}</Button>
        </Space>
        <Typography.Text type="secondary" style={{ display: 'block', marginTop: 8 }}>
          {t('helloWorld.sys.shortcut')}
        </Typography.Text>
        <div style={{ marginTop: 4 }}>
          <Result value={nativeResult} />
          <Result value={modulesResult} />
        </div>
      </Card>
    </Space>
  )
}

// ====== Tab 3：数据与执行 ======

function DataTab() {
  const [convResult, setConvResult] = useState('')
  const [prompt, setPrompt] = useState('')
  const [llmResult, setLlmResult] = useState('')

  const conversations = async () => {
    const res = await call('data-conversations')
    setConvResult(res?.error ? `error:${res.error}` : JSON.stringify(res))
  }
  const llmRun = async () => {
    const res = await call<{ ok?: boolean; output?: unknown; error?: string }>('execute-llm', { prompt })
    setLlmResult(res?.error ? `error:${res.error}` : JSON.stringify(res))
  }

  return (
    <Space direction="vertical" size="middle" style={{ width: '100%' }}>
      <Card size="small" title={t('helloWorld.card.data')}>
        <Space wrap>
          <Button onClick={conversations}>{t('helloWorld.data.conversations')}</Button>
        </Space>
        <div style={{ marginTop: 8 }}><Result value={convResult} /></div>
      </Card>
      <Card size="small" title={t('helloWorld.card.execute')}>
        <Space wrap>
          <Input
            style={{ width: 260 }}
            placeholder={t('helloWorld.data.llmPrompt')}
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
          />
          <Button onClick={llmRun}>{t('helloWorld.data.llmRun')}</Button>
        </Space>
        <Typography.Text type="secondary" style={{ display: 'block', marginTop: 8 }}>
          {t('helloWorld.data.llmNote')}
        </Typography.Text>
        <div style={{ marginTop: 4 }}><Result value={llmResult} /></div>
      </Card>
    </Space>
  )
}

// ====== Tab 4：协作（shared / bus） ======

function CollabTab() {
  const [sharedKey, setSharedKey] = useState('')
  const [sharedValue, setSharedValue] = useState('')
  const [sharedResult, setSharedResult] = useState('')
  const [busMessage, setBusMessage] = useState('')
  const [busResult, setBusResult] = useState('')

  const sharedSet = async () => {
    const res = await call('shared-set', { key: sharedKey, value: sharedValue })
    setSharedResult(JSON.stringify(res))
  }
  const sharedGet = async () => {
    const res = await call('shared-get', { key: sharedKey })
    setSharedResult(JSON.stringify(res))
  }
  const busEcho = async () => {
    const res = await call('bus-echo', { message: busMessage })
    setBusResult(res?.error ? `error:${res.error}` : JSON.stringify(res))
  }

  return (
    <Space direction="vertical" size="middle" style={{ width: '100%' }}>
      <Card size="small" title={t('helloWorld.card.shared')}>
        <Space wrap>
          <Input style={{ width: 140 }} placeholder={t('helloWorld.collab.key')} value={sharedKey}
            onChange={(e) => setSharedKey(e.target.value)} />
          <Input style={{ width: 140 }} placeholder={t('helloWorld.collab.value')} value={sharedValue}
            onChange={(e) => setSharedValue(e.target.value)} />
          <Button onClick={sharedSet}>{t('helloWorld.collab.set')}</Button>
          <Button onClick={sharedGet}>{t('helloWorld.collab.get')}</Button>
        </Space>
        <div style={{ marginTop: 8 }}><Result value={sharedResult} /></div>
      </Card>
      <Card size="small" title={t('helloWorld.card.bus')}>
        <Space wrap>
          <Input style={{ width: 220 }} placeholder={t('helloWorld.collab.busMessage')} value={busMessage}
            onChange={(e) => setBusMessage(e.target.value)} />
          <Button onClick={busEcho}>{t('helloWorld.collab.echo')}</Button>
        </Space>
        <Typography.Text type="secondary" style={{ display: 'block', marginTop: 8 }}>
          {t('helloWorld.collab.note')}
        </Typography.Text>
        <div style={{ marginTop: 4 }}><Result value={busResult} /></div>
      </Card>
    </Space>
  )
}

// ====== Tab 5：贡献点 ======

function ContribTab() {
  const [commandResult, setCommandResult] = useState('')

  const runCommand = async () => {
    const res = await call('command:hello')
    setCommandResult(res?.error ? `error:${res.error}` : JSON.stringify(res))
  }

  return (
    <Space direction="vertical" size="middle" style={{ width: '100%' }}>
      <Card size="small" title={t('helloWorld.card.command')}>
        <Space wrap>
          <Button onClick={runCommand}>{t('helloWorld.contrib.command')}</Button>
        </Space>
        <Typography.Text type="secondary" style={{ display: 'block', marginTop: 8 }}>
          {t('helloWorld.contrib.commandNote')}
        </Typography.Text>
        <div style={{ marginTop: 4 }}><Result value={commandResult} /></div>
      </Card>
      <Card size="small" title={t('helloWorld.card.contrib')}>
        <Typography.Paragraph style={{ margin: 0 }}>
          <Tag>{t('helloWorld.contrib.actionNote')}</Tag>
          <Tag>{t('helloWorld.contrib.toolNote')}</Tag>
          <Tag>{t('helloWorld.contrib.fileNote')}</Tag>
          <Tag>{t('helloWorld.contrib.viewNote')}</Tag>
        </Typography.Paragraph>
      </Card>
    </Space>
  )
}

// ====== Tab 6：宿主能力 ======

function HostTab() {
  const [theme, setTheme] = useState<'light' | 'dark' | ''>('')
  const [locale, setLocale] = useState('')
  const [clipResult, setClipResult] = useState('')
  const [dialogResult, setDialogResult] = useState('')
  const [externalFiles, setExternalFiles] = useState<string[]>([])

  useEffect(() => {
    const caps = hostRef?.hostCapabilities
    if (!caps) return
    setTheme(caps.getTheme())
    setLocale(caps.getLocale())
    const unTheme = caps.onThemeChange((isDark) => setTheme(isDark ? 'dark' : 'light'))
    const unLocale = caps.onLocaleChange((lng) => setLocale(lng))
    const unFiles = caps.subscribeExternalFiles((absPath) =>
      setExternalFiles((prev) => [...prev.slice(-4), absPath]))
    return () => {
      unTheme?.()
      unLocale?.()
      unFiles?.()
    }
  }, [])

  const clipWrite = async () => {
    await hostRef?.hostCapabilities?.clipboard.writeText(t('helloWorld.clip.sample'))
    setClipResult(t('helloWorld.clip.written'))
  }
  const clipRead = async () => {
    const text = await hostRef?.hostCapabilities?.clipboard.readText()
    setClipResult(text || t('helloWorld.clip.empty'))
  }
  const pickFile = async () => {
    const paths = await hostRef?.hostCapabilities?.showOpenDialog()
    setDialogResult(JSON.stringify(paths ?? []))
  }

  return (
    <Space direction="vertical" size="middle" style={{ width: '100%' }}>
      <Card size="small" title={t('helloWorld.card.host')}>
        <Space wrap>
          <Tag color="blue">{t('helloWorld.host.theme', { v: theme || '-' })}</Tag>
          <Tag color="geekblue">{t('helloWorld.host.locale', { v: locale || '-' })}</Tag>
          <Button onClick={clipWrite}>{t('helloWorld.clip.write')}</Button>
          <Button onClick={clipRead}>{t('helloWorld.clip.read')}</Button>
          <Button onClick={pickFile}>{t('helloWorld.host.dialog')}</Button>
        </Space>
        <div style={{ marginTop: 8 }}>
          <Result value={clipResult} />
          <Result value={dialogResult} />
        </div>
      </Card>
      <Card size="small" title={t('helloWorld.card.external')}>
        {externalFiles.length === 0 ? (
          <Typography.Text type="secondary">{t('helloWorld.host.externalEmpty')}</Typography.Text>
        ) : (
          <Space direction="vertical" size={0}>
            {externalFiles.map((f, i) => <Typography.Text key={i} type="secondary">{f}</Typography.Text>)}
          </Space>
        )}
      </Card>
    </Space>
  )
}

// ====== 主页面 ======

function HelloPage() {
  const [, bump] = useReducer((x: number) => x + 1, 0)

  // 语言切换时全页重渲染，host.i18n.t 文案即时刷新
  useEffect(() => {
    const unsub = hostRef?.hostCapabilities?.onLocaleChange?.(() => bump())
    return () => unsub?.()
  }, [])

  const items = [
    { key: 'ipc', label: t('helloWorld.tabs.ipc'), children: <IpcTab /> },
    { key: 'system', label: t('helloWorld.tabs.system'), children: <SystemTab /> },
    { key: 'data', label: t('helloWorld.tabs.data'), children: <DataTab /> },
    { key: 'collab', label: t('helloWorld.tabs.collab'), children: <CollabTab /> },
    { key: 'contrib', label: t('helloWorld.tabs.contrib'), children: <ContribTab /> },
    { key: 'host', label: t('helloWorld.tabs.host'), children: <HostTab /> },
  ]

  return (
    <div style={{ maxWidth: 860, margin: '16px auto', padding: '0 16px' }}>
      <Typography.Title level={4} style={{ margin: 0 }}>{t('helloWorld.home.title')}</Typography.Title>
      <Typography.Paragraph type="secondary">{t('helloWorld.home.desc')}</Typography.Paragraph>
      <Tabs items={items} />
    </div>
  )
}

/** chat.toolbar 注入组件：宿主对话输入框工具栏上的小徽标 */
function HelloToolbar() {
  return (
    <Tag
      color="cyan"
      style={{ cursor: 'pointer', margin: 0 }}
      onClick={() => hostRef?.bridge.invoke('command:hello')}
      title={t('helloWorld.view.toolbarTip')}
    >
      {t('helloWorld.view.toolbar')}
    </Tag>
  )
}

const entry: PluginRendererEntry = {
  routes: [{ path: '', component: HelloPage }],
  views: [{ view: 'chat.toolbar', component: HelloToolbar }],
  init(host: PluginRendererHost): void {
    hostRef = host
  },
  dispose(): void {
    hostRef = null
  },
}

export default entry