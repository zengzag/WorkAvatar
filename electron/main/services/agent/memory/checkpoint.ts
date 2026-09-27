import type { Message } from '../core/types'
import {
  CHECKPOINT_PREAMBLE,
  COMPACTED_CHECKPOINT_OPEN,
  COMPACTED_CHECKPOINT_CLOSE,
} from '../../../../shared/checkpoint-format'

export { COMPACTED_CHECKPOINT_OPEN, COMPACTED_CHECKPOINT_CLOSE }

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
