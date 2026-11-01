import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { App, Button, Tooltip, theme } from 'antd'
import {
  ArrowLeftOutlined,
  ExportOutlined,
  PaperClipOutlined,
  SendOutlined,
  StopOutlined,
} from '@ant-design/icons'
import { useTranslation } from 'react-i18next'
import type { GeneratedFileInfo, ThinkingLevel } from '../../types'
import AnswerSegment from '../workbench/AnswerSegment'
import { useSecretaryStore, type SecretaryTask } from './secretary.store'
import { abortSecretaryTask, continueSecretaryTask, subscribeSecretaryStream } from './secretary-runner'
import SecretaryComposer, { type ComposerFile, type ComposerHandle } from './SecretaryComposer'

interface SecretaryTaskDetailProps {
  task: SecretaryTask
  providerId: string
  modelId: string
  thinking: ThinkingLevel
  onBack: () => void
  onOpenInMain: () => void
}

interface DetailMessage {
  id: string
  role: 'user' | 'assistant'
  content: string
  /** 工具产出的文件：小窗只露文件名，点击用系统软件打开 */
  files: GeneratedFileInfo[]
}

function baseName(p: string): string {
  return p.split(/[\\/]/).pop() || p
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
 * 面板内的简化对话窗：
 * 展示任务会话里的问答，并允许在同一会话上继续追问（流式输出），
 * 需要完整过程/工具卡片时再跳主窗口。
 */
const SecretaryTaskDetail: React.FC<SecretaryTaskDetailProps> = ({
  task,
  providerId,
  modelId,
  thinking,
  onBack,
  onOpenInMain,
}) => {
  const { t } = useTranslation()
  const { token } = theme.useToken()
  const { message } = App.useApp()

  const [messages, setMessages] = useState<DetailMessage[]>([])
  const [loading, setLoading] = useState(true)
  const [sending, setSending] = useState(false)
  const [live, setLive] = useState<{ id: string; content: string } | null>(null)
  const liveRef = useRef<{ id: string; content: string } | null>(null)
  /** 主窗口在同一任务上发起的运行中会话（实时接入展示） */
  const [remote, setRemote] = useState<{ sessionId: string; content: string } | null>(null)
  const remoteRef = useRef<{ sessionId: string; content: string } | null>(null)
  const bodyRef = useRef<HTMLDivElement>(null)
  const composerRef = useRef<ComposerHandle>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  const markViewed = useSecretaryStore((s) => s.markViewed)

  const conversationId = task.conversationId
  const busy = sending || !!remote || task.status === 'running' || task.status === 'waiting'

  const load = useCallback(async (): Promise<DetailMessage[]> => {
    if (!conversationId) {
      setMessages([])
      setLoading(false)
      return []
    }
    let list: DetailMessage[] = []
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
    return list
  }, [conversationId])

  const applyLive = useCallback((next: { id: string; content: string } | null) => {
    liveRef.current = next
    setLive(next)
  }, [])

  const applyRemote = useCallback((next: { sessionId: string; content: string } | null) => {
    remoteRef.current = next
    setRemote(next)
  }, [])

  // 切换任务时重新拉取会话（同一面板内可来回查看多条已结束任务）
  useEffect(() => {
    setLoading(true)
    applyLive(null)
    applyRemote(null)
    void load()
  }, [load, applyLive, applyRemote])

  /**
   * 外部变更/收尾落库后从 DB 重新同步。
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

  // 继续追问的流式增量：只接受当前任务的 session
  useEffect(() => subscribeSecretaryStream((snapshot) => {
    if (snapshot.taskId !== task.id) return
    applyLive({ id: snapshot.assistantMessageId, content: snapshot.content })
    if (snapshot.streaming) return
    setSending(false)
    // 主窗口接入时由它收尾落库，可能晚于 done：库里还没同步到就继续显示流式内容
    void reloadAndSettleRemote()
    markViewed(task.id)
  }), [task.id, applyLive, reloadAndSettleRemote, markViewed])

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

  // 任务在任一窗口产生写入（用户消息/收尾落库）后同步消息；主窗口发送时面板同步可见
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

  // 新的问答/流式增量后滚到底部
  useEffect(() => {
    const el = bodyRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [messages, live?.content, remote?.content])

  const handleSend = useCallback(async (text: string, files: ComposerFile[]) => {
    if (busy || !conversationId) return
    const prompt = text.trim()
    if (!prompt && files.length === 0) {
      composerRef.current?.focus()
      return
    }
    setSending(true)
    try {
      await continueSecretaryTask({
        taskId: task.id,
        prompt: prompt || files[0]?.name || '',
        attachmentPaths: files.map((f) => f.path),
        providerId,
        modelId,
        enableThinking: thinking,
      })
      composerRef.current?.clear()
      // 用户消息已落库，先展示出来；回答通过流式订阅补上
      await load()
    } catch (err: any) {
      setSending(false)
      if (err?.message === 'NO_PROVIDER') message.warning(t('secretary.noProvider'))
      else message.error(t('secretary.replyFailed'))
    }
  }, [busy, conversationId, task.id, providerId, modelId, thinking, load, message, t])

  const insertPaths = useCallback((paths: string[]) => {
    const files: ComposerFile[] = paths
      .filter((p) => typeof p === 'string' && p.length > 0)
      .map((p) => ({ path: p, name: baseName(p) }))
    if (files.length > 0) composerRef.current?.insertFiles(files)
  }, [])

  const addFiles = (fileList: FileList | null) => {
    if (!fileList) return
    const paths: string[] = []
    for (let i = 0; i < fileList.length; i++) {
      try {
        const p = window.electronAPI.getPathForFile(fileList[i])
        if (p) paths.push(p)
      } catch { /* ignore */ }
    }
    insertPaths(paths)
  }

  /** 文件产物：交给系统默认软件打开 */
  const openFile = useCallback(async (filePath: string) => {
    const res = await window.electronAPI.kms.openFile(filePath)
    if (res?.error) message.error(`${t('workbench.openWithSystemFailed')}: ${res.error}`)
  }, [message, t])

  const rows = useMemo(() => messages.filter((m) => m.content.trim().length > 0), [messages])

  return (
    <div className="secretary-detail">
      <div className="secretary-detail-head">
        <Tooltip title={t('secretary.back')}>
          <Button
            type="text"
            size="small"
            icon={<ArrowLeftOutlined />}
            style={{ color: token.colorTextTertiary }}
            onClick={onBack}
          />
        </Tooltip>
        <span className="secretary-detail-title" style={{ color: token.colorText }} title={task.title}>
          {task.title}
        </span>
        {(task.status === 'running' || task.status === 'waiting') && (
          <Tooltip title={t('secretary.stop')}>
            <Button
              type="text"
              size="small"
              icon={<StopOutlined />}
              style={{ color: token.colorTextTertiary }}
              onClick={() => void abortSecretaryTask(task.id)}
            />
          </Tooltip>
        )}
        <Tooltip title={t('secretary.openInMain')}>
          <Button
            type="text"
            size="small"
            icon={<ExportOutlined />}
            disabled={!conversationId}
            style={{ color: token.colorTextTertiary, flexShrink: 0, paddingInline: 4, fontSize: 11 }}
            onClick={onOpenInMain}
          >
            {t('secretary.openInMain')}
          </Button>
        </Tooltip>
      </div>

      <div className="secretary-detail-body" ref={bodyRef}>
        {rows.map((m) => m.role === 'user' ? (
          <div
            key={m.id}
            className="secretary-detail-user"
            style={{ background: token.colorFillTertiary, color: token.colorText }}
          >
            {m.content}
          </div>
        ) : (
          <div key={m.id} className="secretary-detail-assistant">
            <AnswerSegment seg={{ id: m.id, type: 'answer', content: m.content }} isError={false} />
            {m.files.length > 0 && (
              <div className="secretary-detail-files">
                {m.files.map((file) => (
                  <button
                    key={file.path}
                    type="button"
                    className="secretary-detail-file"
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
          <div className="secretary-detail-assistant">
            <AnswerSegment
              seg={{ id: live.id, type: 'answer', content: live.content, isStreaming: true }}
              isError={false}
            />
          </div>
        )}
        {remote && (
          <div className="secretary-detail-assistant">
            <AnswerSegment
              seg={{ id: `remote_${remote.sessionId}`, type: 'answer', content: remote.content, isStreaming: true }}
              isError={false}
            />
          </div>
        )}
        {!loading && rows.length === 0 && !live && !remote && (
          <div className="secretary-detail-empty" style={{ color: token.colorTextQuaternary }}>
            {t('secretary.detailEmpty')}
          </div>
        )}
      </div>

      <div className="secretary-detail-composer">
        <SecretaryComposer
          ref={composerRef}
          placeholder={t('secretary.replyPlaceholder')}
          onSend={handleSend}
        />
        <div className="secretary-detail-actions">
          <Tooltip title={t('secretary.attach')}>
            <Button
              type="text"
              size="small"
              icon={<PaperClipOutlined />}
              style={{ color: token.colorTextTertiary }}
              onClick={() => fileRef.current?.click()}
            />
          </Tooltip>
          <span
            className="secretary-detail-hint"
            style={{ color: token.colorTextQuaternary }}
          >
            {remote ? t('secretary.remoteRunning') : t('secretary.inputHint')}
          </span>
          <Button
            type="primary"
            size="small"
            loading={sending}
            disabled={busy}
            icon={<SendOutlined />}
            style={{ borderRadius: 999 }}
            onClick={() => composerRef.current?.submit()}
          >
            {t('secretary.send')}
          </Button>
        </div>
        <input
          ref={fileRef}
          type="file"
          multiple
          hidden
          onChange={(e) => {
            addFiles(e.target.files)
            e.target.value = ''
          }}
        />
      </div>
    </div>
  )
}

export default SecretaryTaskDetail
