# Changelog

## 1.11.15 (dev) - 2026-08-11

- **Live Report webview renders much less often**: live updates now render
  only the active tab (the other three tabs are built lazily on switch), skip
  renders when the payload is unchanged (keep-alive pings), and coalesce
  bursts of updates to at most one render per second with the freshest data.
  Previously every turn event rebuilt all four tabs and the whole DOM from
  scratch.

## 1.11.14 (dev) - 2026-08-11

- **Memory UI restored in the quick access view and command palette**: the
  Shared Memory entry again shows the approximate context tokens the memory
  consumes, `llamacpp.openMemory` reopens the memory manager panel with
  global/workspace scopes, and the panel refreshes on memory changes.
- **Performance tab sparkline is dynamic**: the recent-gaps bars now stretch
  to fill the track (up to 80 pauses, each bar 2–26px) instead of leaving
  the right half of the row empty at fixed 10px bars.

## 1.11.13 (dev) - 2026-08-10

- **Claude durable restore no longer requires conversation progress**: a
  mid-turn notification, retry, or rewritten transcript resends the same
  copilot turn with a truncated message list, which failed the old
  "advancement" signature check and fell through to a full cold replay
  (563K fresh input tokens, ~503K cache writes — an instant 5h rate-limit
  burn). The persisted session is now restored on the exact conversation id
  alone; the model resumes warm from the SDK fork instead of re-sending the
  whole transcript.

## 1.11.12 (dev) - 2026-08-10

- **Claude follow-up context fix**: a stopped Claude turn could make the next
  request append an orphan tool result (a JSON blob) as the "latest user
  message" when the durable session was restored after an interruption, so
  the model answered the previous task instead of the new one. The latest
  user message now skips trailing tool-result-only messages and always
  carries the user's real text.
