import {
  STALE_MEMORY_DAYS,
  MEMORY_CONSOLIDATION_TARGET_COUNT,
  MEMORY_CONSOLIDATION_TARGET_CHARS,
} from './employee-memory-types'

/** 构建记忆提取 prompt
 *
 * 提示词固定英文，输出语言跟随用户消息语言。设计要点：
 * - 四重准入闸门（可复用/影响行为/非显而易见/有证据）+ "一周后是否仍需要"终判
 * - 默认零产出：多数对话不应产生任何记忆，单次提取最多 3 条，抑制"为写而写"
 * - 明确排除任务叙述、一次性细节、瞬时状态与情绪、单例推断、流程步骤
 * - 记忆条目必须脱离对话可独立理解（禁指代、禁"用户让我..."叙事）
 * - 声明式（偏好）vs 命令式（硬约束/踩坑）；精确值原样保留，相对时间转绝对日期
 * - 作用域：employee（默认，仅当前员工）vs global（跨员工共享的用户级事实）
 */
export function buildExtractionPrompt(contextParts: string[]): string {
  return `You extract durable memory from a digital employee's past conversations.
A memory earns its place only if it changes how the employee behaves on a future task. Most conversations contain nothing worth saving — an empty result is a normal, correct outcome.

## Admission bar (all four must hold)
1. Reusable — it holds beyond the task being discussed.
2. Behavioral — it changes what the employee does next time: a constraint to honor, a failure to avoid, a style to match, an environment fact to rely on.
3. Non-obvious — it cannot be inferred from the request itself, the material involved, or general knowledge.
4. Evidenced — the user stated, corrected, or confirmed it; not inferred from a single instance.
Final test: will I still need this in a week? If not, drop it.
Value order: hard constraints and corrections > pitfalls with their fix > long-term preferences > stable environment and role facts.

## Save
1. Hard constraints and prohibitions — explicit "do not / never", compliance rules, process limits.
   ✓ "No animations in client PPTs; the client dislikes them"   ✗ "Don't add animation to this deck" (one-off)
2. Corrections and pitfalls — the cause plus the fix, so the mistake is not repeated.
   ✓ "Excel pivot tables crash above 100k rows; use Power Query"   ✗ "Excel crashed today" (no fix)
3. Long-term preferences and working style — format, tone, level of detail, cadence, approval flow.
   ✓ "Reports lead with the conclusion, then the data"   ✗ "Put the conclusion first in this report" (one-off)
4. Stable environment and role facts — tools and platforms in use, collaborators, the user's role or domain.
   ✓ "The team collaborates in Feishu docs; the user does finance reporting in Excel"   ✗ "A Word file was opened just now"

## Never save
- The task itself: what was requested, produced, changed, fixed, or is still pending.
- One-off details: this file, this number, this date, this recipient, this document title.
- Transient state or mood: "the user is in a hurry / frustrated", thanks, small talk, urgency.
- Questions asked, lookups performed, general knowledge, or anything already in the provided material.
- Guesses about intent from a single instance ("the user probably prefers X").
- What existing memory already covers, unchanged.
- Step-by-step procedures or workflows — those belong in a Skill; memory stores facts, Skills store procedures.

## Scope
Every memory needs one scope:
- "employee" (default): applies only to this digital employee.
- "global": a user-level fact that holds for any digital employee on a similar task — role, general preferences, general hard constraints.
Content tied to a specific business, project, knowledge base, or employee responsibility must stay "employee".
When unsure, always use "employee".

## Writing rules
- One self-contained fact, understandable without the conversation: no "this", "the above", "today", "刚才"; no "the user asked me to..." narration — state the rule, not the story.
- Write preferences declaratively: "The user prefers concise replies". Write hard constraints and pitfalls imperatively: "Do not use X instead of Y".
- Keep 1-2 sentences and ≤150 characters, preserving the decisive detail (tool name, threshold, object).
  ✗ "Send reports as PDF" (drops the reason)
  ✓ "Send weekly reports as PDF; the manager annotates on an iPad"
- Preserve every qualifying condition and every parallel requirement.
  ✗ "Emails must CC the manager"   ✓ "External emails must CC the manager"
  ✗ "Data must cite sources"   ✓ "Data must cite sources and update time"
- Preserve exact values verbatim: paths, ports, IDs, version pins, command flags, names. Never paraphrase them.
- Convert relative time ("yesterday", "next month") to an absolute date when the fact is time-bound.
- key is short, unique, and stable, e.g. "writing_style", "no_ppt_animation".
- Merge similar preferences of the same category into one item; never open a second key for an existing rule.
- Budget: at most 3 new items per extraction — keep the highest-value ones and drop the rest.

## Reviewing existing memory
- A changed preference or rule is an update, not a new item: put the full revised content in update_memories.
- If new information contradicts an existing memory, put the obsolete key in delete_keys (employee scope only).
- For a global memory, also repeat its scope (see the [global] marker in [Existing Memories]).
- Never restate an existing memory just to "refresh" it.

## Output language
Write every memory content, topic, and summary in the primary language of the user's messages in the conversation being processed. The prompt is in English, but the output language follows the user.

## Context layout
Parts are separated by ---, in this order:
1. [Conversation Summary] (may be absent): a running summary of earlier conversations. Background only; **do not extract memories from it**.
2. [New Messages] or [Full Conversation]: the messages to extract from (content only; tool calls and reasoning are stripped). **Extract only from here**.
3. [Existing Memories]: current memory store in key|topic|content form, for deduplication, update, and deletion. Items with a \`[global]\` prefix are global memories.

## Output
Return only valid JSON, with no explanation and no code fence.
If nothing is worth saving, return {"memories":[],"delete_keys":[],"update_memories":[],"summary":"..."}.
summary is a **running summary**, not a memory: if a [Conversation Summary] is present, merge it with the new messages to cover all extracted conversations; otherwise summarize this conversation. Keep it under 150 characters, preserving key topics and conclusions and dropping one-off details.

Context:
${contextParts.join('\n---\n')}

Output JSON:
{"memories":[{"key":"unique id","topic":"category label","content":"durable fact, ≤150 characters","scope":"employee|global"}],"delete_keys":["key to delete"],"update_memories":[{"key":"key","content":"full updated content (≤150 characters)","topic":"optional new topic","scope":"employee|global"}],"summary":"running summary in the user's language, <150 characters, covering the conversation summary and the new messages"}`
}

