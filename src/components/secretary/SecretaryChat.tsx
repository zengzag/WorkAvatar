import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { App, Button, theme, Tooltip } from 'antd'
import { ExportOutlined } from '@ant-design/icons'
import { useTranslation } from 'react-i18next'
import type { GeneratedFileInfo } from '../../types'
import AnswerSegment from '../workbench/AnswerSegment'
import { useSecretaryStore, type SecretaryTask } from './secretary.store'
import { subscribeSecretaryStream } from './secretary-runner'

interface SecretaryChatProps {
  task?: SecretaryTask
  onOpenInMain: (task: SecretaryTask) => void
}

interface ChatMessage {
  id: string
  role: 'user' | 'assistant'
  content: string
  /** 工具产出的文件：小窗只露文件名，点击用系统软件打开 */
  files: GeneratedFileInfo[]
}

/** 汇总消息段里的工具产物，按路径去重（后写覆盖先写） */
function collectGeneratedFiles(segments: unknown): GeneratedFileInfo[] {
  const map = new Map<string, GeneratedFileInfo>()
  for (const seg of Array.isArray(segments) ? segments : []) {
    if (!Array.isArray((seg as any)?.generatedFiles)) continue
    for (const file of (seg as any).generatedFiles as GeneratedFileInfo[]) {
      if (file?.path) map.set(file.path, file)
    }
  }
  return Array.from(map.values())
}

/**
 * 面板主体：对话窗。
 * 有任务时渲染该任务的问答（可实时接入流式输出）；没有任务时不渲染，
 * 让默认窗口保持「头部 + 输入框」的精简形态。
 */
