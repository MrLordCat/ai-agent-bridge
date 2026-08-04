# Changelog

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
