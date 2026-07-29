# Release Audit - Version 1.9.0

## Scope

This audit describes the stable release that contributes local
OpenAI-compatible, DeepSeek, ChatGPT-backed Codex, and Claude Agent SDK models
to the native VS Code Chat model picker. It covers provider boundaries, native
tool execution, durable sessions, cache/context behavior, diagnostics,
documentation, packaging, and release reproducibility.

## Confirmed Product Boundaries

- The extension contributes language models; it does not replace the Copilot
  endpoint globally and does not add a separate Codex chat participant.
- Local and DeepSeek use source-specific OpenAI-compatible HTTP transports.
- Codex uses the official local `codex app-server` with a validated ChatGPT
  account. API-key and Bedrock account modes are rejected by this provider.
- Claude uses the official Agent SDK and only the native VS Code MCP namespace.
- Codex and Claude internal shell, file, web, browser, plugin, skill, image,
  hook, and subagent action paths are disabled or denied. Executable work must
  return through visible VS Code tool cards and the active approval policy.
- The extension never reads Codex or Claude credential files. DeepSeek and
  generic HTTP credentials use independent VS Code SecretStorage entries.

## Provider And Session Correctness

- Source-prefixed model ids route to exactly one provider and are never sent
  upstream as part of the real model id.
- Codex dynamic tools preserve one app-server turn across VS Code provider
  re-entry. Tool results resolve the matching pending call; they do not start a
  second model turn or replay the full transcript.
- Completed Codex threads and Claude sessions can be reattached after reload
  when model, workspace, conversation, runtime, and tool fingerprints remain
  compatible. Invalid or stale state falls back safely.
- Tool-catalog drift is intersected against the catalog captured when a thread
  started. Newly added or schema-changed tools wait for a fresh thread.
- Local and DeepSeek tool calls receive bounded repair, schema validation, and
  identical-call loop detection before VS Code can execute them.

## Context, Cache, And Usage

- Local prompt counting uses the server chat template and tokenizer when
  available and falls back to a conservative estimate when unsupported.
- Local and DeepSeek requests canonicalize tool/schema order, keep stable
  instructions ahead of mutable history, and compact deterministically near
  provider-owned input targets.
- Codex and Claude durable sessions avoid full-history replay when a validated
  continuation exists.
- Upstream usage counters are normalized without treating cumulative Codex
  thread totals as current-turn billing.
- Codex retains exact or live-fallback model usage segments, cache ratios,
  reasoning tokens, tool names, tool durations, and first-event latency.
- A blocked internal Codex action is interrupted fail-closed, then recovered on
  the same app-server thread with a native-tool-only reminder. Cold startup cost
  and final continuation health are classified independently.
- Claude retains exact fresh/cache-read/cache-creation input, output and
  thinking segments, Agent SDK session mode, native tool duration, terminal
  lifecycle, and asynchronous SDK context categories.
- Claude emits the final assistant segment through native Copilot Session Info
  while retaining aggregate multi-segment usage in Live Report, preventing
  processed billing totals from being misread as current context occupancy.

## Diagnostics And Privacy

- Provider Health performs read-only model/runtime/configuration checks and
  writes Markdown/JSON reports.
- Session Quality is a live, filterable webview with per-model cache health,
  context and compaction details, usage segments, tool reliability, and an
  ordered Codex and Claude model/tool step timelines.
- Running Codex and Claude snapshots are upserted by stable request id; final
  metrics replace the provisional record instead of adding duplicate logical
  turns across native tool-result provider re-entry.
- Matched baseline/delegated Usage Experiments persist bounded usage samples
  and export comparisons without prompt bodies.
- Structured logs and reports may contain model ids, request ids, tool names,
  counts, and timings, but not authorization headers, API keys, prompts, or
  tool-result bodies.

## Guarded Copilot Integration

Patch v16 supplies controls not currently exposed by the stable provider API:
native effort selection, provider output/context handling, stable conversation
identity, deterministic tool signatures, bounded persisted tool payloads, and
provider-owned compaction. It validates unique bundle anchors, syntax, and
hashes; stores exact backups; and refuses unknown bundle shapes instead of
applying a broad replacement.

The patch remains an explicit compatibility risk because it targets private
bundled code. Every VS Code/Copilot update requires revalidation, and the
original bundle can be restored from the command palette.

## Release Gates

The stable 1.9.0 release must pass all of the following before its tag is
published:

- `npm run compile`;
- `npm run lint`;
- the complete VS Code extension-host test suite (279 tests in this release);
- `git diff --check`;
- `npm run package` and inspection of the generated VSIX;
- forced installation with `code --install-extension ... --force`;
- a window reload followed by a real model-picker Codex smoke turn that uses at
  least one native VS Code tool and reaches a completed final response;
- a real model-picker Claude smoke turn with at least one native VS Code tool,
  one completed logical row, cache read/write segmentation, and a terminal SDK
  context snapshot.

A local VSIX build and installation do not constitute a release. The reviewed
commit, annotated tag, and GitHub Actions publication remain separate and
require a clean tree. `scripts/stable-release.sh` enforces the clean-tree,
package, branch, and tag publication gate.

## Residual Risks

- Tool availability depends on VS Code/Copilot versions, workspace trust and
  policy, installed extensions, enabled MCP servers/connectors, and account
  entitlements. Authentication to one surface does not grant another.
- Token estimation remains approximate when an OpenAI-compatible server omits
  tokenizer endpoints and authoritative usage.
- Deterministic compaction is intentionally lossy, although it preserves
  complete tool turns and bounded code/decision milestones.
- Prompt-cache reuse depends on exact prefix stability and server slot policy;
  unrelated chats can still evict a useful local cache.
- An unfinished native tool promise cannot survive Extension Host termination;
  reload during that boundary uses the validated fallback path.
- `src/llama-provider.ts` remains the largest lifecycle coordinator because
  retry, streaming, and metrics share turn-local state. Further extraction
  should follow a measured stable boundary, not line count alone.

## Release Decision

Version 1.9.0 is the stable baseline approved after the 1.8.x hardening cycle,
the checks above, and real post-reload Codex and Claude smoke evidence. Future
development resumes as patch releases from this tagged source state.
