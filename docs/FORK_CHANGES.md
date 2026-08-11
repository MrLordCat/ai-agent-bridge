# AI Agent Bridge — Fork Changes

## Product Direction

This repository is an independent continuation of the original llama.cpp chat
provider. Its goal is one efficient native VS Code agent integration for local
OpenAI-compatible servers, DeepSeek, Codex, and Claude without replacing the
editor's global Copilot endpoint.

Compatibility identifiers remain under `llamacpp.*` so existing settings,
commands, and model selections continue to work. User-facing ownership,
repository metadata, documentation, and release artifacts belong to the fork.

## Major Changes

### Multiple Model Sources

- Local and DeepSeek models are discovered and advertised at the same time.
- Source-prefixed internal ids route each request to the correct endpoint and
  are removed before the upstream API call.
- Local and DeepSeek API keys are stored separately in VS Code SecretStorage.
- Local runtime context is detected from server metadata with configurable
  fallbacks.

### Direct API Profiles

- Requests go directly from the extension to the selected OpenAI-compatible
  endpoint; there is no intermediate model proxy.
- llama.cpp receives compatible prompt-cache, reasoning, sampling, and tool
  fields.
- Normal local and DeepSeek output defaults are separate from the global hard
  ceiling, avoiding oversized reservation on ordinary turns.
- DeepSeek receives its own thinking and reasoning profile and never receives
  llama.cpp-only `cache_prompt`.
- Tool-result and tool-call compatibility retries are bounded and logged.
- Tool calls are repaired only for deterministic syntax/name issues, validated
  against the advertised schema, and rejected before execution when unsafe.
- Consecutive identical tool calls are detected from history and receive a
  bounded loop-breaking instruction.

### Context And Long Conversations

- Soft and hard context budgets account for messages, tool schemas, and reply
  reserve.
- Old history is compacted before overflow; one stricter retry is available
  when the server still rejects the request.
- Large tool results can be sanitized, summarized, and capped before they
  consume the context window.
- Exact streamed token usage is forwarded to Copilot Session Info when the
  server provides it; a local estimate is used otherwise.
- Local preflight budgeting uses llama.cpp's real chat template and tokenizer,
  with cached fallback-safe `/apply-template` and `/tokenize` requests.
- Compaction retains bounded tool names, safe arguments, paths, statuses,
  diagnostics, and JSON structure instead of dropping old tool results entirely.
- Compaction keeps complete user turns, preserves code/decision milestones, and
  records its own duration separately from exact tokenizer preflight latency.
- llama.cpp and DeepSeek cache-hit counters are normalized and shown in Quick
  Access diagnostics.

### Reasoning And Streaming

- Native reasoning fields and `<think>` blocks are separated from visible
  answer text.
- Qwen 3.6 can preserve historical reasoning across multi-step tool turns, and
  effective reasoning kwargs are included in sanitized request diagnostics.
- Small text chunks are coalesced to reduce UI update pressure during long
  answers; progressively longer answers use a lower render cadence.
- Cancelling a turn actively cancels the response body so an abandoned
  generation cannot keep the only local server slot busy after VS Code has
  released its request queue lease.
- Empty output and repeated tool-only turns have bounded recovery paths.
- Network failures and HTTP 429/502/503/504 responses have cancellation-aware
  pre-stream exponential backoff; timeouts and arbitrary client errors do not.
- An optional Copilot Chat patch exposes native Thinking Effort and the real
  model output limit. See [Copilot Chat Integration](COPILOT_PATCH.md).

### Shared Memory

- Durable memory is stored once in extension global storage and is shared by
  local models, DeepSeek, workspaces, and chats in the same VS Code profile.
- Version-two entries support global, workspace, and model scopes; typed facts,
  source provenance, verification time, and expiry.
- Hybrid exact/fuzzy retrieval injects relevant non-expired entries near the
  latest user turn within a separate token budget, preserving the reusable
  prompt prefix.
- Agent tools can store, search, and delete entries with confirmation for
  mutating operations.
- The JSON store remains inspectable and editable by the user.

### Diagnostics And Quick Access

- Structured JSONL logs record routing, attempts, timings, context budgets,
  token usage source, retries, and tool names without API keys or raw prompts.
- Raw stream chunk logging is separately disabled by default because it is
  verbose and can expose model output.
- Quick Access groups model actions, endpoints, generation settings, memory,
  diagnostics, and live status instead of presenting one long flat list.
- Provider health reports probe model discovery, local runtime context, exact
  tokenization, cache configuration, and retired DeepSeek aliases.
- Session quality reports aggregate cache, latency, throughput, compaction,
  overflow, and tool reliability metrics without storing prompt bodies.

### Repository Cleanup

- Publisher and repository metadata now point to `MrLordCat`.
- Dead provider code, duplicate API declarations, runtime logs, and automatic
  postinstall downloads were removed.
- Context arithmetic, memory, reasoning, constants, and Quick Access were split
  into focused modules with tests.
- Architecture, audit, memory, Copilot integration, and fork behavior are now
  documented under `docs/`.

## Current Ownership Boundaries

| Area | Main code |
| --- | --- |
| Composition | `src/extension.ts` |
| Request lifecycle | `src/llama-provider.ts` |
| Source ids and routing | `src/model-sources/` |
| SSE, text, thinking, and tool parsing | `src/base-provider.ts` |
| Context budgets and native usage | `src/context/` |
| Local and DeepSeek request profiles | `src/request/` |
| Serial request admission | `src/transport/` |
| Shared memory | `src/memory/` |
| Tool-call reliability | `src/tools/` |
| Health and session reports | `src/diagnostics/` |
| Reasoning profiles | `src/reasoning.ts` |
| Quick Access and behavior commands | `src/ui/` |
| Copilot bundle patch tooling | `scripts/patch-copilot-chat.mjs` |

The completed 1.0 audit is tracked in [Project Audit](AUDIT.md), while
[Architecture](ARCHITECTURE.md) describes the runtime flow and invariants.
