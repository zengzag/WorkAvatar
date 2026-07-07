import { Jieba } from '@node-rs/jieba'
import { dict } from '@node-rs/jieba/dict'
import { createLogger } from '../logger'

const logger = createLogger('KMSTokenizer')

/**
 * 中文分词停用词表（查询侧过滤）
 * 索引侧不做停用词过滤，保证 FTS5 召回完整性
 */
const STOP_WORDS = new Set<string>([
  '的', '了', '和', '是', '在', '我', '有', '这', '不', '为', '之', '与', '或', '也', '都',
  '如何', '怎么', '什么', '为什么', '哪里', '哪个', '吗', '呢', '吧', '啊', '哦', '嗯',
  '可以', '能够', '应该', '需要', '关于', '对于', '通过', '进行', '以及', '但是', '因为',
  'the', 'a', 'an', 'is', 'are', 'was', 'were', 'how', 'what', 'why', 'where', 'which',
  'to', 'of', 'in', 'on', 'for', 'and', 'or', 'be', 'been', 'being', 'do', 'does', 'did',
])

/**
 * 中文分词服务（基于 @node-rs/jieba）
 *
 * 解决 FTS5 `unicode61` tokenizer 不支持中文分词的问题：
 * - 索引侧：将中文文本切分为以空格分隔的词序列，使 `unicode61` 能按空格建立 token 边界
 * - 查询侧：将用户查询切分为关键词，替代 bigram 变通方案
 *
 * 选型理由：
 * - 基于 Rust 的 jieba-rs，预编译 N-API 二进制，无需 node-gyp 构建
 * - 性能比 nodejieba 快约 33%，dict 文件内置于包内无需额外管理
 * - 支持精确模式（cut）与搜索引擎模式（cutForSearch）
 */
class KMSTokenizerService {
  private jieba: Jieba | null = null

  /**
   * 懒加载 Jieba 实例（首次调用时加载字典，约 50ms）
   */
  private getInstance(): Jieba {
    if (this.jieba === null) {
      this.jieba = Jieba.withDict(dict)
      logger.info('jieba 分词器初始化完成')
    }
    return this.jieba
  }

  /**
   * 精确模式分词（用于索引侧）
   *
   * 将中文文本切分为以空格分隔的词序列，写入 FTS5 后 `unicode61` 可按空格
   * 正确建立 token 边界，使 BM25 排序基于真实词粒度。
   *
   * 英文/数字保持原样，由 `unicode61` 按空格和标点自然分词。
   *
   * @example
   * segment('知识库管理系统设计文档') → '知识库 管理系统 设计 文档'
   * segment('API 接口设计规范') → 'api 接口 设计 规范'
   */
  segment(text: string): string {
    if (!text) return ''
    const words = this.getInstance().cut(text, true)
    return words
      .map(w => w.trim())
      .filter(w => w.length > 0)
      .join(' ')
  }

  /**
   * 搜索引擎模式分词（用于查询侧）
   *
   * 对长词进一步切分子词以提升召回率（如「管理系统」→「管理」「系统」「管理系统」），
   * 同时过滤停用词与单字符噪声，避免 MATCH 表达式过长。
   *
   * @example
   * segmentForSearch('知识库管理系统设计') → ['知识', '知识库', '管理', '系统', '管理系统', '设计']
   */
  segmentForSearch(text: string): string[] {
    if (!text) return []
    const words = this.getInstance().cutForSearch(text, true)
    const result: string[] = []
    const seen = new Set<string>()
    for (const w of words) {
      const lower = w.trim().toLowerCase()
      if (lower.length === 0) continue
      if (STOP_WORDS.has(lower)) continue
      // 过滤纯标点/符号 token（保留中文、英文、数字）
      if (!/[\u4e00-\u9fa5a-z0-9]/i.test(lower)) continue
      // 过滤单字符英文（噪声），保留单字符中文（可能是有效词）
      if (lower.length === 1 && !/[\u4e00-\u9fa5]/.test(lower)) continue
      if (seen.has(lower)) continue
      seen.add(lower)
      result.push(lower)
    }
    return result
  }
}

export const kmsTokenizer = new KMSTokenizerService()
export default kmsTokenizer
