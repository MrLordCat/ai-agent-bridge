# Changelog

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
