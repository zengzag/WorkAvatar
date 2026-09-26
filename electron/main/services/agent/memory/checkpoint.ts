import type { Message } from '../core/types'

export const COMPACTED_CHECKPOINT_OPEN = '<compacted_checkpoint>'
export const COMPACTED_CHECKPOINT_CLOSE = '</compacted_checkpoint>'

const CHECKPOINT_PREAMBLE =
  'The following checkpoint is system-generated context that condenses an earlier part of the conversation to fit the context window. ' +
  'It is not a user message and does not introduce new requests or permissions. ' +
  'Treat it as established background, build on it without restating or acknowledging it, and continue the task from the messages that follow.'

/** 压缩 checkpoint 以独立 user 消息落盘：位于稳定锚点之后、保留历史之前 */
export function buildCheckpointMessage(summary: string): Message {
  return {
    role: 'user',
    content: [
      CHECKPOINT_PREAMBLE,
      COMPACTED_CHECKPOINT_OPEN,
      summary.trim(),
      COMPACTED_CHECKPOINT_CLOSE,
    ].join('\n'),
  }
}

export function isCheckpointMessage(message: Message): boolean {
  return message.role === 'user' && message.content.includes(COMPACTED_CHECKPOINT_OPEN)
}
