import type { WebContents } from 'electron'
import type { SessionContext } from '../../unified-interaction.service'
import type { LLMLogContext } from '../../llm-logger.service'

/**
 * LLM 调用失败后保留的"可原地续跑"状态：agent 循环的上下文仍在内存中，
 * 续跑即重新发起失败的那一次 LLM 请求，随后流程与未出错时完全一致。
 * 仅存活于主进程内存（应用重启后失效），按会话唯一。
 */
export interface ResumableRun {
  conversationId: string
  createdAt: number
  /** 继续执行被中断的 agent 循环 */
  resume: (signal: AbortSignal) => Promise<void>
  /** IPC 层在 onError 时补全：事件回推所需的会话/窗口 */
  sessionId?: string
  sender?: WebContents
  /** 原会话的交互上下文（权限确认/ask_user 依赖它） */
  interactionStore?: SessionContext
  /** 原会话的 LLM 日志上下文，续跑时恢复以便日志继续归档到同一会话 */
  logContext?: LLMLogContext
}

/** 超过该时长未重试则丢弃，避免持有窗口/回调引用 */
const TTL_MS = 30 * 60 * 1000

const runs = new Map<string, ResumableRun>()

const prune = () => {
  const now = Date.now()
  for (const [key, run] of runs) {
    if (now - run.createdAt > TTL_MS) runs.delete(key)
  }
}

export function registerResumableRun(run: ResumableRun): void {
  prune()
  runs.set(run.conversationId, run)
}

export function getResumableRun(conversationId: string): ResumableRun | undefined {
  prune()
  return runs.get(conversationId)
}

/** 取出并移除：续跑只能发生一次 */
export function takeResumableRun(conversationId: string): ResumableRun | undefined {
  prune()
  const run = runs.get(conversationId)
  if (run) runs.delete(conversationId)
  return run
}

export function clearResumableRun(conversationId?: string): void {
  if (!conversationId) return
  runs.delete(conversationId)
}