const SecretaryChat: React.FC<SecretaryChatProps> = ({ task, onOpenInMain }) => {
  const { t } = useTranslation()
  const { token } = theme.useToken()
  const { message } = App.useApp()

  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [loading, setLoading] = useState(true)
  const [live, setLive] = useState<{ id: string; content: string } | null>(null)
  const liveRef = useRef<{ id: string; content: string } | null>(null)
  /** 主窗口在同一任务上发起的运行中会话（实时接入展示） */
  const [remote, setRemote] = useState<{ sessionId: string; content: string } | null>(null)
  const remoteRef = useRef<{ sessionId: string; content: string } | null>(null)
  const bodyRef = useRef<HTMLDivElement>(null)
  const markViewed = useSecretaryStore((s) => s.markViewed)

  const taskId = task?.id
  const conversationId = task?.conversationId
  /** 已做过首次定位的任务：再次同步消息时不再强制拉到底部，避免打断用户上滚查看 */
  const loadedTaskRef = useRef<string | undefined>(undefined)

  /** 跟随到底部；用户主动上滚后不再强行拉回 */
  const scrollToBottom = useCallback((force = false) => {
    const el = bodyRef.current
    if (!el) return
    if (force || el.scrollHeight - el.scrollTop - el.clientHeight < 80) {
      el.scrollTop = el.scrollHeight
    }
  }, [])

  const load = useCallback(async (): Promise<ChatMessage[]> => {
    if (!conversationId) {
      setMessages([])
      setLoading(false)
      return []
    }
    let list: ChatMessage[] = []
    try {
      const conversation = await window.electronAPI.conversation.get(conversationId)
      const parsed = conversation?.messages_json ? JSON.parse(conversation.messages_json) : []
      list = Array.isArray(parsed)
        ? parsed
          .filter((m: any) => m?.role === 'user' || m?.role === 'assistant')
          .map((m: any) => ({
            id: String(m.id || ''),
            role: m.role,
            content: String(m.content || ''),
            files: m.role === 'assistant' ? collectGeneratedFiles(m.segments) : [],
          }))
        : []
      setMessages(list)
    } catch {
      setMessages([])
    } finally {
      setLoading(false)
    }
    // 首次进入该任务：等消息渲染与 Markdown 排版完成后再强制滚到最新一条
    const firstLoad = loadedTaskRef.current !== taskId
    if (firstLoad) {
      loadedTaskRef.current = taskId
      window.requestAnimationFrame(() => {
        scrollToBottom(true)
        window.requestAnimationFrame(() => scrollToBottom(true))
      })
    }
    return list
  }, [conversationId, taskId, scrollToBottom])

  const applyLive = useCallback((next: { id: string; content: string } | null) => {
    liveRef.current = next
    setLive(next)
  }, [])

  const applyRemote = useCallback((next: { sessionId: string; content: string } | null) => {
    remoteRef.current = next
    setRemote(next)
  }, [])

  // 切换任务时重新拉取会话
  useEffect(() => {
    setLoading(true)
    applyLive(null)
    applyRemote(null)
    void load()
  }, [load, applyLive, applyRemote])

  /** 任务落到已结束状态即为已查看（面板主体已经展示了内容） */
  useEffect(() => {
    if (!taskId) return
    if (task?.status === 'done' || task?.status === 'failed') markViewed(taskId)
  }, [taskId, task?.status, markViewed])

  /**
   * 收尾后从 DB 重新同步。
   * 库里最后一条已是助手消息即代表该轮回答已落库：收起流式临时展示，
   * 以 DB（主窗口任务）为准，避免同一段回答显示两遍。
   */
  const reloadAndSettleRemote = useCallback(async () => {
    const list = await load()
    const last = list[list.length - 1]
    if (last?.role !== 'assistant') return
    if (liveRef.current) applyLive(null)
    if (remoteRef.current) applyRemote(null)
  }, [load, applyLive, applyRemote])

  // 本地任务流式增量：只接受当前任务的 session
  useEffect(() => {
    if (!taskId) return
    return subscribeSecretaryStream((snapshot) => {
      if (snapshot.taskId !== taskId) return
      applyLive({ id: snapshot.assistantMessageId, content: snapshot.content })
      if (snapshot.streaming) return
      // 主窗口接入时由它收尾落库，可能晚于 done：库里还没同步到就继续显示流式内容
      void reloadAndSettleRemote()
    })
  }, [taskId, applyLive, reloadAndSettleRemote])

  // 主窗口（或其他窗口）在同一任务上发起会话：接入并在面板内实时展示
  useEffect(() => {
    if (!conversationId) return
    let settleTimer = 0
    const offStarted = window.electronAPI.llm.onSessionStarted?.(({ sessionId, conversationId: cid }) => {
      if (cid !== conversationId) return
      applyRemote({ sessionId, content: '' })
      void window.electronAPI.llm.attachSession(sessionId).catch(() => {})
    })
    const offChunk = window.electronAPI.llm.onChunk(({ sessionId, chunk, chunks }) => {
      const current = remoteRef.current
      if (!current || current.sessionId !== sessionId) return
      const text = chunk ?? (chunks ? chunks.join('') : '')
      if (!text) return
      applyRemote({ sessionId, content: current.content + text })
    })
    const finish = (sessionId: string) => {
      if (remoteRef.current?.sessionId !== sessionId) return
      // 发起窗口收尾落库是异步的：稍后再从 DB 同步，期间保留已展示内容
      if (settleTimer) window.clearTimeout(settleTimer)
      settleTimer = window.setTimeout(() => {
        settleTimer = 0
        void reloadAndSettleRemote()
      }, 300)
    }
    const offDone = window.electronAPI.llm.onDone(({ sessionId }) => finish(sessionId))
    const offError = window.electronAPI.llm.onError(({ sessionId }) => finish(sessionId))
    return () => {
      if (settleTimer) window.clearTimeout(settleTimer)
      offStarted?.()
      offChunk()
      offDone()
      offError()
    }
  }, [conversationId, reloadAndSettleRemote, applyRemote])

  // 任务在任一窗口产生写入（用户消息/收尾落库）后同步消息
  useEffect(() => {
    if (!conversationId) return
    let timer = 0
    const off = window.electronAPI.conversation.onChanged?.((data) => {
      if (data.id !== conversationId || data.action !== 'update') return
      if (timer) window.clearTimeout(timer)
      timer = window.setTimeout(() => {
        timer = 0
        void reloadAndSettleRemote()
      }, 200)
    })
    return () => {
      if (timer) window.clearTimeout(timer)
      off?.()
    }
  }, [conversationId, reloadAndSettleRemote])

  // 新的问答/流式增量后跟随到底部
  useEffect(() => {
    const raf = window.requestAnimationFrame(() => scrollToBottom())
    return () => window.cancelAnimationFrame(raf)
  }, [messages, live?.content, remote?.content, scrollToBottom])

  /** 文件产物：交给系统默认软件打开 */
  const openFile = useCallback(async (filePath: string) => {
    const res = await window.electronAPI.kms.openFile(filePath)
    if (res?.error) message.error(`${t('workbench.openWithSystemFailed')}: ${res.error}`)
  }, [message, t])

  const rows = useMemo(() => messages.filter((m) => m.content.trim().length > 0), [messages])

  // 没有活动对话时不占任何高度：默认窗口保持「头部 + 输入框」的精简形态
  if (!task) return null

  return (
    <div className="secretary-chat">
      <div className="secretary-chat-meta">
        <span className="secretary-chat-title" title={task.title} style={{ color: token.colorTextTertiary }}>
          {task.title}
        </span>
        <Tooltip title={t('secretary.openInMain')}>
          <Button
            type="text"
            size="small"
            icon={<ExportOutlined />}
            disabled={!conversationId}
            style={{ color: token.colorTextTertiary, flexShrink: 0, paddingInline: 4, fontSize: 11 }}
            onClick={() => onOpenInMain(task)}
          />
        </Tooltip>
      </div>

      <div className="secretary-chat-body" ref={bodyRef}>
        {rows.map((m) => m.role === 'user' ? (
          <div
            key={m.id}
            className="secretary-chat-user"
            style={{ background: token.colorFillTertiary, color: token.colorText }}
          >
            {m.content}
          </div>
        ) : (
          <div key={m.id} className="secretary-chat-assistant">
            <AnswerSegment seg={{ id: m.id, type: 'answer', content: m.content }} isError={false} />
            {m.files.length > 0 && (
              <div className="secretary-chat-files">
                {m.files.map((file) => (
                  <button
                    key={file.path}
                    type="button"
                    className="secretary-chat-file"
                    style={{ color: token.colorLink }}
                    title={file.path}
                    onClick={() => void openFile(file.path)}
                  >
                    {file.name}
                  </button>
                ))}
              </div>
            )}
          </div>
        ))}
        {live && (
          <div className="secretary-chat-assistant">
            <AnswerSegment
              seg={{ id: live.id, type: 'answer', content: live.content, isStreaming: true }}
              isError={false}
            />
          </div>
        )}
        {remote && (
          <div className="secretary-chat-assistant">
            <AnswerSegment
              seg={{ id: `remote_${remote.sessionId}`, type: 'answer', content: remote.content, isStreaming: true }}
              isError={false}
            />
          </div>
        )}
        {(task.status === 'running' || task.status === 'waiting') && !live && !remote && (
          <div className="secretary-chat-typing" style={{ color: token.colorTextTertiary }}>
            <span
              className="secretary-spin"
              style={{ borderTopColor: task.status === 'waiting' ? token.colorWarning : token.colorPrimary }}
            />
            <span>{task.status === 'waiting' ? t('secretary.waiting') : (task.step || t('secretary.working'))}</span>
          </div>
        )}
        {!loading && rows.length === 0 && !live && !remote
          && !(task.status === 'running' || task.status === 'waiting') && (
          <div className="secretary-chat-empty" style={{ color: token.colorTextQuaternary }}>
            {t('secretary.detailEmpty')}
          </div>
        )}
      </div>
    </div>
  )
}

export default SecretaryChat
