# Architecture

## Scope

This extension exposes OpenAI-compatible local models, DeepSeek, Codex, and
Claude subscriptions through one VS Code language model provider. Stable
compatibility ids remain under the `llamacpp` namespace even though each source
uses an independent transport and lifecycle.

## Runtime Components

- `src/extension.ts` is the composition root. It creates services and registers
  the provider, commands, status items, UI providers, and memory tools.
- `src/composite-provider.ts` combines the Local/DeepSeek, Codex, and Claude
  catalogs and routes source-prefixed model ids without blocking one provider
  on another provider's health probes.
- `src/llama-provider.ts` coordinates model discovery, request attempts,
  compatibility retries, streaming, and metrics.
- `src/base-provider.ts` owns provider-independent token estimation and SSE
  streaming/tool-call parsing.
- `src/utils.ts` converts VS Code messages and tools to OpenAI-compatible
  payloads and validates tool-call history.
- `src/logger.ts` writes structured JSONL diagnostics without message bodies or
  authorization headers.
- `src/codex/` owns ChatGPT subscription discovery, `codex app-server` JSONL,
  thread reuse, dynamic VS Code tools, the fail-closed native tool bridge, and
  exact rollout/live model-segment metrics.
- `src/claude/` owns Claude Code discovery, persistent Agent SDK queries,
  subscription limits, warm conversation reuse, a VS Code-only MCP allowlist,
  and live logical-turn usage/context/tool metrics.
- `src/provider-metrics.ts`, `src/token-usage-history.ts`, and
  `src/usage-experiment.ts` normalize provider telemetry and persist bounded
  comparison data without prompt bodies.
- `src/subagent-guidance.ts` adds stable provider/model routing guidance to the
  outer Copilot subagent tool without changing its execution boundary.
- `src/memory/` owns durable shared memory, retrieval, prompt injection, and
  VS Code language model tools.
- `src/tools/tool-call-reliability.ts` owns deterministic tool argument repair,
  schema validation, metrics, and repeated identical-call detection.
- `src/diagnostics/` owns provider health reports and session-quality
  aggregation. Running turns are upserted by request id so provider re-entry
  after a native tool result does not create duplicate logical turns.
- `src/context/context-budget.ts` owns pure soft/hard input budgets and context
  usage estimates shared by initial requests and overflow retries.
- `src/context/output-budget.ts` separates normal per-source output defaults
  from explicit request limits and the global hard ceiling.
- `src/context/message-compaction.ts` owns deterministic non-mutating history
  compaction with bounded structured summaries of old tool activity.
- `src/context/server-token-counter.ts` owns llama.cpp chat-template application,
  exact tokenization, short-lived count caching, and unsupported-server fallback.
- `src/context/system-prompt.ts` owns the stable knowledge-verification policy,
  custom system instructions, and non-mutating prompt-prefix injection.
- `src/context/tool-result-summary.ts` extracts bounded, non-secret structural
  facts shared by live tool-result truncation and history compaction.
- `src/context/usage.ts` validates upstream token counters and builds the
  fallback statistics forwarded to native Copilot Session Info.
- `src/reasoning.ts` maps VS Code session effort values to local and DeepSeek
  request profiles and supplies the native model configuration schema.
- `src/request/chat-request.ts` builds source-specific OpenAI-compatible request
  bodies without transport or VS Code dependencies.
- `src/model-sources/source-routing.ts` owns source ids, URL deduplication,
  source construction, and model-family routing.
- `src/transport/openai-http.ts` owns endpoint resolution, timeouts,
  cancellation, and serialized HTTP requests.
- `src/transport/request-queue.ts` owns serial request admission, FIFO waiting,
  cancellation, queue timeouts, and idempotent slot release.
- `src/ui/quick-access.ts` owns the grouped Quick Access tree, compact endpoint
  labels, native icons, and live state summaries.