- **Claude durable checkpoints advance through tool chains**: the persisted
  resume point now follows long multi-round agent turns instead of staying
  at the last clean turn, so a stop/restart mid-chain restores the recent
  session (with the user's latest task) rather than a days-old checkpoint.

## 1.11.11 (dev) - 2026-08-09

- **Claude long turns restored**: the `claudeMaxAgentTurns` manifest default now matches the provider default of `0`, so the Agent SDK no longer receives an accidental `maxTurns=24` cap. The independent 2M cumulative-input circuit breaker remains enabled; users can still opt into a positive segment cap.
- **Claude diagnostic timestamps**: Session Quality now carries the Agent SDK logical-turn start time into the stored turn record, so safety-stop rows show their real time instead of `never`.
- **Regression coverage**: manifest tests pin the disabled-by-default segment cap, and diagnostics tests verify Claude ISO timestamps reach Session Quality as milliseconds.

## 1.11.10 (dev) - 2026-08-09

- **Target-faithful compaction**: automatic compaction can split an oversized user turn at complete assistant/tool transaction boundaries. A 50% retained target no longer collapses to a ~16% tail merely because one tool-heavy turn is too large to keep whole; assistant tool calls remain paired with every retained tool result.
- **Streaming reasoning loop guard**: exact multi-kilobyte repetition in private reasoning is stopped before it consumes the remaining output budget. Detection is conservative, reasoning-only, enabled by default, and configurable through `reasoningLoopProtection` and `reasoningLoopMinChars`.
- **Clean recovery retry**: after a reasoning loop, the provider cancels both processing and optional raw-log stream branches, removes historical reasoning through provider-owned recovery compaction, and retries once from a structured summary. A second loop returns a bounded stop message instead of running indefinitely.
- **Diagnostics**: Session Quality marks reasoning loops and retry counts separately from repeated tool-call loops; compaction and recovery snapshots retain only bounded summary/tail samples.
- **Regression coverage**: tests cover target fill inside one large tool turn, orphan-free tool transactions, exact/varied reasoning streams, raw SSE guard propagation, and end-to-end clean-summary retry.

## 1.11.9 (dev) - 2026-08-09

- **Reload-safe manual recovery**: AI Agent Bridge restores the most recent persisted HTTP conversation identity when the Extension Host starts. The Compact Conversation button can therefore trigger provider-owned cleanup immediately after `Developer: Reload Window`, before another request has refreshed the Copilot bridge state.

## 1.11.8 (dev) - 2026-08-09

- **Provider-owned Compact Conversation**: Copilot patch v22 routes the native context-usage Compact button to AI Agent Bridge when the active conversation uses a contributed `llamacpp` model. Other providers retain Copilot's original `/compact` behavior.
- **Immediate recovery snapshot**: manual compaction runs below the automatic threshold, uses the configured 25–90% target, invokes the optional DeepSeek semantic summary, persists the new snapshot, and returns a local confirmation without spending a main-model request.
- **Poisoned-context cleanup**: unlike automatic compaction, recovery mode keeps only its newest control turn verbatim. All prior turns cross the summary boundary, historical `reasoning_content` is removed, and long exact repetition tails serialized as assistant text are replaced with a bounded notice.
- **Safe routing**: the Copilot patch forwards the stable private conversation id to a one-shot, 60-second provider command. Unknown/stale conversations fall back to native Copilot compaction; raw conversation ids are not logged.
- **Regression coverage**: tests cover bundle routing/fallback, one-shot conversation binding, full provider flow without a main endpoint call, strict raw-tail replacement, and removal of repetitive historical reasoning.

## 1.11.7 (dev) - 2026-08-09

- **Central API Provider Manager**: Quick Access now opens a dedicated CRUD webview for any number of OpenAI-compatible API profiles. Each profile has its own name, base URL, request format, model family, context length, enabled state, and optional API key.
- **Secure centralized storage**: profile metadata is global across workspaces, while credentials are stored only in VS Code SecretStorage. Saved keys are never sent back to the webview; deleting a profile also deletes its secret.
- **Multi-account routing**: every enabled profile contributes its `/models` catalog to the shared VS Code picker. Source IDs and model/runtime caches are isolated per profile, including multiple accounts on the same gateway URL.
- **API compatibility profiles**: standard OpenAI requests omit llama.cpp-only thinking/cache fields, DeepSeek native and llama.cpp payloads remain available explicitly, and versioned base URLs such as `.../api/v1` no longer receive a duplicate `/v1` segment.
- **Compatibility**: the existing Local LLM and dedicated DeepSeek configuration remain unchanged and can be used alongside custom API profiles.

## 1.11.6 (dev) - 2026-08-09

- **AI Agent Bridge branding**: the extension display name, Activity Bar container, Settings title, Command Palette category, status bars, dialogs, output channels, and Codex client title now reflect the multi-provider product instead of the original local-only name. Compatibility identifiers (`llamacpp.*`, `mrlordcat.llama-vscode-chat`, patch markers, and VSIX basename) remain unchanged.
- **README audit**: the main documentation now identifies stable 1.11.0 and dev 1.11.6, current patch v21, 359 tests, all-provider diagnostics, semantic DeepSeek compaction, 25–90% retained targets, paid-summary boundaries, and bounded compaction diagnostic samples.
- **Repository metadata**: manifest repository, homepage, and issue URLs point to `MrLordCat/ai-agent-bridge`; user-facing command references throughout the documentation use the new `AI Agent Bridge:` prefix.

## 1.11.5 (dev) - 2026-08-09

- **Deeper context reduction**: `compactionTargetRatio` now supports 25–90% retained instead of 50–90%. Quick Access adds 25% (extreme) and 35% (very aggressive) presets; the existing 75% default is unchanged.
- **Failure-aware primary digest**: rejected hypotheses, corrected analysis mistakes, and approaches that did not solve the problem receive an independent evidence lane under input pressure. Runtime logs now expose total/selected/omitted turns, selection-reason counts, and rejected-approach coverage.
- **Less redundant, better-scoped summaries**: the Flash contract separates durable outcomes from verification evidence, forbids promoting partial checks into whole-chain proof, and requires rejected approaches to remain visible. Summary diagnostics report section sizes, empty sections, and exact duplicate lines.
- **Target-aware summary size**: semantic-summary space scales down for aggressive/small targets instead of always reserving 16K characters, while retaining a 4K handoff floor and 16K ceiling.

## 1.11.4 (dev) - 2026-08-09

- **Uninterrupted agent flow**: removed the cross-request tool-density guard that treated four tool-only turns in an eight-turn window as a stalled agent and injected `Pause, summarize...`. Productive DeepSeek/local tool workflows can now continue until the task is complete, the model reports a real blocker, or VS Code reaches its configured request limit.
- **No count-based forced reviews**: removed the fallback that disabled every tool after a fixed number of host-driven tool turns and forced a text recap. `toolLoopForceTextThreshold` remains registered only as a deprecated compatibility setting.
- **Actual-loop protection retained**: identical consecutive tool name + arguments still trigger the dedicated reliability guard. The intra-request tool-only recovery now asks for the next useful tool call and explicitly reserves final text for completion or a genuine blocker.
- **Regression coverage**: the continuation contract is tested to contain no pause, summary, review, recap, or planning trigger while preserving repeated-call protection.

## 1.11.3 (dev) - 2026-08-09

- **Higher-quality Flash compaction input**: the deterministic pre-summary now groups complete turns and reserves independent evidence lanes for the original objective, high-signal milestones, evenly spaced timeline coverage, and the recent working tail. Long conversations no longer collapse to only the first user message plus the newest events before they reach `deepseek-v4-flash`.
- **Cleaner engineering evidence**: tool calls are paired with their results and arguments, repeated narration is deduplicated, successful test/build outcomes are retained, and additional volatile VS Code blocks are omitted. English and Russian decisions, failures, verification, constraints, and requirement changes receive explicit priority.
- **Stricter semantic merge**: the Flash prompt distinguishes requested/planned work from completed and verified work, preserves unresolved failures, and applies later evidence only when it explicitly supersedes earlier status. Previous structured summaries retain every section under tight input budgets, and malformed out-of-order output falls back safely.
- **Regression coverage**: tests exercise pressured middle-history retention, Russian milestones, tool-result pairing, duplicate removal, structured-summary clipping, prompt status discipline, and section-order validation.

## 1.11.2 (dev) - 2026-08-09

- **Configurable compaction target**: `llamacpp.compactionTargetRatio` now controls how much of the current message context is retained by both proactive compaction and confirmed-overflow retries. The existing behavior remains the default at 75%; the setting is safely clamped to 50–90%.
- **Quick Access presets**: `Model Behavior → Compaction Target` offers 50%, 60%, 75%, and 85% retained. Selecting 50% compresses the current history to half its estimated token size, providing substantially more headroom at the cost of a more aggressive summary.
- **Regression coverage**: tests verify the 50% target for proactive and overflow paths, safe ratio bounds, and the Quick Access entry.

## 1.11.1 (dev) - 2026-08-09

- **Opt-in semantic compaction**: `deepseek-v4-flash` can now merge the previous summary with newly dropped turns into a structured engineering handoff (objective, completed work, decisions, files/symbols, verification, failed approaches, constraints, and open work). It uses a separate tool-free, thinking-disabled request and is disabled by default because every compaction is a paid DeepSeek API call.
- **Quick Access control**: `DeepSeek → AI Compaction Summaries` switches the paid summarizer on or off and clearly shows `On (paid)` / `Off`. API errors, missing keys, invalid output, cancellation, and timeouts automatically fall back to the deterministic local summary.
- **Compaction correctness**: repeated compaction preserves the previous summary; Shared Memory overlays, ephemeral guards, reasoning, and volatile VS Code metadata are excluded from summary input; the semantic-summary budget is reserved before the request; post-memory-injection correction keeps the final request within its target.
- **Regression coverage**: 352 passing tests, including request shape, response validation, metadata redaction, previous-summary retention, strict final budgets, and the Quick Access toggle. ESLint is clean.

## 1.11.0 (stable) - 2026-08-08

Stability release: stable context and 98%+ cache hit rate, memory management through a UI, and a full code audit. 97 dev patches (1.10.1–1.10.97) after stable 1.10.0.

### Key improvements

- **Stable context and cache (98%+ hit rate)**: snapshot-stabilized tail (the tail comes from the snapshot, new messages from the source), fixed history duplication when VS Code rewrites the transcript (`rewritten_history` detector), and reasoning-block deduplication by common prefix. Turn N+1 prompt = turn N prompt + only the new messages.
- **Unified compaction scheme**: a single soft scheme (target 0.75 × current size), truncation of heavy tool results in the tail (`compactMaxToolResultChars`), and protection against compaction between restarts.
- **Loop protection**: a working repeated-tool-call detector, cross-turn "pause and summarize" nudge, and a hard `maxModelTurnsPerRequest` limit.
- **Reasoning no longer leaks into visible text**: multi-marker thinking parser, fallback hidden when there is no ThinkingPart.
- **Shared Memory UI**: a webview memory manager instead of raw JSON — create/edit/delete entries, project filters (All/Global/This project/Other projects), per-entry context estimation, and correct workspace binding.
- **DeepSeek sliders**: Max Output and Maximum Context in quick access via the Provider Context panel.
- **Live Report**: expandable exploded view of the prompt/cache structure with stable requestId-based identity.
- **Code audit**: 8 utilities deduplicated (asRecord, clampInteger, truncate, bytesToBase64, normalizeCopilotTurnIndex, contentToText, nonNegativeInteger, formatTokenCount), dead code removed.
- **Subagent tool parity (Copilot patch)**: VS Code narrowed subagent requests to a single tool (`session_store_sql`); the Copilot bundle patch now caches the full advertised tool set from ordinary turns and restores it for subagent turns — subagents get the same tools as the calling agent (1 → 64 tools).
- **Tests**: 346 passing, pinned to VS Code 1.131 (copilot-patch patterns are incompatible with 1.132+).

---

## 1.10.1 - 1.10.97 (dev patches) - 2026-08-07

Dev fixes after stable 1.10.0 (patch-only increments).

### 1.10.97
- Shared Memory UI improved for comfortable editing of entries from different windows: cards show the human-readable project (workspace:d:/GitHub/llama.cpp-with-GUI) and an `other project` label for entries of foreign workspaces; filter chips All / Global / This project / Other projects added; editing a foreign entry shows a warning and keeps its original scopeId (the project is not rebind to the current window) — rebinding only happens on an explicit Scope change.
- Memory data: an entry with a broken scopeId `file:///d:/...` (without percent-encoding) was normalized to `file:///d%3A/...` — it is now visible in its own window.
- Removed the dead file `src/ui/health-check-panel.ts` (was not used anywhere).
- Tests: 3 new (project labels, other-project badge and filter chips, form warning). Full suite — 346 passing.

### 1.10.96
- Full code audit: deduplication and dead code. `src/utils.ts` now holds single implementations: `asRecord`, `clampInteger` (canonical argument order value/min/max/fallback), `truncate`, `bytesToBase64` (Buffer), `normalizeCopilotTurnIndex`, `contentToText`, `nonNegativeInteger`, `formatTokenCount`. Local copies removed from 12 files: app-server-client, codex-provider (truncate calls with explicit limit), rollout-metrics, turn-bridge (truncate(item.command, 240)), message-adapter, message-compaction, memory/prompt, output-budget, token-usage-history, usage-experiment, claude-provider (4 clampInteger calls rewritten — the old (value, fallback, min, max) order was a mine), ui/context-control (unified K/M token format).
- Dead code removed: the ternary with identical branches `/user/balance` in llama-provider; the unused constant `DEFAULT_CLAUDE_KEEPALIVE_MS`; the unused asRecord import in claude-provider; the duplicate btoa-based bytesToBase64 in utils; `llamacpp.autoCompact` default synchronized `true → false` (matches the code fallback and the "Disabled by default" description).
- Regression: 343 passing, eslint clean across the whole src.

### 1.10.95
- Shared Memory got a UI manager instead of raw JSON: `Local LLM: Open Shared Memory` (and the quick access item) opens a webview panel listing entries — title, kind/scope/pinned/expired badges, tags, content, token estimate and dates. Entries can be created, edited (title, content, tags, kind, scope, pinned, expiresAt) and deleted right in the panel; the `Open JSON file` button keeps access to the source file. Live refresh on memory change; delete uses the correct scope + workspace id; creating a workspace entry without an open project is blocked with an error.
- The quick access Memory section shows the estimated context footprint: `N entries / M expired · ~X tokens context` (new `getMemoryContextTokens` callback at the end of the provider constructor — positionally safe; estimate ~4 chars/token, expired excluded).
- Regression: 4 memory-manager tests (token estimate, list rendering, edit/new form, XSS escaping) + updated quick-access test. Full suite — 343 passing.

### 1.10.94
- DeepSeek got sliders in quick access: `DeepSeek → Max Output` and `DeepSeek → Maximum Context` open the Provider Context panel (`llamacpp.openContextControl`) with two new range sliders. Max output changes `deepSeekDefaultMaxOutputTokens` (1024–393216, default 70000), context — `deepSeekContextLength` (32K–1M, default 258.4K). Apply saves both values to Global; live values update while dragging.
- The `Maximum Context` quick access item now leads to the sliders instead of QuickPick presets; a `Max Output` item with the current value (`70.0K` by default) was added. `ContextControlState` extended with DeepSeek fields (target/min/max for context and max output); clamp bounds match package.json and the provider clamp.
- Regression tests: quick access expects `openContextControl` for both DeepSeek items and the `70.0K` format; `caps context control values` checks the clamp `2M → 1 048 576` and `500K → 393 216`. Full suite — 339 passing.

### 1.10.93
- Live Report got an expandable exploded view for the ordered prompt/cache structure. The `Expand block details` button shows each source segment as its own full-width row regardless of its share of the total prompt: ordinal number, category, message count, exact total/cached/miss tokens, hit%, plus its own cached/uncached scale with minimally visible narrow parts. Small Memory delta, Guard, Tool call and other blocks no longer disappear visually inside the combined bar.
- Fixed detail toggling switching to a new turn during live update. The detail row used to be named by its current newest-first position (`detail-0`, `detail-1`); after a new turn was inserted on top, the same ID belonged to a different record and restoreOpenRows expanded it. Identity is now built from the stable `requestId` (with a safe fallback), the exploded state is stored separately, and the viewport anchor compensates the inserted top row, keeping the selected turn at its previous screen position.
- UI regression verifies request-based detail identity, absence of the old positional ID, expanded segment controls/exact stats, expanded-state retention and the viewport anchor. Embedded JavaScript passes syntax validation; full suite — 339 passing.

### 1.10.92
- The public Shared Memory contract is split into two explicit scopes: `global` for durable preferences and workflows useful to all agents across projects, and `workspace` for paths, commands, architecture and decisions of the current project only. `scope` is now required on save and delete; the ambiguous default-global is gone. The agent tool no longer accepts an arbitrary `scopeId`: the current multi-root workspace id is computed by the extension, so an agent cannot write memory into a foreign project.
- Deletion is protected at the `SharedMemoryService.remove(id, context)` level: a known id alone is not enough — the stored scope and workspace must match the explicitly chosen ones. Updating a workspace entry of another project and changing legacy model-scoped entries through the public two-scope tool are also rejected. Searching without scope sees global + the current project; an explicit workspace search requires an open project.
- Legacy `model` entries remain readable for format compatibility, but new ones cannot be created through agent tools. The confirmation UI and tool results explicitly say "global" or "project". `chat.memory.context` gained `scopeCounts` so the JSONL shows the actual global/workspace entry counts in the prompt and cross-project leakage can be verified.
- Regression tests first reproduced the missing scoped-delete on 1.10.91 (TypeScript: `Expected 1 arguments, but got 2`), then verified the delete denial for another workspace, the required scope, the absent public scopeId and exactly two scopes across all three tools.

### 1.10.91
- Shared memory moved from a relocatable ephemeral block to an append-only ledger. 1.10.90 stabilized memory inside the tool loop, but on the next real user turn the same block was removed from its old position and inserted before the new user message, rewriting the whole cached assistant/tool tail even when the text was byte-identical. Now the first selection creates a provider overlay checkpoint persisted in the conversation snapshot at its original position; identical entry revisions add nothing, new and updated entries are added as a separate Memory delta before the new uncached user tail. Old checkpoints are never rewritten.
- SharedMemoryPromptContext passes individually rendered entries; the SHA-256 revision is compared by the stable entry id. An update with the same id appends a new revision explicitly superseding the old one. Overlay metadata is not sent to the API but is kept in session-state.json; snapshot alignment matches only the host projection and returns the full prefix together with the overlay. The first tool turn after a reload uses persisted-overlay-tool-turn without a new retrieval. On compaction the current checkpoint is restored inside the already intentionally rewritten region. Per-entry delta respects sharedMemoryMaxTokens.
- Live Report now has ordered promptSegments instead of the opaque Messages: System, Tool catalog, Shared memory/Memory delta, User + host context, User, Assistant, Reasoning, Tool calls, Tool results, Compaction summary, Guards/nudges and Unmeasured. Segments are mutually exclusive and sum to the local prompt estimate; server cached_tokens are projected onto them left to right. The legend aggregates categories and marks the split as estimated. The previous double-counting of System inside messageTokensAfterCompact is fixed; the turn JSON now also contains promptSegments.
- After moving memory from ephemeral to the durable overlay, the ephemeral_context_changed class no longer blames a trailing guard/nudge for losing the old prefix: guards are appended to the tail only and cannot causally explain the disappearance of previously cached tokens, so such an anomaly stays upstream_cache_partial with an explicit note.
- The user → tool → new user regression was red on 1.10.90: the third request replaced memory turn one with memory turn two. After the fix the first checkpoint stays, a new entry creates the second delta; separate tests cover unchanged/updated revisions, persistence across restart, a clean wire payload, the exclusive prompt-segment sum and Live Report. Total 337 passing.

### 1.10.90
- Fixed a locally caused DeepSeek cache miss on tool turns from changing shared memory. On live turn 34 (b81cc3ff, conversation b32eed1e) the durable history matched, but the retriever re-picked memory: 3 entries/1028 tokens became 2 entries/829 tokens and the ephemeral context changed 4368 → 3812 chars. Because the memory message sits before the last real user message, changing a few hundred characters rewrote the entire following assistant/tool tail: 16331 previously sent tokens stopped being read from cache.
- The shared-memory prompt is now selected once per real user turn and stored per conversation scope. All subsequent tool-result rounds reuse the same object and byte-identical text; the next real user turn refreshes the selection. A separate null-sentinel records the correct "memory not selected" result so a tool round does not re-run retrieval. After a reload the first encountered turn initializes the value once. The chat.memory.context event reports source=retrieved-user-turn or source=frozen-tool-turn.
- The integration regression runs three full provider requests user → tool result → new user. Before the fix the test failed with actual=memory selected for turn two instead of expected=memory selected for turn one; after the fix the tool round keeps the first block, the new user turn gets the second one, and retrieval is called exactly twice. Full suite: 335 passing.

### 1.10.89
- DeepSeek cache classification fully reworked after an audit of the original 30 and the accumulated 50 live turns of `b32eed1e`. `upstream_expired` is no longer used as an unproven catch-all for the direct DeepSeek/local API, and a CloudFront `Via`/`Cf-Pop` change is no longer claimed as the root cause: the statistics showed the same number of hit<95% with both changed and unchanged visible routes. The new neutral class `upstream_cache_partial` states only a proven fact: with a byte-stable durable prefix, a material part of the already-sent prompt stopped being read from cache. Metric: `lostPriorPrefix=max(0, previousPromptTokens-currentCachedTokens)`; material threshold — at least 2048 tokens and 4% of the previous prompt. A route change remains in the detail as a correlation, not proof of an origin/cache-shard switch.
- Separate explicit causes added: `history_rebuilt_after_restart` for the first request after the extension host starts and VS Code rebuilt the history differently from the persisted snapshot; `ephemeral_context_changed` when the durable history matched but the actually sent provider-only memory/guard messages changed; `upstream_cache_pending` for a materially unwarmed prefix right after compaction. `stabilizeMessagePrefix` now stores/compares `ephemeralHash` and `ephemeralChars` without adding ephemeral messages to the durable snapshot.
- An offline replay of the new classifier over 50 actual cache reports gave: 30 `healthy`, 12 `upstream_cache_partial`, 4 `history_summarized`, 3 `upstream_cache_pending`, 1 `history_rebuilt_after_restart`. Edge cases fixed: a normal 2–3% cache gap stays healthy; a large new tail with a small loss of the old prefix stays healthy; a 4.98% post-compaction gap no longer falls on the boundary. Six new regressions were red before the implementation; provider wiring for ephemeral telemetry is also covered. Total 334 passing.

### 1.10.88
- Fixed the classification of partial DeepSeek cache misses after an upstream route change. Turns 54 and 57 of chat `b32eed1e` were wrongly marked `healthy`: the sent prefix matched 100%, there was no compaction, yet after a CloudFront `Via`/`Cf-Pop` change 18.6K/25.9K cached tokens suddenly disappeared. The provider now stores the previous route and server `prompt_tokens` per conversation scope; the classifier separates the expected new tail from an unexplained uncached remainder and emits `upstream_route_changed` only when a route change is simultaneously proven. A POP change itself is not a problem: turn 56 with a route change and 489 uncached tokens stays `healthy`; an anomalous miss without a route change is `upstream_expired`; after compaction — `upstream_cache_pending`. Backend telemetry added to `chat.cache.report`, a badge in Live Report and three regression tests on the real numbers of turns 54/56/57; total 328 passing.

### 1.10.87
- Fixed the self-calibration of the heuristic token counter for DeepSeek that started auto-compaction too late. The formula smoothed the residual ratio `server/calibratedEstimate` as if it were the full multiplier and converged to the square root of the correct coefficient: in live turns the factor stuck at `1.295` with residual also `1.294`, while the actual raw→server multiplier was about `1.676`. The EMA now smooths `previousFactor × residualRatio`; a new `observedFactorTarget` field added to `chat.heuristic.calibrate`. The regression test converges to `1.68` and confirms the `auto` decision when crossing the soft target.
- Fixed the prefix flip-flop that caused `history_rewritten` and partial cache misses on turns 18–19 of chat `b32eed1e`. The old assistant message #255 was alternately sent with/without `reasoning_content`, because the cache-prefix snapshot stored the input host version before stabilization instead of what was actually sent. `stabilizedDurable` is now persisted in memory, on disk and in cache telemetry; `firstDivergence`, identical/shared prefix and reusable percent are also computed from the sent prompt. The regression test checks three consecutive turns without losing reasoning. Total 325 passing.

### 1.10.86
- Fixed a whole-turn crash with `ToolCallValidationError: arguments are not a valid JSON object` caught by the error tracker (`d697b601`, conversation `b32eed1e`). The turn had `toolCallRepairEnabled=true` and one repair attempt, but the model had already emitted 49 characters of text: the `roundOutputChars === 0` condition forbade the retry, so `flushToolCallBuffers` ended the turn with an error immediately. Partial text no longer blocks the bounded correction retry; the `roundToolCallParts === 0` guard is kept so an already-sent valid tool call is not executed twice.
- The correction prompt warns not to repeat the already shown text and asks to return only the fixed tool call. `chat.tools.validation_retry` events now include `roundOutputChars`/`roundToolCallParts`; cases that cannot be safely retried emit `chat.tools.validation_unrecoverable` with the reason and retry state. Regression test `retries a rejected tool call after partial text with a bounded correction prompt`: red before the fix, green after; total 323 passing.

### 1.10.85
- Fixed shared memory loss on consecutive tool turns. Memory used to be added before `findSnapshotAlignment`; since the block is inserted before the last regular user message, on a tool turn it could land before the pivot and miss `newMessages`. So `chat.memory.context` reported the same 13 entries (~3690 tokens), but the server prompt shrank `192253 → 188315`. Shared memory is now injected after building the durable context from source + conversation snapshot and is guaranteed present in every request.
- `stabilizeMessagePrefix` now aligns only durable messages and then restores the current ephemeral injections at their positions. Previously the filtered-snapshot indices were applied to the unfiltered array, so memory/guards could disappear or shift a neighboring message. `chat.messages.initial` gained `ephemeralMsgCount`, `ephemeralChars`, `sharedMemoryExpected`. Regression test `keeps live shared memory while restoring a durable snapshot prefix`; total 323 passing.

### 1.10.84
- Tail stabilization from snapshot versions (`stabilizeTailFromSnapshot`): when the host rewrites history between turns (truncates tool results, regenerates messages), the pivot rewinds and the tail used to come from the source in the REWRITTEN form — already-sent content changed, so server prompt tokens and uncached amounts "jumped" by several thousand between turns (diagnosed from logs: turn 4→5 the host deleted 4 messages user 122→118/toolResults 106→102; turn 6→7 chars −8787). Now messages recognized by call id as already sent (tool results and assistant with tool_calls) come back in their snapshot version; truly new ones (unknown call ids) stay as the host gave them. Turn N+1 content = turn N content + only new messages: the context weight is monotonic and the cache prefix does not jump. Regression test "keeps the tail stable when the host truncates messages it already sent" (322 passing).

### 1.10.83
- Reasoning weight stabilization between turns: the new `restoreReasoningFromSnapshot` (in `prepareMessagesForBudget`, before dedup) restores `reasoning_content` on assistant messages with tool calls that the host rewrote (transfer by call id from the conversation snapshot — it stores the version the message was already sent with). Previously, if the host changed the history and a call id "fell out" of the reasoning map, the thought was not restored and the context "floated" ±2–4K tokens between turns (sawtooth on long runs). Test "restores reasoning from the snapshot when the host rewrote the history" (321 passing).

### 1.10.82
- Reasoning-weight diagnostics: `chat.messages.initial` now contains `reasoningMsgCount` and `reasoningChars` (sum of `reasoning_content` chars in the sent messages). `reasoning_content` is restored by tool-call id and can "float" ±2–4K tokens between turns when the host rewrites history (call id changes/message comes from the source without thoughts) — now visible on every request. `chat.messages.snapshot_rewound` extended with `pivotIndex` and `rewoundCount` (how many messages were rewound) — you can see where the host trimmed its own tail.

### 1.10.81
- Reasoning dedup (1.10.80) moved into `prepareMessagesForBudget`: the cleanup now applies to ALL request messages, including those reused from the conversation snapshot. In 1.10.80 the strip only ran in `convertForMode` (fresh messages from VS Code), while old messages with duplicated thoughts (content=thoughts+answer) that survived a restart entered the request through `reusedSnapshot` bypassing the cleanup and were preserved in the snapshot forever (after restart: 49/53 reasoning messages still duplicated, ~130K chars ≈ 32K tokens out of 179K).

### 1.10.80
- Agent reasoning no longer duplicated in context: VS Code serializes a ThinkingPart into history as plain text (indistinguishable from a normal text part), so convertMessages put thoughts into `content` and `injectStoredReasoningContent` added the same thoughts to `reasoning_content` (a hard DeepSeek requirement on tool-call follow-ups, otherwise 400) — every turn carried reasoning twice, in long sessions up to ~38K extra tokens per request. The new `stripReasoningDuplicatesFromContent` (llama-provider.ts) cuts the prefix of `content` that matches `reasoning_content` (threshold: ≥100 chars or a full match for short ones), applied before budget counting and snapshotting. Test "strips reasoning the host already serialized into assistant content" (320 passing).

### 1.10.79
- Shared memory injection (`injectSharedMemoryContext`) is marked `ephemeral`: the memory block is live content (entries change between turns), it stays in every request but no longer enters the prefix/budget snapshots and cannot desync the cache prefix (previously, adding memory entries made the block position/text "float", causing misses).

### 1.10.78
- Force-text against host-driven loops: the VS Code host loop makes one request per tool call, so per-request limits (`maxModelTurnsPerRequest`) do not see it. The new setting `llamacpp.toolLoopForceTextThreshold` (default 12, 6-40): after N consecutive tool-call-only turns (no visible text) the next request is sent WITHOUT tools plus a stop message — the model is forced to answer with text and the loop is broken. The counter resets on a text turn. Log `chat.response.tool_force_text`. This is an escalation on top of the soft cross-turn nudge (4/8 turns).

### 1.10.77
- Window race over `session-state.json` fixed: persist now MERGES changes with the current file and writes only the scopes changed in this extension host (dirty tracking for prefix/conversation/toolCatalog snapshots). Previously any window overwrote the whole file with its own (possibly stale) copies of foreign scopes — a chat snapshot could "freeze" at an old turn, and after a reload the first turn aligned to the stale snapshot (turn 17a1cc78: snapshot 362 instead of 411 → +51 messages from source, ~46K uncached). Snapshot deletions also reach the file.

### 1.10.76
- `prefix.firstDivergence` diagnostics extended: on a prefix divergence the `chat.cache.report` log shows role, tool_call_id, callIds, reasoning presence and content length for both message versions (previous + currentMessage) — you immediately see how the host rewrote the message (text, call id or structure).

### 1.10.75
- Ephemeral injections (cross-turn nudge, loop guard, repair/continuation retry messages) no longer enter prefix and budget snapshots (`ephemeral` flag on `OpenAIChatMessage`): they exist in the sent request but are absent from host history, which used to make the snapshot tail unfindable in the source on the next turn → full cache miss (turn 50: 431K→483K, hit 2%). Snapshots filter ephemeral messages; the `snapshot_rebuilt` log now contains `reason` (alignment-not-found / rewritten-history-would-duplicate / migrated-from-prefix) and snapshot/source sizes.

### 1.10.74
- Snapshot pivot rewind (SNAPSHOT_PIVOT_MAX_REWIND=24): when the host drops its own tail (interrupted reply) on a new user message, the snapshot is no longer discarded entirely — a deeper common join point is found and the cache prefix survives. `findSnapshotAlignment` returns `{snapshotPrefix, newMessages}`; search uses precomputed `conversationMessageKey` keys with a position index (no O(n·m) normalizations). The `chat.messages.snapshot_rewound` log shows when it fired. Diagnostics: `prefix.firstDivergence {messageIndex, index, previous, current}` — the first diverging message (not only system).

### 1.10.73
- The system prompt is no longer truncated as a tool result: `truncateToolResultMessages` applies summarization only to real tool results (`role==="tool"` or user messages with the `[tool_result` marker). Previously the ~38K-char system prompt (instructions + skills + agents) collapsed into `[tool result summarized: original=38534 chars...]` → `system_prompt_changed` and a full miss on the first turn after restart.

### 1.10.72
- The false "duplicate detector" no longer discards a valid snapshot: duplication is determined by repeated `tool_call_id`s in the tail (`tailRepeatsSnapshotCalls`) instead of the length ratio. The host trims its own history window, so a snapshot longer than the source is normal, not a duplicate (previously: 405→404 messages, 0-3% hit on turns 10/11/13).

### 1.10.71
- First turn after restart: finding the snapshot/source join point now uses the common predicate `isSameConversationMessage` (tool_call_id / ids of all tool_calls / text with volatile blocks masked: `environment_info`, `workspace_info`, `context`, `attachments`, `reminderInstructions`). Previously the pivot gram required byte equality — after a restart the host re-rendered the history, the snapshot was discarded and the full history went out (387 msg instead of 316) → 1% miss.

### 1.10.70
- Prefix stabilization rewritten to positional alignment: a message is replaced by the previously sent version when bytes match OR tool_call_id / ids of all tool_calls match OR the text is equal after masking the host's volatile blocks. Previously the "bytes" strategy reused only N byte-matching messages (3 of 875 → 1.8% hit) and the "aggressive" branch could lose a fresh user turn. The last message is never replaced. New field `restoredCount` in `chat.cache.prefix_stabilized`.

### 1.10.69
- Fix for the "first turn after restart": history used to inflate (324 → 778 messages) with a cache miss from losing the pivot when VS Code rebuilt the history. Pivot search now uses a K-gram (3 consecutive snapshot tail messages, SNAPSHOT_PIVOT_GRAM=3) — resilient to 1-2 changed tail messages.
- DeepSeek max output: `deepSeekDefaultMaxOutputTokens` 131072 → 70000 (reasoning counts into output tokens; caps "endless thoughts" in one turn, lowers loop risk and cost).

### 1.10.68
- Fix for the Live Report context "chaos" (jumps 122K→178K→167K→141K→174K with autoCompacted:false): when VS Code rewrites already-sent messages (history_rewritten), the snapshot logic no longer duplicates the history tail — if snapshot+newMessages is longer than the full source, the snapshot is declared stale (reason=rewritten_history_would_duplicate) and the full source is sent. The cache prefix is stable: 4.5% miss → ~95%.

### 1.10.67
- Gentler compaction: `COMPACTION_TARGET_RATIO` 0.6 → 0.75 (~75% of current context is kept instead of ~60%; ~25% loss instead of ~40%). Reason: compaction snapshots showed that at 0.6 agent chats lost too much working context (201K→113K, 218K→129K). context-budget tests updated.

### 1.10.66
- Compaction diagnostics: every compaction (auto-compact and overflow retry) is auto-saved as a JSON snapshot in `<globalStorage>/compactions/` (rotation of 20 files, best-effort). Contains before/after (messages, tokens, chars), targetTokens, a summary sample (400 chars), the last 2 tail messages and the number of truncated tool results — so compression quality can be reviewed manually.

### 1.10.65
- Fix for "thoughts as the answer": reasoning in `delta.content` is folded by three markers (`<think>`, `|thinking|>`, `thinking>`); the fallback without `LanguageModelThinkingPart` no longer prints thoughts as visible text (hides them, symmetric to `emitThinkingText`).

### 1.10.64
- Fix for hard compaction: new setting `llamacpp.compactMaxToolResultChars` (default 8000, 1000-24000) — long tool results in the kept tail are truncated, so significantly more turns fit into the budget (was: 187 → 15 messages at a 60% budget because of uneven token distribution).
- DeepSeek setup wizard: `deepSeekDefaultMaxOutputTokens` 65536 → 131072; the wizard no longer re-enables `autoCompact`.

### 1.10.63
- DeepSeek loop fixes: the repeated-tool-call detector is fixed (separate `loopInspectionMessages` conversion in tool mode — previously the detector never fired); cross-turn nudge over an 8-turn window at tool-only density; hard `maxModelTurnsPerRequest` limit (default 6, clamp 2-20) with the "[agent loop guard]" text.

### 1.10.60
- Unified soft compaction scheme: target = current size × 0.6 (`COMPACTION_TARGET_RATIO`), the same for proactive compaction and overflow retry; the hard scheme and the `hardCompactKeepLastTurns` setting were removed (hardInputTarget stays as a diagnostic metric).
- `llamacpp.autoCompact` back to default true; `contextUtilization` 0.94 (~40K headroom to the trigger in a 258K window).
- Compaction protection between restarts: on the first request of a scope after extension startup without a snapshot, proactive compaction is skipped (`scopesSeenSinceStartup`).

### 1.10.58
- `autoCompact` default false — compaction used to fire between restarts (later reverted in 1.10.60 in favor of the `scopesSeenSinceStartup` protection).

## 1.10.0 - 2026-08-04

Stable release after the 1.9.x dev-patch series. Highlights:

### Performance & diagnostics

- Claude usage probes no longer spawn a full Claude Code CLI agent every
  ~2 minutes per window when Claude is not in active use — this heavyweight
  polling was loading the machine and slowing unrelated chats. Probes now
  only run within 10 minutes of real Claude activity (or on explicit
  refresh); Claude keep-alive behavior is unchanged.
- DeepSeek compaction grace (`deepSeekCacheWriteGraceMs`) reduced from 3
  minutes to 1 minute: after an auto-compaction the provider waits less
  before the next tool-result continuation, cutting idle "agent is silent"
  stretches from ~13 minutes/day to ~4. A rare extra uncached rewrite
  (~$0.05) is the only cost.
- New `chat.request.arrived` / `codex.chat.request_arrived` diagnostics log
  the gap between our last completed response and the next request arrival,
  splitting "VS Code-side pause" (tool execution, chat-view rendering,
  request plumbing) from model latency when investigating slow big chats.
- `sanitizeOrphanToolCalls` rewritten from O(n²) to O(n) via suffix counts —
  large-chat conversion no longer rescans the whole history per message.
- Codex cache diagnostics now record `idleGapSeconds` on reused threads and
  classify a cold first segment as TTL expiry vs. eviction/backend routing;
  a `codex.chat.cold_first_segment` event captures the exact idle gap and
  prefix delta when a fresh turn starts cold.

### Reliability fixes

- Fixed DeepSeek/subagent 400 errors: "An assistant message with 'tool_calls'
  must be followed by tool messages responding to each 'tool_call_id'".
  Orphan tool calls (from interrupted turns or subagent contexts that drop
  tool results) are now stripped before the request is sent, in both tool
  and user tool-result modes.
- Codex: interrupted/resumed turns and turn-boundary handling hardened
  (`turn-bridge`, `codex-provider`), rollout metrics and token usage
  accounting fixes across live and rollout sources.
- Copilot patch runtime: keep-alive and tool-catalog stability fixes.

## 1.9.25 - 2026-08-04

- Claude cache keep-alive now has an "Ignore usage-limit pause" toggle in
  Quick Access. When enabled, keep-alive continues even when the 5-hour
  usage limit exceeds the 90% auto-pause threshold so the prefix cache
  survives across the usage-limit window.

## 1.9.24 - 2026-08-04

- Fixed an intermittent Claude warm-session loss after large turns. The
  Anthropic API stream closes naturally after every turn, but the pump
  handler unconditionally marked the session unhealthy, which caused the
  next request to fall through to a durable restore with a stale runtimeKey
  and a cold first segment. Natural stream closure after a completed turn
  now leaves the session healthy so warm reuse survives.

## 1.9.23 - 2026-08-04

- Claude steering (sending a follow-up message mid-turn) now works. The root
  cause was that a cancelled turn never persisted its stableAssistantMessageId;
  the next durable restore replayed the orphan tail with incomplete tool calls
  and the model continued the old task instead of reacting to the follow-up.
  Cancelled turns now update the resume boundary before re-throwing, so the
  restored transcript ends at the last completed assistant message.

## 1.9.22 - 2026-08-04

- Claude runtime fingerprint no longer includes the tool catalog. VS Code's
  per-restart tool-selection optimization changes the advertised tool set,
  which flipped runtimeChanged on every reload and forced a cold session_restored
  with a full cache miss. The runtime key now only tracks model, context target,
  cwd, and effort — Claude SDK handles tool-catalog changes natively through
  forkSession.
- A restored Claude session with 90%+ cache hit is now classified as healthy
  instead of session_restored. The restored label is only used when the hit
  rate is below the threshold.

## 1.9.21 - 2026-08-04

- Removed the default Claude maxTurns limit (was 24). The Agent SDK no
  longer receives a turn budget, so long-running agent turns with many tool
  rounds run until the cumulative-input circuit breaker or Anthropic API
  rate-limit stops them. Set the claudeMaxAgentTurns setting to a positive
  value to re-enable a per-turn segment cap.

## 1.9.20 - 2026-08-04

- Claude turns that hit the configured maxTurns segment budget (default 24)
  now end gracefully instead of failing. The SDK stops cleanly, the turn
  completes with a max_model_segments safety-stop reason in the live report,
  and the warm session survives. Previously the guard called failActiveTurn,
  which tore the session down and forced the next turn into a cold
  session_restored with a full cache miss and a compacted prefix.
- The default remains conservative (24); raise claudeMaxAgentTurns for
  long-running agent turns with many tool rounds.

## 1.9.19 - 2026-08-03

- Claude cache keep-alive no longer shows "No eligible session" while a
  Claude turn is running. The health card now reports `Waiting` with a clear
  explanation: "Claude turn is active; keep-alive will check again in 60s."
  Sessions with a prefix below the 100k-token threshold also show `Waiting`
  instead of a dead-end status.


## 1.9.18 - 2026-08-03

- Codex context usage in the live report now reflects the full cumulative thread
  total instead of the last model segment's delta. A reused `user-turn` showed
  ~87k when the model actually saw ~340k. Context above the window (e.g. 333k
  in a 258k window) signals server-side compaction between turns, previously
  invisible.
- Codex turns in the live report now include `inputMode` and `compacted`
  fields, so a switch from `full` (whole history, large) to `user-turn` (delta,
  smaller) is no longer misread as data loss.
- A reused Codex thread with low cache hit is now classified `upstream_expired`
  rather than the unactionable `unknown`.
- The dev gate now contains 297 tests.

## 1.9.17 - 2026-08-03

- Fixed the "first DeepSeek turn after a window reload always misses" bug.
  `refreshLanguageModelChatInformation()` cleared the persisted stable tool
  catalog on every activation, so the first request after a reload could not
  compare against the previous catalog even when VS Code advertised the exact
  same tools. The persisted catalog is now retained, and the same tool set
  keeps its prefix-cache hash across reloads.
- Root cause was confirmed from state: the persisted catalog fingerprint
  (`c0fbc0dc…`) exactly matched the post-reload request fingerprint, yet the
  in-memory catalog had been wiped, so the request was treated as a catalog
  change and the full 400k-token prompt was rewritten.

## 1.9.16 - 2026-08-02

- Cache diagnostics now record the advertised tool count and system-message
  hash of every request and its predecessor. A `tool_catalog_changed` miss
  reports the actual `N → M` tool delta, and `system_prompt_changed` states
  that VS Code rewrote system instructions/history (typically after an
  interruption). Tool-catalog refresh/snapshot events log the exact removed and
  added tool names, so a reload-driven catalog change (for example VS Code's
  own "Optimized tool selection") is visible instead of appearing as an
  unexplained full miss.
- Fixed a corrupted prefix-snapshot block and completed the `toolsCount`
  plumbing so the enriched diagnostics survive TypeScript strictness.

## 1.9.15 - 2026-08-02

- The cumulative-input circuit breaker now counts cache reads at 0.1x weight
  instead of full size. A warm turn re-processes the whole prefix on every
  model segment, so the unweighted 2M limit fired on every large turn, failed
  it, tore down the SDK session, and forced the next turn into a cold restore
  (first-segment miss, smaller first segment, and no eligible keep-alive
  sessions). Weighted counting only trips the breaker on genuinely large fresh
  input.
- Session Quality now has an independent Claude Cache Keep-Alive health card,
  visible even when no Claude user turn is running. It reports the current
  state and reason, usage-snapshot age, eligible/live sessions, protected model
  and prefix size, next attempt, last attempt/success/failure, and the latest
  maintenance turn's cache-read/cache-write result.
- Keep-alive is fail-safe: unknown or stale five-hour usage pauses background
  requests instead of treating the limit as 0%. Usage refresh and maintenance
  now run sequentially, failures are preserved, and retries are throttled.
- Maintenance turns are tagged separately and no longer create or overwrite
  ordinary Claude turn rows in the live report. The largest eligible prefix is
  selected first so the most expensive cache receives priority.
- The dev gate now contains 297 tests.

## 1.9.14 - 2026-08-02

- Durable Codex `thread/resume` now reapplies the same model, normalized cwd,
  approval policy, read-only sandbox, developer instructions, and restricted
  app-server config used by `thread/start`. Previously resume sent only the
  thread id, allowing a restarted process to inherit a different managed
  permission profile and invalidate the exact prompt-cache prefix.
- Windows workspace cwd spelling is stable across reload (`D:/...` and
  `d:\\...` resolve to the same lower-case drive form in Codex thread settings).
- The dev gate now contains 295 tests.

## 1.9.13 - 2026-08-02

- Claude durable-resume fallback is fail-safe by default. Before any full-input
  replay, the provider estimates conversation plus tool-schema tokens and
  requires both a replay below 64k tokens and a fresh five-hour usage snapshot
  below 80%. Unknown/stale usage, larger replays, or policy `never` stop before
  the API call; `always` remains an explicit escape hatch.
- Claude Agent SDK turns now have two independent circuit breakers: at most 24
  model segments and 2M cumulative processed input tokens by default. This
  prevents the 48-segment/6.6M-token incident pattern from running until an
  upstream `rate_limit` failure.
- The compact live report includes the exact fallback decision, estimated and
  allowed replay size, configured turn limits, and any safety-stop reason.
- The dev gate now contains 294 tests.

## 1.9.12 - 2026-08-02

- Fixed the observed Claude cold-fallback trigger after an interrupted turn.
  Durable sessions now persist the last confirmed assistant message UUID and
  resume with Agent SDK `resumeSessionAt`, excluding orphan user/interruption
  messages from the resumed transcript tail.
- Claude fallback diagnostics now preserve the original resume failure reason,
  stage, and SDK error in the live turn record and in the session-quality UI.
- Session Quality now copies a compact, cost-oriented turn report by default;
  Shift+Copy produces formatted text and Alt+Copy retains the full JSON. Large
  step and usage tables show only their first 3 and last 5 entries.
- Claude cache health in the turn table now uses the final continuation segment
  while retaining the cumulative processed blend in the detailed report.
- The dev gate now contains 292 tests.

## 1.9.11 - 2026-08-01

- Live report now explains Claude cache misses after a reload: restored and
  rollover sessions are classified as `session_restored` / `session_rollover`
  instead of `unknown`. When the restored session's runtime fingerprint
  changed (model, context target, effort, or the advertised tool catalog —
  which happens after every VS Code reload), the detail states that the cached
  prefix was rewritten because the system prompt differs.
- The dev gate now contains 291 tests.

## 1.9.10 - 2026-08-01

- Fixed follow-up messages being ignored while Claude or Codex is mid-turn.
  - Claude: the Agent SDK query stream ends after an interrupt, so a session
    with a dead stream is now marked unhealthy, excluded from warm reuse, and
    replaced through the durable restore path. Previously a follow-up was
    pushed into the dead stream and never produced a reaction.
  - Codex: an active tool turn is now superseded even when the follow-up
    arrives with the same Copilot turn index (`>=` instead of `>`), so the new
    user message interrupts the old work instead of being queued forever.
- Smart Claude cache keep-alive: while idle and below 90% usage limit, a
  minimal "reply ok" turn refreshes the Anthropic prompt-cache TTL every
  45 minutes on the largest idle session with a prefix over 100k tokens.
  Tool calls are denied inline, it never runs during an active turn, pauses
  automatically at 90% usage, and is toggled from Quick Access > Claude >
  Cache Keep-Alive (`llamacpp.claudeCacheKeepAliveEnabled` /
  `llamacpp.claudeCacheKeepAliveMs`).
- The dev gate now contains 291 tests.

## 1.9.9 - 2026-08-01

- Extension audit: removed dead code found by a full repository pass.
  - `CLAUDE_EXTENDED_CONTEXT_WINDOW` — never referenced (the context-control
    slider already caps at `CLAUDE_CONTEXT_TARGET_MAX`).
  - `ToolCallBuffer` type, `validateTools()`, and `tryParseJSONObject()` —
    exported but never used, not even in tests.
- Verified consistency: all 50 manifest commands are registered in code (two
  are registered dynamically through `contextLimitCommand`), all 83 manifest
  settings are read or written by code, package scripts match AGENTS.md, and
  the only source file without importers is the `extension.ts` entry point.
- The dev gate now contains 289 tests.

## 1.9.8 - 2026-08-01

- Quick Access now shows the live usage limit directly on the provider row
  without expanding the group: `Codex Connected (Plus): 70% R:2.08 17:25` and
  `Claude Connected (Pro): 20% R:7.08 21:45`. `R` is the window reset time in
  `D.MM HH:MM`; Claude uses the 5-hour session window, Codex uses its
  subscription window (a Codex 5-hour window is shown automatically if the
  runtime reports it in the future).
- Codex subagent routing is restricted to the GPT-5.6 family (Sol still
  excluded): `gpt-5.4-mini` and other non-5.6 models are no longer advertised
  in the `runSubagent` model enum, so agents cannot select them as subagents.
- The dev gate now contains 289 tests.

## 1.9.7 - 2026-08-01

- Fixed "micro-compactions": every turn near the limit was recorded as
  auto-compacted while the history was returned unchanged. The compaction
  estimator used the uncalibrated heuristic while the trigger used the
  calibrated count, so the fast path no-opped whenever the calibration factor
  drifted above 1. Compaction now shares the calibrated estimate.
- Auto-compaction now lands at 75% of the soft input target
  (`COMPACTION_TARGET_RATIO`) instead of exactly at the trigger threshold.
  Compacting to the threshold re-triggered on the very next turn; the new
  target leaves real headroom (roughly 30% reduction) so one compaction lasts
  for dozens of turns and the upstream prompt cache is rewritten much less
  often.
- The dev gate now contains 287 tests.

## 1.9.6 - 2026-07-31

- Subagent routing is now enforced at schema level: `runSubagent.model` accepts
  only the advertised catalog labels (`enum`), so `model="Auto"` or unknown
  values are rejected instead of silently inheriting the expensive parent
  model. The tool description explains the rejection.
- Fixed Codex subagent labels to match the model picker exactly
  (`GPT-5.6 Terra (Codex)` / `GPT-5.6 Luna (Codex)`), which is why Luna and
  Terra were never actually selected before. Codex subagent availability now
  reflects the ChatGPT subscription rate-limit state, and Terra is preferred
  over Luna in the guidance ordering.
- Subagent budget policy now states an explicit order: local (unlimited) →
  DeepSeek (when no vision is needed; DeepSeek cannot process images) → Codex
  Terra → Codex Luna → Claude Opus 5 (last resort).
- Quick Access now shows a live `Usage Limit` row for Codex (percent used and
  reset time) and a `Balance` row for DeepSeek from the official
  `GET /user/balance` endpoint. All provider usage rows auto-refresh every
  minute so reset times are visible without manual refresh; Claude limits
  already showed per-window percentages.
- The dev gate now contains 286 tests.

## 1.9.5 - 2026-07-31

- Fixed the DeepSeek double-miss after compaction. DeepSeek materializes the
  disk cache for a newly compacted prefix asynchronously, so the immediate
  tool-result continuation missed even with a byte-identical prefix (~490k
  tokens wasted twice). The provider now waits out the remaining
  `llamacpp.deepSeekCacheWriteGraceMs` window (default 3 minutes) before the
  first continuation after a compaction; the wait is skipped for new user
  turns, non-DeepSeek sources, and disabled `cachePrompt`.
- Renamed the misleading `upstream_expired` classification for this race to
  `upstream_cache_pending` with an explicit write-race detail when the previous
  turn compacted the history; genuine eviction still reports
  `upstream_expired`.
- The dev gate now contains 284 tests.

## 1.9.4 - 2026-07-31

- Raised provider session retention to 24 hours: Claude in-memory SDK sessions,
  Codex native-tool continuations and tool timeouts, and both armed rollover
  intents no longer expire after the former 30 minutes. A pause or reload
  within a day keeps the live session and its durable mapping instead of
  starting a cold transcript.
- Durable Claude transcripts and Codex threads remain eligible for seven days,
  so a 24-hour gap still restores the session. Prompt-cache warmth remains
  bounded by the provider's own cache TTL (5 minutes or 1 hour) and still needs
  a keep-alive turn to be guaranteed across a long pause.

## 1.9.3 - 2026-07-30

- Added a Provider Context panel with real range sliders in Quick Access.
  Claude can select a 258.4k-967k working target inside the Opus 5 1M window;
  Codex can select a cold-start target capped to the latest server-reported
  model window.
- Updated the Claude Agent SDK and bundled platform runtime to `0.3.220` /
  Claude Code `2.1.220`. Claude sessions now use the actual `opus[1m]` model
  variant and pass the selected target through
  `CLAUDE_CODE_AUTO_COMPACT_WINDOW`; cold-start history scales with the target.
- Removed the extra Codex `0.45` history multiplier. Cold-start compaction now
  subtracts explicit output, tool-schema, developer-instruction, and safety
  reserves from the selected working target, raising the representative
  semantic-message budget from about 87k to about 197k inside a 258.4k window.
- Made Codex server telemetry authoritative for advertised context size, kept
  manual `codexContextLength` as a pre-telemetry fallback only, and added
  regressions for 1M Claude selection, context slider bounds, and exact Codex
  budget calculations. The dev gate now contains 283 tests.

## 1.9.2 - 2026-07-30

- Unified completed Codex thread and Claude Agent SDK session retention at
  seven days. Overnight or post-limit-window reloads no longer discard a valid
  Codex thread after the former four-hour TTL.
- Migrated legacy Claude durable mappings that predate Copilot turn indices.
  The same advancing Copilot conversation can now resume its validated SDK
  transcript after reload even when Copilot has compacted or rewritten the
  visible message history.
- Kept same-turn retry protection, model/workspace validation, transcript
  existence checks, and seven-day stale-entry pruning, with regression coverage
  for a five-hour Codex restore and a shortened legacy Claude history.

## 1.9.1 - 2026-07-29

- Restored durable Claude Agent SDK sessions after Extension Host reload even
  when the current VS Code tool catalog changes. A matching model and advanced
  Copilot conversation can resume its validated on-disk session with the
  current tools instead of paying for a cold full-transcript start.
- Emitted Claude native `usage` after the visible text or tool call on every
  completed provider response boundary. Copilot Chat Session Info can now
  observe the latest model segment throughout a native-tool loop as well as on
  the terminal response.
- Added privacy-safe restore diagnostics and regression coverage for runtime
  drift, stale or non-advanced conversations, legacy persisted mappings, and
  ordered per-boundary usage emission. The dev gate now contains 280 tests.

## 1.9.0 - 2026-07-29

- Promoted the unified Local, DeepSeek, Codex, and Claude model-picker workflow
  to a stable release after the full 1.8.x hardening cycle.
- Stabilized durable Codex app-server threads and Claude Agent SDK sessions,
  including reload/rollover recovery and same-turn continuation through native
  VS Code tool cards.
- Kept executable actions inside the visible VS Code tool and approval boundary,
  with fail-closed handling and same-thread recovery when a subscription runtime
  requests a prohibited internal action.
- Added live Session Quality diagnostics for model/tool timelines, context,
  compaction, cache reads and writes, reasoning, latency, lifecycle, and
  provider-specific continuation health without retaining prompt bodies.
- Normalized native and aggregate usage reporting so Codex and Claude current
  context occupancy is not confused with multi-segment processed billing.
- Hardened prompt stability, bounded tool results, deterministic compaction,
  session compatibility checks, Copilot patch validation, and release
  reproducibility; the stable gate contains 279 extension-host tests.

## 1.8.47 - 2026-07-29

- Kept the fail-closed Codex internal-action boundary while recovering on the
  same app-server thread: after the prohibited turn is interrupted, a bounded
  follow-up reminds Codex to use only native VS Code tools instead of replaying
  the full visible transcript on a cold thread.
- Split a real cold first segment from continuation health in Session Quality.
  A new thread whose later model segments recover above 90% is now healthy,
  while its paid cold-start segment remains visible in processed cache totals
  and a separate `cold Codex startup` counter.
- Added regression coverage for blocked-action interrupt settling, recoverable
  exception classification, final-segment cache health, and report rendering.

## 1.8.46 - 2026-07-29

- Added Claude Agent SDK usage to native Copilot Chat Session Info through the
  same `usage` response-data contract used by the other contributed providers.
- Native Claude context occupancy now uses the final assistant model segment,
  including fresh input, cache reads, cache creation, output, and cached-input
  detail. This avoids treating aggregate multi-step billing as one oversized
  context window.
- Kept aggregate usage across every Claude model segment in Live Report and
  usage history, while the native denominator continues to use the advertised
  context window refreshed by the SDK context probe.

## 1.8.45 - 2026-07-29

- Added one live Claude logical-turn record across Agent SDK model segments and
  native VS Code tool-result continuations, with stable request identity and
  explicit `new`, `warm`, `restored`, `rollover`, or `resume-fallback` mode.
- Added exact Anthropic fresh-input, cache-read, cache-creation, output, and
  thinking-token segments; first-model/visible latency; native tool names and
  duration; terminal lifecycle; and asynchronous SDK context categories to
  Session Quality.
- Added Claude-specific cache and context panels plus a live model/tool timeline
  instead of rendering Agent SDK sessions as stateless prompt-prefix requests.
- Extended subagent correlation to Claude parents and updated the guarded
  Copilot patch anchors for the minified variable names in VS Code 1.131 while
  retaining unique-match and syntax-validation safeguards.

## 1.8.44 - 2026-07-29

- Fixed a newer user turn arriving while Codex waits on a long native tool or
  `runSubagent`: the pending app-server turn is interrupted and the next user
  message continues on the same compatible thread instead of replaying a full
  compacted transcript as a cold start.
- Finalized abandoned, interrupted, failed, cancelled, and 30-minute tool
  timeout records in Live Report. Timed-out native tools no longer remain
  indefinitely `running`, and their server usage is accounted before reuse.
- Split Codex cache analytics into processed input/cache across all model
  segments and final/continuation cache reuse. A turn such as 0% then 96.7% now
  shows both facts instead of presenting the 49% blended cost as continuation
  health.
- Merged rollout and live model/tool timelines, distinguished VS Code tool
  execution from app-server catalog lookup, and correlated eligible local or
  DeepSeek subagent turns with their parent `runSubagent` call.

## 1.8.43 - 2026-07-28

- Reworked the primary README around the extension's actual goals, supported
  transports, native VS Code tool boundary, model-picker Codex flow, durable
  sessions, cache/context controls, diagnostics, security, and known limits.
- Updated the architecture, Codex subscription, Copilot patch, token/cache,
  reliability, and release-audit documentation for patch v16 and the live
  Codex model/tool timeline.
- Documented the 1.8.43 release gates explicitly. Building and installing this
  VSIX remains separate from the later reviewed commit, tag, and publish step.

## 1.8.42 - 2026-07-28

- Added running Codex turn upserts and a model/tool step timeline to Live
  Report, including token/cache snapshots, tool status, and latency while a
  model-picker Codex request is still active.
- Kept tool completion metrics synchronized across native VS Code tool-result
  continuations so the live timeline reflects the same app-server turn.

## 1.8.41 - 2026-07-28

- Added a direct, privacy-preserving Codex rollout collector. Live Report now
  distinguishes one logical chat turn from its model segments and records exact
  token/cache snapshots, tool calls/results, tool latency, first-model-event
  latency, first-visible-response latency, and reasoning tokens.
- Added live-notification fallback metrics when a persisted rollout is not yet
  available, while retaining the original turn's compaction and context data
  across native VS Code tool continuations.
- Fixed fractional `codexContextUtilization` values being rounded down by the
  integer configuration clamp and removed false subagent classification from
  Codex tool continuations.

## 1.8.40 - 2026-07-28

- Added conversation compaction for Codex: full-turn messages are now compacted
  (summary + recent suffix) before serialization, reducing input tokens from
  ~170-193K to ~50-70K per turn when history exceeds 12 messages.
- Enhanced Codex per-turn diagnostics: duration, tool calls, output chars,
  compaction metrics, and context window are now reported to the live Session
  Quality report instead of zeros.
- Added `codexContextUtilization` and `codexCompactKeepLastTurns` config keys
  to tune Codex compaction behaviour.

## 1.8.39 - 2026-07-28

- Persisted exact per-conversation DeepSeek message snapshots and stable tool
  catalogs across Extension Host restarts, with one-time recovery from legacy
  prefix snapshots.
- Fixed normal auto-compaction so it stops at the soft target. The lower hard
  target is now used only after a backend-confirmed context overflow instead of
  rewriting the same prompt a second time before its first request.
- Upgraded the native Copilot Chat patch to v16. It disables Copilot-owned
  summarization/truncation for contributed llama models, forwards a stable
  conversation id, uses deterministic tools, and waits for tool definitions
  only after their cached signature actually changes.
- Redesigned the live Session Quality report with cache diagnostics, filters,
  issue highlighting, expandable detail cards, and state-preserving updates.

## 1.8.1 - 2026-07-27

- Added `stabilizeMessagePrefix`: when two consecutive requests share a common
  message prefix AND the static parameters and tool catalog are unchanged, the
  prefix messages are replaced with the exact byte-copy of the previous
  request.  This keeps the DeepSeek prompt cache warm even when VS Code trims
  different numbers of middle messages between turns — the common prefix never
  drifts.
- Added `chat.cache.prefix_stabilized` diagnostics so you can see when the
  prefix was pinned and how many messages were reused.

## 1.8.0 - 2026-07-27

- Fixed the root cause of long-session prompt-cache collapse. VS Code attaches
  `cache_control` breakpoint markers to chat content and moves them between
  messages as a conversation grows. Every conversion path rendered them into
  message text — as `{"$mid":…}` JSON in the llama/DeepSeek path, as
  `[data cache_control, N bytes]` in the Codex and Claude tool-result paths,
  and as `{"type":"data",…}` in the serialized Claude transcript. A moving
  marker rewrote already-sent history and invalidated the whole upstream
  prefix. Diagnostics showed the prefix diverging at message 2 of 420 with an
  unchanged message count, pinning DeepSeek at ~10% cache hit for entire
  sessions. All paths now drop the markers before any textual rendering.
- Scoped the reasoning map per conversation. It was a single global map with
  LRU eviction at 256 entries shared by every chat and model, so a second busy
  conversation silently evicted entries the first one's cached prefix depended
  on. Whole conversations are now evicted instead of individual entries.
- Bound the positional reasoning fallback to the actual tool-call ids. The
  fallback target moved forward each turn, so the previous target lost its
  `reasoning_content` and changed shape after it had already been sent.
- Added `chat.cache.report` diagnostics to the local, DeepSeek, Codex, and
  Claude providers. Codex and Claude previously reported no cache telemetry at
  all. The report includes cached/uncached token split, hit and miss percent,
  and a classified miss reason: `cold_start`, `request_params_changed`,
  `tool_catalog_changed`, `system_prompt_changed`, `history_rewritten`,
  `history_truncated`, `session_not_reused`, or `upstream_expired`.

## 1.7.5 - 2026-07-27

- Persisted the DeepSeek reasoning map (`_reasoningByToolCallId`) to
  `globalState` so it survives Extension Host restarts.  Previously a reload
  cleared the in-memory map, causing historical tool-call messages to lose
  their `reasoning_content` and breaking DeepSeek prompt-cache prefix reuse.
- Added lazy `loadPersistedReasoningMap()` and `persistReasoningMap()` with
  LRU-aware merge so new entries never overwrite previously persisted ones.
- Overrode `processStreamingResponse` in the llama provider to restore the
  map before streaming and persist it after every successful response.
- Added `MockMemento` and two regression tests that reproduce the cache-prefix
  instability across simulated restarts and verify the map is fully restored.

## 1.7.4 - 2026-07-27

- Fixed a severe DeepSeek prompt-cache regression where the newest reasoning
  block could be copied into every historical assistant tool-call message.
  Stored reasoning is now restored only by its exact tool-call id, with a
  newest-message-only compatibility fallback.
- Stabilized the exact API Direct tool catalog for each Copilot conversation.
  Optional tool activation no longer rewrites the cached prefix unless a tool
  is explicitly activated or a previously available tool disappears.
- Upgraded the guarded Copilot integration to patch v9. It now also bounds
  terminal output, native tool text, and non-text tool payloads before VS Code
  serializes them into chat history, preventing multi-hundred-megabyte session
  snapshots and extension-host stalls.
- Added `Local LLM: Continue Latest Codex Thread in New Chat` to resume the
  newest durable completed Codex thread without loading an already bloated VS
  Code transcript.
- Added bounded-output guidance to Codex terminal, file, and search tools so
  large logs, JSONL data, repository listings, and binary content stay out of
  native tool cards unless a narrow excerpt is required.

## 1.7.3 - 2026-07-26

- Added an explicit Claude rollover command for chats that have grown too large
  for VS Code's renderer-to-extension-host RPC serialization. It opens a new
  lightweight chat and resumes the newest persisted Agent SDK session while
  sending only the new user turn.
- Persisted rollover intent for 30 minutes so a reload between the command and
  the first new message does not lose the recovery operation.
- Made completed Claude durable-session metadata writes awaited, preventing an
  immediate reload from racing the workspace-state update.
- Kept the original durable mapping and rollover intent intact when a resume
  fails, avoiding a silent cold-start fallback that would lose conversation
  context.

## 1.7.2 - 2026-07-26

- Fixed Claude cold starts failing with `Invalid string length` on very long
  Copilot chats by applying `claudeMaxInputChars` while serializing messages,
  instead of constructing an unbounded JSON string before truncation.
- Added a 5,109-message regression that verifies bounded cold-start input and
  preserves the complete transcript for small conversations.
- Upgraded the guarded Copilot integration to patch v8. Prompt rendering now
  remains bounded by the effective model budget instead of cloning the endpoint
  with `Number.MAX_SAFE_INTEGER`, preventing multi-second full-history materialization
  and garbage-collection stalls in long chats.
- Added pre-turn diagnostics for Claude input preparation failures and the
  effective cold-start character limit.

## 1.7.1 - 2026-07-26

- Fixed Codex conversations silently starting as ephemeral when an effective
  contributed configuration default disagreed with the new durable defaults.
  Only explicit user/workspace overrides can now disable persistence.
- Replaced the incorrect post-reload `thread/read` probe with the official
  `thread/resume` operation and verify the returned thread id and persistence.
- Made durable `workspaceState` writes part of completed-turn finalization and
  added diagnostics for requested/returned persistence plus stored thread ids.
- Added a fail-closed pre-turn check: if app-server does not honor the requested
  persistence mode, the thread is removed before any paid model turn starts.
- Added a zero-model-turn, two-process app-server persistence smoke test covering
  `dynamicTools`, history materialization, restart, resume, read, and cleanup.

## 1.7.0 - 2026-07-26

- Added durable completed-session resume across VS Code reloads for Claude and
  Codex, keyed by the stable Copilot conversation identity and validated
  provider/runtime/history fingerprints.
- Enabled official Claude Agent SDK transcript persistence for user chats with
  safe session forking and a full-history fallback before visible output.
- Made Codex threads durable by default, reattaching them through `thread/read`
  after app-server restart while retaining an explicit ephemeral privacy mode.
- Canonicalized Claude MCP and Codex dynamic tool ordering plus JSON Schema key
  ordering so Copilot tool re-enumeration cannot cause a false semantic cold start.
- Documented that physical VS Code extension/tool registration still occurs,
  while Local and DeepSeek preserve stable upstream prompt-cache prefixes.

## 1.6.2 - 2026-07-26

- Fixed Claude subscription availability so the SDK's `allowed_warning` status
  remains advisory near the usage limit; only `rejected` blocks new requests.
- Added regression coverage for both warning and rejected runtime statuses.

## 1.6.1 - 2026-07-26

- Added the backend-confirmed `claude-opus-5` subscription profile and removed
  Sonnet 4.5, Haiku 4.5, Fable 5, and Opus 4.8 from the curated Claude picker.
- Raised the default Claude output advertisement to the backend-reported Opus 5
  limit of 32,000 tokens and updated the personal Opus agent to the new model id.

## 1.6.0 - 2026-07-26

- Embedded guarded Copilot Chat patch v7 into the main extension with silent
  startup verification, apply/status/restore commands, exact backups, and
  fail-closed compatibility checks for native context and thinking controls.
- Compiled mandatory subagent `model` schema enforcement directly into the
  Codex and Claude bridges, removing the need for Patch Guardian on this extension.
- Consolidated the repository patch CLI onto the same runtime implementation,
  updated integration documentation, and synchronized the dependency lockfile.
- Removed stale reasoning state and passed the full lint plus 236-test quality gate.

## 1.5.33 - 2026-07-24

- Fix `summarizeToolResultContent` for base64/image-result data (was skipping binary content).
- Rewrite `subagent-guidance` with clearer model-selection rules and quoting around model labels.

## 1.5.32 - 2026-07-24

- Raised the default prioritized `apiDirect` tool subset from 48 to 70 so the
  current VS Code tool catalog can retain native subagent delegation tools.
- Assigned explicit priority to `runSubagent` and related delegation tools so
  they remain available even when a larger catalog must still be truncated.
- Added regression coverage for an 83-tool catalog: the request keeps exactly
  70 prioritized tools and includes `runSubagent`.

## 1.5.31 - 2026-07-24

- Added global custom agents for all available model tiers: Qwen 3.6 27B
  (local, unlimited tokens), DeepSeek V4 Pro (API), GPT-5.6 Sol/Luna/Terra
  (Codex subscription), and Claude Opus 4.8 (Claude subscription). Each agent
  describes its strengths, limitations, and best-use scenarios.
- Enhanced subagent budget routing policy with explicit model names and
  Qwen's unlimited-token advantage for large-output operations.
- Updated project README with model comparison table, cloud subscription
  availability notes, and current model tier descriptions.

## 1.5.30 - 2026-07-20

- Prevented DeepSeek and local models from accidentally multiplying terminal
  tabs when they pass small sync `run_in_terminal.timeout` values as seconds:
  suspicious values from 1 through 999 are now repaired to milliseconds before native
  VS Code tool execution.
- Strengthened terminal tool guidance to reuse the persistent sync shell, keep
  at most one background terminal, reserve async mode for indefinite services,
  and continue an existing background job by terminal id.
- Added regression coverage for timeout repair, intentional millisecond/zero/
  async timeouts, and the model-visible terminal reuse contract.

## 1.5.29 - 2026-07-19

- Added a cost-tiered subagent budget routing policy to the model-visible
  `runSubagent` guidance: prefer the cheapest capable tier (local for
  narrow/verifiable subtasks, DeepSeek for focused reasoning) and escalate to
  Codex/Claude subscription models only for work the cheaper tiers cannot do.
- Disabled implicit subagent model inheritance: `runSubagent.model` is now
  mandatory and must be one of the catalog models, preventing Copilot
  built-in or free-tier models from being selected for subagents.
- Added regression coverage for tier ordering, single-tier omission, and the
  mandatory-selection policy across the subagent and Codex guidance tests.

## 1.5.28 - 2026-07-19

- Fixed the `Native VS Code tool delegation is unavailable` race by queuing
  Codex tool calls that arrive between a delegated boundary and the next
  tool-result resume, then exposing them in a fresh native VS Code tool card.
- Added explicit queued/unavailable bridge diagnostics and regression coverage
  for late sequential tool calls without weakening the VS Code-only boundary.
- Moved Claude availability refreshes off the critical path for Local, Qwen,
  DeepSeek, and Codex requests while preserving Claude's own live preflight.
- Removed confirmed dead fields, exports, redundant routing checks, and a stale
  lock-file backup; the strict unused-symbol audit now passes cleanly.
- Updated the public documentation for Claude support, native-only actions,
  warm session reuse, and the distinction between current-prompt cache coverage
  and previous-prefix retention.

## 1.5.27 - 2026-07-19

- Made native VS Code tool delegation mandatory for Codex, matching the
  existing Claude SDK boundary; legacy Codex sandbox, approval, and tool
  opt-out settings no longer expose an alternate execution path.
- Disabled Codex built-in shell, web, MCP, browser, computer-use, image,
  plugin, hook, and subagent capabilities at thread startup while forcing a
  read-only sandbox and declining every internal permission request.
- Added a fail-closed turn guard that interrupts and rejects any unexpected
  internal Codex action before it can be presented as normal model progress.

## 1.5.26 - 2026-07-19

- Stabilized local and DeepSeek prompt prefixes by canonicalizing tool order,
  JSON schemas, tool arguments, and fallback tool-call identifiers.
- Removed volatile subscription availability and reset details from the
  model-visible `runSubagent` tool description while retaining routing policy.
- Added privacy-preserving cache-prefix fingerprints and prefix-continuity
  diagnostics to request logs without recording prompt contents.
- Added uncached-input totals and zero-cache-read counts to persistent Token
  Usage and Usage Experiment summaries.

## 1.5.25 - 2026-07-19

- Added persistent baseline/delegated usage experiments with Codex-only savings,
  separate child-provider and per-model totals, matched task labels, and
  Markdown/JSON report export from Quick Access.
- Recorded experiment samples from the existing completed-usage events for
  Local/Qwen, DeepSeek, Codex, and Claude without adding a second completion
  path or counting live snapshots.
- Corrected subagent routing guidance: `agentName` selects behavior while the
  optional exact `runSubagent.model` picker label switches model/provider.
- Raised Codex post-tool reconciliation idle tolerance from 30 seconds to
  three minutes so high-effort reasoning is not mistaken for a stalled turn.
- Added one bounded same-thread recovery for genuinely stale tool turns,
  preserving the Codex thread and prompt cache instead of triggering
  Copilot's full-history retry.
- Added terminal and reconciliation diagnostics with the last observed thread
  status, while keeping permanent input, authorization, and rate-limit errors
  non-retryable.

## 1.4.12 - 2026-07-18

- Added an explicit cross-extension conversation contract: Copilot patch v7
  forwards its stable conversation id through `modelOptions`, allowing the
  provider to identify a completed thread even when Copilot rewrites rendered
  service and tool history between user turns.
- Kept reuse fail-closed by requiring the exact prior visible assistant answer,
  an advancing Copilot turn index, matching runtime settings, and a safe
  intersection of the original and current tool catalogs.
- Added privacy-preserving diagnostics for conversation-id availability and
  matching, plus regressions for unstable rendered history and regenerated
  answers.

## 1.4.11 - 2026-07-18

- Removed the mutable VS Code tool catalog from the completed-thread runtime
  fingerprint after a measured `90 -> 93` tool change forced another 600K
  character full-history request.
- Preserved the original app-server thread catalog and namespace routes while
  exposing only the safe intersection with tools advertised by the current
  Copilot request. Newly added, removed, re-namespaced, or schema-changed tools
  cannot be delegated through the reused thread.
- Added separate catalog fingerprints and reuse telemetry for original,
  current, and callable tool counts.

## 1.4.10 - 2026-07-18

- Fixed the measured `history-suffix-changed` follow-up miss by canonicalizing
  recent semantic user history separately from Copilot's mutable tool-call and
  tool-result plumbing.
- Kept the exact prior visible-answer check and now requires the complete
  bounded suffix of recent user messages to match, so edited requests still
  force a safe cold thread.
- Renamed reuse diagnostics to report matched semantic user messages and the
  precise `user-history-suffix-changed` miss reason.

## 1.4.9 - 2026-07-18

- Added an initial completed-thread fallback for histories that are not
  byte-identical between user turns while retaining exact answer validation.
- Added body-free Codex thread-reuse diagnostics with categorized model,
  runtime, process, answer, and history mismatch reasons.
- Kept an active Codex turn alive when VS Code changes its advertised tool
  catalog between a native tool call and its result, preventing a redundant
  full-history thread restart.
- Moved the outer `apply_patch` and `view_image` tools into the non-deferred
  `vscode_native` namespace so they no longer collide with Codex built-ins and
  remain available through native Copilot tool cards.
- Added regression coverage for catalog changes and namespaced built-in
  collisions, plus a no-inference protocol smoke test with both namespaces.

## 1.4.8 - 2026-07-18

- Fixed Codex thread startup by placing deferred dynamic tools inside the
  required `vscode_deferred` namespace instead of marking flat functions as
  deferred.
- Validated namespaced tool routing in the provider and added a no-inference
  protocol smoke test against the bundled Codex CLI 0.144.5 `thread/start`.

## 1.4.7 - 2026-07-18

- Batched parallel Codex dynamic-tool requests into one native Copilot tool
  round and returned all matching results to the still-active app-server turn.
- Added fail-safe cleanup for incomplete parallel results, abandoned tools, and
  app-server exits so suspended turns cannot remain alive indefinitely.
- Isolated JSONL buffers and delayed server responses by app-server process
  generation, preventing stale output from a restarted process from affecting
  the new connection.
- Cached validated ChatGPT account state for five minutes, throttled background
  subscription status refreshes, and cached the model catalog for 30 seconds to
  remove repeated control-plane RPCs from native tool loops.
- Stopped resending images from old conversation messages already omitted by
  the bounded Codex input serializer.
- Deferred non-core schemas through the Codex runtime's built-in tool search,
  keeping the full 95-tool Copilot catalog available without placing every
  schema in each model prompt.
- Verified the integration against TypeScript protocol bindings generated by
  the bundled Codex CLI 0.144.5 and expanded regression coverage to 144 tests.

## 1.4.6 - 2026-07-18

- Kept the original app-server turn alive while Copilot renders and executes
  native tool cards, returning results to the pending dynamic-tool request
  without interrupting or starting another model turn.
- Preserved text, JSON, and image tool results in the bridge while applying the
  configured per-result bound before they re-enter model context.
- Extended ephemeral Codex thread reuse across normal follow-up user turns, not
  only native tool-result rounds, so unchanged chats send incremental input.
- Added SHA-256 conversation-lineage validation plus model, workspace, sandbox,
  approval, tool-catalog, and app-server generation checks before any reuse.
- Added bounded four-hour in-memory conversation caching with safe fallback to
  a fresh full-history thread after edits, model changes, restarts, or misses.
- Added thread-reuse and last prompt-cache diagnostics to Codex Quick Access
  status, plus input-mode and tool-schema-size request logging.
- Tuned Codex instructions to batch independent reads and searches and avoid
  excessive todo updates, reducing unnecessary model/tool round trips.
- Added a 30-minute abandoned-tool guard that releases pending app-server turns
  without leaving extension or server state alive indefinitely.

## 1.4.5 - 2026-07-18

- Reused the active ephemeral Codex thread after native Copilot tool calls
  instead of creating a new thread and resending the full chat history.
- Sent only the matching native tool-result tail on continuation rounds,
  preserving prompt-cache locality and sharply reducing repeated input usage.
- Added bounded, expiring continuation state keyed by native tool call id so
  separate chats cannot accidentally share Codex runtime state.
- Added request diagnostics for reused threads and regression coverage ensuring
  large earlier histories are excluded from continuation payloads.

## 1.4.4 - 2026-07-18

- Reworked Codex dynamic tools to emit native `LanguageModelToolCallPart`
  responses and delegate execution to the standard Copilot agent tool loop.
- Restored native command, search, file, web, and memory tool cards instead of
  rendering their lifecycle inside one continuous thinking block.
- Made delegated tools inherit Copilot session permission behavior, including
  `Bypass Approvals` and terminal auto-approval rules.
- Automatically declined internal Codex command/file permission requests while
  native delegation is active, preventing duplicate extension-owned prompts.
- Exposed private caller tools such as the native terminal tool to Codex without
  trying to invoke them through the narrower `vscode.lm.tools` registry.

## 1.4.3 - 2026-07-18

- Bridged compatible Copilot tools into Codex through the app-server
  `dynamicTools` protocol and `vscode.lm.invokeTool`.
- Added a `vscode_terminal` dynamic tool that runs commands in a visible VS Code
  integrated terminal, captures output, and respects the Codex approval policy.
- Added `llamacpp.codexUseVsCodeTools` plus a Quick Access toggle and dynamic
  tool invocation diagnostics.
- Bounded individual historical tool results before whole-message omission so
  long chats retain substantially more user and assistant conversation context.
- Added `llamacpp.codexMaxToolResultChars` and regression coverage for the tool
  bridge, output bounds, and conversation preservation.

## 1.4.2 - 2026-07-18

- Prevented long Copilot Chat histories from exceeding the Codex app-server
  hard limit of 1048576 input characters.
- Added bounded conversation serialization that preserves the first and newest
  messages, omits stale middle history, and truncates the newest request only
  when it cannot otherwise fit.
- Added `llamacpp.codexMaxInputChars` with a conservative 600000-character
  default and request-size diagnostics in `codex.chat.start` logs.
- Added regression coverage for oversized Codex conversations.

## 1.4.1 - 2026-07-18

- Fixed Codex models not appearing in the Copilot Chat model picker even when
  subscription status was connected.
- Combined Local, DeepSeek, and `codex::` models under the existing `llamacpp`
  provider vendor because Copilot did not query the separately contributed
  Codex vendor.
- Added regression coverage for combined discovery and transport routing.

## 1.4.0 - 2026-07-18

- Added a separate Codex Subscription language-model provider backed by the
  official local `codex app-server` and ChatGPT-managed OAuth.
- Added dynamic Codex model discovery, model-specific native Thinking Effort
  choices, image input, token usage forwarding, cancellation, and streamed
  reasoning summaries.
- Added guarded workspace command, file-change, and permission approvals while
  keeping OAuth credentials inside the official Codex runtime.
- Added Codex commands and Quick Access controls for sign-in, sign-out, account
  status, subscription usage, and source enablement without changing local or
  DeepSeek endpoints.
- Added Codex architecture and security documentation plus protocol, model,
  reasoning, usage, and conversation-adapter regression tests.

## 1.3.0 - 2026-07-17

- Added deterministic tool-call repair, advertised-schema validation, bounded
  correction retry, and repeated identical-call loop protection.
- Upgraded shared memory to format v2 with global/workspace/model scopes,
  typed entries, source provenance, verification time, expiry, and hybrid
  exact/fuzzy retrieval. Version-one files migrate automatically.
- Added a read-only provider health check for discovery, runtime context,
  tokenizer support, prompt-cache settings, reliability controls, and retired
  DeepSeek aliases.
- Added privacy-preserving Markdown/JSON session quality reports for cache hit
  rate, latency, throughput, compaction, overflow recovery, and tool-call
  reliability.
- Added the new diagnostics to Quick Access and expanded regression coverage
  across streaming, correction retries, memory migration, and reporting.

## 1.2.0 - 2026-07-17

- Added adaptive and strict knowledge-verification modes for source-backed,
  version-aware technical work with local models and DeepSeek.
- Added a cache-stable custom system prompt and kept retrieved memory near the
  mutable end of the request.
- Added primary-source and pinned-revision guidance to web and GitHub tools
  without prompt-dependent tool-catalog churn.
- Exposed knowledge verification in Quick Access and documented a repeatable
  before/after audit workflow.

## 1.1.6 - 2026-07-17

- Disabled Copilot Agent's automatic LLM summarization for local provider
  sessions while preserving the explicit Compact Conversation command.
- Let the provider receive raw host history before enforcing its own exact
  token budget, tool-result sanitization, and deterministic compaction.

## 1.1.5 - 2026-07-17

- Prevented Copilot from reserving its complete raw VS Code tool catalog before
  the local provider applies bounded API Direct tool selection.
- Stopped the resulting early foreground summary and immediate follow-up
  summary loop observed around 41K tokens on a 131K Qwen context.

## 1.1.4 - 2026-07-17

- Prevented Copilot's smaller global summarization threshold from triggering a
  foreground LLM compaction well before a local model's advertised context
  limit.
- Upgraded the guarded Copilot bundle patch to v4 while preserving emergency
  foreground recovery at the real prompt limit.

## 1.1.3 - 2026-07-17

- Prevented Copilot Chat from starting background LLM compaction early for
  extension-contributed local models.
- Made the guarded Copilot patch use the provider's complete context window and
  ignore stale smaller session context overrides for `llamacpp`.
- Added a fast service profile for unavoidable Copilot summaries: no reasoning,
  no memory injection or prompt caching, and a configurable 2048-token cap.
- Added regression coverage for native Copilot compaction prompt detection.

## 1.0.1 - 2026-07-16

- Increased the default local High/Deep reasoning cap from 8192 to 16384
  tokens for complex Qwen coding and agent tasks.
- Kept Light and Balanced at 512 and 2048 tokens.
- Prevented DeepSeek setup from overwriting the local numeric reasoning cap.

## 1.0.0 - 2026-07-16

- Established the independent MrLordCat extension and release workflow.
- Added simultaneous local OpenAI-compatible and DeepSeek model sources.
- Added durable shared memory and native Agent tools.
- Added context budgeting, deterministic compaction, exact usage forwarding,
  prompt-cache diagnostics, and optional native Copilot controls.
- Separated normal output defaults from the global hard ceiling.
- Added llama.cpp-native thinking controls and clarified reasoning semantics.
- Bounded API Direct tool definitions by priority, count, and token cost.
- Extracted source routing, context, request, transport, and UI modules.
- Added CI, tag-based GitHub releases, pinned packaging tools, and 79 tests.
