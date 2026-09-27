/**
 * 上下文压缩指令。
 * 设计对齐主流 coding agent：作为「最后一条 user 消息」追加在待压缩对话之后，
 * 使摘要调用成为主会话请求的真实前缀，最大化复用 provider 的 prompt cache。
 */
export const COMPACTION_INSTRUCTION = `You are the context compaction engine for this AI assistant.
Condense the conversation ABOVE into a structured Markdown checkpoint that lets the next turn continue the work without losing essential context.

Output EXACTLY the following sections, in order, with no extra headings or commentary:

## Primary Objective
The user's core request and intent, including every concrete requirement and acceptance criterion.

## Key Facts and Constraints
Stable environment facts, user preferences, hard constraints, and identifiers that remain in force.

## Completed Work and Verification
Concrete actions already taken and their results. State how each result was verified; never claim success without the evidence recorded above.

## Decisions
Important decisions, choices, and the reasons behind them.

## Errors and Fixes
Errors encountered and the exact fixes that resolved them, so they are not repeated.

## In Progress
Unfinished items with their current status and blockers.

## Next Step
The single most appropriate next action, with enough detail to execute immediately.

Rules:
- Write in the same primary language as the conversation being compacted.
- Preserve verbatim, exactly as they appeared: absolute file paths, shell commands, error strings, tool names, identifiers, numeric values, and code fragments.
- Keep exact file paths and generated deliverables; do not paraphrase them.
- Prefer concise engineering prose over full sentences, but never drop a qualifying condition or the scope a rule applies to.
- Discard intermediate tool-call chatter, greetings, and redundant restatements; keep conclusions and facts.
- Do not mention this compaction request, the checkpoint, or that the context was summarized.
- If a section has no content, write "(none)".`
