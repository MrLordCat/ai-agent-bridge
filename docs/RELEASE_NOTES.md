# AI Agent Bridge 1.12.0 — release notes

This release turns the accumulated 1.11.x development patches into a stable
baseline. The headline: **Claude turns no longer burn the 5-hour rate limit**
and **compaction is now fully provider-owned**.

## The most important fixes

### 1. Claude context safety — the 5-hour limit stops being destroyed
Three defects could each force a full cold replay of a long Claude chat
(hundreds of thousands of fresh input tokens — measured 563K in a single
request, ~503K new cache writes, instantly hitting the Anthropic 5-hour
rate limit):

- A mid-turn notification or retry resends the same turn with a truncated or
  rewritten transcript. The old durable-restore check required conversation
  "progress" and rejected such requests, so the whole chat was re-sent cold.
  **Restore now matches on the exact conversation id alone** — the model
  resumes warm from the SDK fork.
- A stopped Claude turn could deliver the next task as an orphan tool-result
  JSON blob, so the model answered yesterday's task. **The latest user
  message now always carries the user's real text.**
- The persisted resume checkpoint stayed at the last clean turn, so a
  stop/restart in the middle of a long tool chain restored a stale session.
  **Checkpoints now advance through the chain.**

### 2. Provider-owned Compact Conversation
The native context-usage Compact button routes to the extension for
contributed models. Recovery compacts below the automatic threshold, keeps a
configurable 25–90% retained target, cleans poisoned/looped context,
persists the new snapshot immediately, and works right after
`Developer: Reload Window`. Optionally, `deepseek-v4-flash` rewrites the
dropped history into a structured engineering handoff (objective, decisions,
verification, failed approaches) — off by default because it is a paid call.

### 3. Centralized API Provider Manager
Any number of OpenAI-compatible API profiles (name, base URL, request
format, model family, context length, optional key). Every profile
contributes its `/models` catalog to the shared VS Code model picker;
credentials live only in SecretStorage and never return to the webview.

### 4. Long agent runs are uninterrupted
The cross-request tool-density guard that injected "pause and summarize"
into productive tool workflows was removed. Real repeated-call loops are
still caught by the reliability guard, and a new streaming reasoning-loop
guard stops multi-kilobyte thinking repetition before it burns the output
budget.

### 5. UI: memory manager and Live Report
- Shared Memory shows its context-token footprint in Quick Access; the
  memory manager panel (global/workspace scopes) is back and refreshes live.
- The Performance sparkline is dynamic — bars stretch to fill the track.
- The Live Report webview now renders only the active tab, skips unchanged
  keep-alive payloads, and coalesces update bursts to at most one render per
  second (previously every turn event rebuilt all four tabs from scratch).

## Quality
- 380 passing tests, ESLint clean, pinned to VS Code 1.131.
- The VSIX for this tag is attached to this release; install with
  `code --install-extension llama-vscode-chat-1.12.0.vsix`.
