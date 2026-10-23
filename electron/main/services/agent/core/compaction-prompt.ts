/**
 * 上下文压缩指令。
 * 设计对齐主流 coding agent：作为「最后一条 user 消息」追加在待压缩对话之后，
 * 使摘要调用成为主会话请求的真实前缀，最大化复用 provider 的 prompt cache。
 */
export const COMPACTION_INSTRUCTION = `You compress an AI assistant conversation into a Markdown checkpoint that lets the next turn continue without re-reading the history.

Use exactly these sections, in this order, with no extra headings or commentary:

## Primary Objective
The user's core request and every concrete requirement, constraint, and acceptance criterion.

## Key Facts and Constraints
Environment facts, user preferences, hard rules, identifiers, and values that remain in force.

## Completed Work and Verification
Actions already taken and their observed results. Give the evidence for each success claim; if verification is missing, say so explicitly.

## Decisions
Important choices and the reason for each.

## Errors and Fixes
Errors encountered and the exact fix that resolved each, so they are not repeated.

## In Progress
Unfinished work with its current status and blockers.

## Next Step
The single best next action, specific enough to execute immediately.

Rules:
- Write in the same primary language as the conversation being compacted.
- Copy paths, commands, error strings, tool names, identifiers, numbers, and code fragments verbatim.
- Keep file paths and deliverable names exact; never paraphrase them.
- Be concise, but never drop a condition or scope qualifier that changes when a rule applies.
- Drop greetings, restatements, and intermediate tool chatter; keep conclusions and evidence.
- Do not mention the compaction, the checkpoint, or the summarization process.
- Write "(none)" for an empty section.`