- `src/ui/session-quality-panel.ts` owns the live, state-preserving diagnostics
  webview with filters, issue highlighting, expandable turn details, usage
  segments, and Codex model/tool step timelines.
- `src/ui/model-behavior-commands.ts` owns reasoning and tool-mode pickers and
  command handlers.
- `src/constants.ts` contains shared product, provider, endpoint, and limit
  constants.
- `scripts/patch-copilot-chat.mjs` is an opt-in external patcher for Copilot's
  extension-model wrapper. It is development/release tooling, not runtime
  extension code.

`src/vscode.d.ts` is a checked-in VS Code API declaration used for the language
model provider surface. Update it explicitly with `npm run update-vscode-api`.

## Request Flow

1. VS Code asks the composite provider for available models.
2. Local/DeepSeek discovery, Codex app-server discovery, and Claude Agent SDK
  discovery run independently; fulfilled catalogs are merged and sorted.
3. For a chat turn, the source-prefixed model id selects exactly one provider.
  Local and DeepSeek requests follow the OpenAI-compatible flow below; Codex
  and Claude retain their own warm runtime state. Completed subscription
  sessions can be restored from provider-owned durable transcripts after an
  Extension Host restart.
4. A session-scoped native reasoning selection overrides the global mode when
   Copilot supplies it through `modelOptions`.
5. VS Code messages and tools are converted to OpenAI format.
6. The stable provider knowledge policy is prepended to native system instructions.
7. Relevant non-expired memory for the active workspace/model scope is inserted
   immediately before the latest user turn, preserving the stable cached prefix.
8. Tool results are sanitized/summarized and the complete local prompt is
   counted with the active server template and tokenizer when available.
9. The serial transport queue grants the request slot.
10. The pure request builder applies local or DeepSeek fields, then the request
   is sent to the source-specific chat completion endpoint.
11. SSE chunks are coalesced; tool calls are repaired conservatively and
   validated against the advertised schema before they are emitted to VS Code.
12. A rejected tool call can trigger one bounded correction request when no
   visible output or executable tool call has escaped the failed stream.
13. The final upstream usage chunk is validated and emitted as native `usage`
   response data, with an estimate used only when the server omits it.
14. Transient transport failures can retry only before streaming starts;
   context overflow, tool-role incompatibility, or empty output use separate
   bounded recovery paths.

### Codex subscription flow

1. The user selects a discovered `codex::` model and reasoning effort in the
  normal VS Code model picker; there is no separate chat participant.
2. A strict app-server thread starts in read-only mode with built-in shell,
  file, web, MCP, browser, plugin, hook, image, and subagent actions disabled.
3. The current VS Code/Copilot tool catalog is canonicalized and advertised as
  app-server dynamic tools. Core coding tools stay eager; uncommon schemas can
  be loaded through the app-server tool-search mechanism.
4. Tool calls are emitted as native VS Code cards and the app-server turn is
  suspended until their results return. VS Code may re-enter the provider with
  a tool result, but the same app-server turn resumes instead of starting a new
  model request or serializing a continuation prompt.
5. Calls arriving after a delegated boundary are queued and exposed in the
  next native segment; only already visible calls require results on resume.
6. Completed compatible threads reuse an exact conversation anchor and send
  only incremental input. Non-ephemeral thread ids and validation fingerprints
  are stored in workspace state, reattached with `thread/resume` after reload,
  and fall back to a new full-history thread when reattachment fails.
7. App-server token notifications and persisted rollout data feed one running
  Session Quality record. Model usage segments and tool-step state update live;
  final rollout metrics replace the fallback snapshot when available.

### Claude subscription flow

1. The official Agent SDK starts with built-in tools, plugins, skills, and
  external MCP configuration disabled.
2. Copilot tools are hosted by one SDK MCP server; `canUseTool` allows only its
  `mcp__vscode__*` names.
3. Matching conversations reuse warm sessions. Native tool results resume the
  suspended SDK query rather than constructing a second request history.
