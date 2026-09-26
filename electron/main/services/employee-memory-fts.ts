import kmsTokenizer from './kms/kms-tokenizer.service'
import { buildMemoryMatchQuery } from './employee-memory-helpers'

/**
 * 记忆 FTS 索引/查询的分词桥接层。
 *
 * 记忆正文以中文为主，而 FTS5 的 `unicode61` 会把一整段连续中文视作单个 token，
 * 导致"用户偏好简洁回复"无法被"用户偏好"命中。因此：
 * - 索引侧（{@link segmentMemoryText}）用 jieba 预分词，使按空格建立词边界；
 * - 查询侧（{@link buildMemoryFtsMatch}）用同一分词器切词并 OR 连接。
 * 两侧必须使用同一分词器，否则会出现"能选不能中"的静默失效。
 */

/** 索引侧：jieba 精确模式分词（英文/数字原样保留） */
export function segmentMemoryText(text: string): string {
  return kmsTokenizer.segment(text)
}

/** 查询侧：构造 FTS5 MATCH 表达式（搜索引擎模式分词 + OR 连接） */
export function buildMemoryFtsMatch(query: string): string | null {
  return buildMemoryMatchQuery(query, t => kmsTokenizer.segmentForSearch(t))
}
