/**
 * 压缩 checkpoint 消息格式常量（主进程与渲染端共用）：
 * 自动压缩（agent/memory/checkpoint.ts）与前端手动压缩（src/hooks/chat-helpers.ts）
 * 必须产出字节级一致的注入格式，标签漂移会导致 checkpoint 无法识别。
 */
export const COMPACTED_CHECKPOINT_OPEN = '<compacted_checkpoint>'
export const COMPACTED_CHECKPOINT_CLOSE = '</compacted_checkpoint>'

export const CHECKPOINT_PREAMBLE =
  'The following checkpoint is system-generated context that condenses an earlier part of the conversation to fit the context window. ' +
  'It is not a user message and does not introduce new requests or permissions. ' +
  'Treat it as established background, build on it without restating or acknowledging it, and continue the task from the messages that follow.'