4. Completed sessions use the Agent SDK transcript store. A stable Copilot
  conversation id, model/runtime fingerprint, and user-history prefix select a
  resumable session after reload; an invalid resume safely retries from full
  VS Code history before visible output is emitted.
5. Subscription and model-context probes refresh periodically; probes for
  Claude availability never block Local, DeepSeek, or Codex requests.
6. One stable logical-turn id spans assistant model segments and all native
  tool-result provider re-entry. Stream events, assistant usage, aggregate
  result usage, MCP tool duration, terminal status, and `getContextUsage()`
  snapshots upsert the same Session Quality record.
7. Anthropic fresh input, cache read, and cache creation remain distinct. The
  report does not misclassify cache creation as either a hit or ordinary fresh
  input, and it retains thinking tokens per assistant model segment.

### Reload and tool-catalog stability

Closing VS Code necessarily restarts Copilot Chat, Extension Host processes,
and subscription-provider subprocesses. The extension cannot skip VS Code's
physical tool registration, but it prevents that registration from becoming a
semantic cold start:

- the guarded Copilot integration forwards a stable conversation identity;
- Local and DeepSeek canonicalize tool order and JSON Schema keys so the exact
  server-side prompt-cache prefix survives a reload;
- Codex canonicalizes dynamic tools and reattaches a durable app-server thread;
- Claude canonicalizes its MCP tool catalog and resumes a persisted SDK session.

Changing the model, workspace, reasoning effort, or effective tool schema still
invalidates the relevant session intentionally. Reload during an unfinished
native tool call also uses the full-history fallback because JavaScript promise
state cannot survive process termination.

## Persistent Data

- API keys: VS Code `SecretStorage`.
- Shared memory: `<globalStorage>/memory/shared-memory.json`.
- Diagnostics: `<globalStorage>/logs/*.jsonl`.
- Generated reports: `<globalStorage>/reports/*.{md,json}`.
- Token usage and comparison experiments: bounded JSON under `<globalStorage>`.
- Provider resume mappings: bounded ids, hashes, and history anchors in VS Code
  workspace state. Claude message transcripts remain in the official Agent SDK
  session store; Codex transcripts remain in the Codex app-server store.
- User configuration: `llamacpp.*` VS Code settings.

DeepSeek has a dedicated `llamacpp.deepSeekApiKey` secret. The generic primary
server key remains `llamacpp.apiKey`; a legacy fallback keeps older installs
working.

## Invariants

- Source prefixes are never sent as model ids to upstream servers.
- Codex and Claude cannot execute actions outside native VS Code tool cards.
- A selected Codex model uses the contributed model-provider path; no secondary
  participant or hidden execution surface may be introduced for the same flow.
- A detached Codex bridge may queue only calls belonging to an already pending
  native tool turn; an unrelated detached call is rejected and logged.
- DeepSeek-only fields and llama.cpp-only fields stay source-specific.
- Memory and tool schemas count against the same request budget as messages.
- Exact server counts include the active chat template and tool catalog; the
  heuristic remains mandatory for OpenAI-compatible servers without tokenizer
  endpoints.
- Memory content is reference data and cannot override current system/user
  instructions.
- Externally verified memory requires source provenance and verification time;
  expired memory is excluded from automatic retrieval.
- Tool calls are never repaired by inventing values or changing argument types.
- Knowledge policy and custom durable instructions stay before mutable history;
  source-aware tool descriptions remain stable across turns for cache reuse.
- Logs may contain counts, timings, model ids, and tool names, but not API keys
  or raw message bodies.
- Changes to conversion, compaction, streaming, routing, or memory require tests.

## Remaining Boundaries

The OpenAI-compatible provider intentionally remains the largest lifecycle
coordinator because streaming retries share turn-local state. Codex and Claude
are isolated behind their runtime clients. Further extraction should be driven
by a smaller stable interface or measured contention, not line count alone.
