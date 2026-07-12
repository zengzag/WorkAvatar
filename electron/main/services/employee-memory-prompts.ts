import { STALE_MEMORY_DAYS } from './employee-memory-types'

/** 构建记忆提取 prompt */
export function buildExtractionPrompt(contextParts: string[]): string {
  return `你是全局记忆提取器。从对话中提取关于"用户自身"的持久信息，而非临时业务细节。如果对话中没有任何值得持久记录的内容，返回空结果。

## 需要提取的内容（用户长期特征）
① 用户个人信息：职业、行业、岗位、常用办公工具/平台、工作场景等固定信息。
② 用户长期偏好：写作风格、文档格式要求、汇报偏好、沟通风格、工作节奏、审批习惯等办公场景下长期稳定的偏好。
③ 硬性禁忌/约束：用户明确表示"不要"/"禁止"的做法、工作流程限制、合规要求等不可违背的规则。
④ 用户自定义回答规则：用户要求助手始终遵守的回复格式、语气、风格等行为规范。
⑤ 确定落地的长期计划/关键方案：用户已确认并执行的长期工作计划、关键业务方案或工作决策。
⑥ 踩坑经验：办公工具/流程执行失败的原因及最终解决方案，下次可用以避免重复踩坑。

## 不提取的内容（临时对话噪声）
✗ 临时闲聊：问候、道谢、闲谈等无长期价值的内容。
✗ 一次性临时提问：仅当前上下文有效的临时问题（如"这个数据怎么填"、"帮我查一下这个信息"）。
✗ 随口临时想法：用户随口说的、未确认的想法或计划。
✗ 临时业务细节：只在当前对话中有意义的业务数据、临时配置、一次性操作等。
✗ 可推导的通用知识：LLM 本身已具备的通用办公知识。
✗ 已在现有记忆中存在且未变化的信息。

## 审查现有记忆
- 如果新信息与已有记忆矛盾，将过时的 key 加入 delete_keys。
- 如果新信息是对已有记忆的补充/更新，将更新后的内容加入 update_memories。
- 偏好/规则/禁忌变更属于"补充更新"，不要新增为多条独立记忆。

## 重要原则
- 宁缺毋滥：不确定是否值得长期保存的内容，不要提取。
- 允许空结果：如果对话没有任何值得持久记录的内容，返回空的 memories 数组。
- 严格精炼：记忆总量上限约 30 条 / 3000 字符，每条 content 必须 1 句话、≤30 字。禁止长句、禁止重复表述。
  - 反例："用户习惯使用 Markdown 格式编写技术文档，并倾向于在文档头部添加目录（Table of Contents），以方便阅读"（50+字）
  - 正例："技术文档用 Markdown，头部加目录"（15字）
- key 需短小唯一，如 "writing_style"、"report_format"、"no_ppt_animation"、"excel_pitfall"。
- 多个相似偏好合并为一条，不要拆成多条。
- summary 用简短中文概括本轮对话要点（不超过100字）。

上下文（摘要|对话|现有记忆 key|topic|content）：
${contextParts.join('\n---\n')}

输出 JSON：
{"memories":[{"key":"唯一标识","topic":"分类标签","content":"≤30字精炼事实"}],"delete_keys":["待删key"],"update_memories":[{"key":"key","content":"更新后内容（≤30字）","topic":"可选新topic"}],"summary":"对话摘要（中文，<100字）"}`
}

/** 构建记忆合并整理 prompt */
export function buildConsolidationPrompt(memoriesText: string): string {
  return `你是全局记忆合并整理器。对用户记忆进行去重、合并和清理，保持记忆库精简有用。

## 规则
- pinned(pin:1) 标记的记忆不允许删除。
- manual source 的记忆谨慎删除，除非明确过时。
- >${STALE_MEMORY_DAYS}天未引用且非 pinned 的记忆优先删除。
- 合并内容重叠/高度相似的记忆为一条。
- 简化冗余啰嗦的内容，每条 content 必须 1 句话、≤30 字。多个相似偏好合并为一条。
- 重要性评估：critical=核心用户特征/硬性约束/关键踩坑；normal=常规偏好/计划；low=次要信息。
- 优先保留关于用户自身特征、偏好、踩坑经验的记忆，清理纯临时业务细节的记忆。
- 总量目标 ≤30 条 / 3000 字符，请主动删除低价值条目腾出空间。

${memoriesText}

JSON: {"delete_keys":[],"merge_groups":[{"keys":[],"merged":{"key":"","topic":"","content":"≤30字"}}],"simplify_updates":[{"key":"","content":"≤30字精炼版本"}],"importance_updates":[{"key":"","importance":"critical|normal|low"}]}`
}

/** 构建对话摘要 prompt */
export function buildSummaryPrompt(conversationText: string): string {
  return `请对以下对话历史生成结构化摘要，保留语义完整性。按以下格式输出：

主题：（用一句话概括对话主题）
要点：
- （列出3-5个关键讨论点）
结论：（如有明确结论则写出，否则写"无明确结论"）

对话内容：
${conversationText}`
}