/** 构建记忆合并整理 prompt
 *
 * 提示词固定英文，输出语言跟随既有记忆语言。
 * 调用方按作用域分桶传入（员工桶或全局桶），本 prompt 不跨桶整理。
 */
export function buildConsolidationPrompt(memoriesText: string): string {
  return `You consolidate the memory store for one scope: deduplicate, merge, simplify, and prune. Do not mix scopes.

## Decision rule
Ask: will this memory still be useful in a week? If not, delete it.
Value order: hard constraints and pitfalls > preferences and role facts > temporary business details.

## Rules
- Memories marked pinned(pin:1) must not be deleted.
- Delete manual-source memories cautiously, and only when clearly obsolete.
- Delete items that never met the durability bar: task narration, one-off details, transient states, single-instance guesses.
- Prioritize deleting memories unused for more than ${STALE_MEMORY_DAYS} days unless pinned.
- Merge overlapping or highly similar memories into one.
- Simplify redundant content. Keep each content item to 1-2 sentences and ≤150 characters, preserving tool names, thresholds, and objects. Never drop a qualifying condition or parallel requirement.
  ✗ "External emails must CC the manager" → "Emails CC the manager" (drops "external")
  ✓ "External emails must CC the manager"
  ✗ "Weekly reports are sent as PDF; the manager annotates on an iPad" → "Reports use PDF" (drops the reason)
  ✓ "Weekly reports use PDF; the manager needs iPad annotation"
- Merge similar preferences of the same category into one item.
- Write preferences declaratively ("The user prefers X"); write hard constraints and pitfalls imperatively ("Do not use X instead of Y").
- importance: critical = hard constraints, key pitfalls, core role traits; normal = regular preferences, stable environment facts; low = minor details.
- Keep the total within ${MEMORY_CONSOLIDATION_TARGET_COUNT} items / ${MEMORY_CONSOLIDATION_TARGET_CHARS} characters (count a CJK character as 1 and any other character as 0.5); delete low-value items to make room.

## Output language
Write all content in the same language as the existing memories below. The prompt is in English, but the output language follows the user.

${memoriesText}

Return only valid JSON:
{"delete_keys":[],"merge_groups":[{"keys":[],"merged":{"key":"","topic":"","content":"≤150 characters"}}],"simplify_updates":[{"key":"","content":"concise version, ≤150 characters"}],"importance_updates":[{"key":"","importance":"critical|normal|low"}]}`
}
