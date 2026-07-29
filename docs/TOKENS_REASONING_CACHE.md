# Tokens, Reasoning, And Prompt Cache

## Three Independent Limits

The extension does not use one number for every purpose:

| Setting | Purpose | Recommended default |
| --- | --- | --- |
| `reasoningBudget` | Maximum hidden reasoning tokens for compatible local llama.cpp servers | 16384 |
| `localDefaultMaxOutputTokens` | Normal local `max_tokens` when the session supplies no explicit value | 32768 |
| `deepSeekDefaultMaxOutputTokens` | Normal DeepSeek `max_tokens` | 65536 |
| `maxOutputTokensCap` | Absolute ceiling applied after session, model, and source limits | 131072 local / 393216 DeepSeek maximum |

`max_tokens` covers the complete generated sequence. For a reasoning model that
means hidden reasoning plus the visible answer. A local request with a 16384
reasoning cap and `max_tokens=32768` can split the available generation space
evenly between hidden reasoning and the visible answer.

The provider reserves the resolved `max_tokens` while calculating available
input context. A large hard ceiling no longer becomes the default reservation.

## Copilot Conversation Compaction

There are two independent compaction layers:

- The provider performs deterministic message compaction near its exact local
  input target. It does not run inference.
- Copilot Chat can generate an LLM summary of its outer conversation history.

Patch v16 makes Copilot use the complete `maxInputTokens + maxOutputTokens`
window for this provider, ignores smaller stale session and global summary
threshold overrides, and avoids reserving Copilot's full raw tool catalog
before the provider selects its bounded subset. The temporary Agent renderer
is allowed to pass raw tool results through to the provider, where they are
sanitized, counted, and deterministically compacted. Copilot-owned automatic
summarization and truncation are disabled for `llamacpp`; the explicit Compact
Conversation command remains available. A stable conversation id and
deterministic tool signatures let durable subscription sessions survive
renderer history rewrites without weakening their validation rules.

## Thinking Mode Mapping

| Mode | Local llama.cpp | DeepSeek |
| --- | --- | --- |
| Off | thinking disabled, budget 0 | thinking disabled |
| Light | up to 512 hidden tokens | High effort |
| Balanced | up to 2048 hidden tokens | High effort |
| Deep | up to `reasoningBudget` | Max effort |
| Auto | up to `reasoningBudget` | High effort |

For local requests the extension sends:

```json
{
  "chat_template_kwargs": {
    "enable_thinking": true,
    "preserve_thinking": true
  },
  "thinking_budget_tokens": 16384
}
```

The maintained llama.cpp server translates `thinking_budget_tokens` into its
reasoning-budget sampler when the active template exposes thinking start/end
tags. Models or servers without that support may ignore the numeric cap. The
server-wide `--reasoning-budget` option remains the ultimate fallback.

`preserve_thinking` is enabled only for detected Qwen 3.6 models and can be
disabled with `llamacpp.preserveThinking`. Reasoning chunks are internally
tagged before being forwarded to VS Code, so diagnostics count them correctly
even when a host build uses a private or renamed ThinkingPart constructor.

DeepSeek receives `thinking.type` and `reasoning_effort`; it does not receive
llama.cpp's `cache_prompt` or numeric local reasoning budget.

## Exact Local Prompt Counts

With `llamacpp.accurateTokenCounting=true`, each distinct local prompt is sent
through llama.cpp `/apply-template` with its actual messages, tools, and Qwen
template kwargs, then through `/tokenize`. The short-lived result cache avoids
repeating this work during retries. These calls perform no inference.

When either endpoint is unavailable or exceeds `tokenizerTimeoutMs`, budgeting
falls back to the character estimate. `chat.tokens.count` and the Context Usage
tooltip report whether a turn used `server` or `heuristic` counting. DeepSeek
continues to use the fallback before generation and returns authoritative usage
after the response.

## Prompt Cache Behavior

llama.cpp reuses only the identical prefix of a prompt. The extension preserves
that prefix in several ways:

- `cache_prompt=true` is sent only to local sources.
- Tool definitions are priority-sorted, compacted, count-limited, and bounded
  by `apiDirectToolTokenBudget` so the catalog remains stable and affordable.
- Tool and JSON Schema key ordering is canonical across Local, DeepSeek, Codex,
  and Claude, so Copilot's post-reload enumeration order cannot change the
  provider prompt or runtime fingerprint by itself.
- Retrieved shared memory is inserted immediately before the latest user turn,
  rather than rewriting the first system message.
- Raw tool results are sanitized and capped before budgeting.
- Compaction copies messages, runs only near the configured soft target, and
  removes whole conversation turns instead of breaking tool-call/result pairs.
- Old assistant turns retain bounded code edges, decisions, paths, diagnostics,
  and next steps without an additional LLM request.

Compaction necessarily changes the prefix once because old turns are replaced
by a summary. Later turns can reuse that new compacted prefix. Switching models,
changing system instructions, changing tool catalogs, or alternating multiple
independent chats on a single llama.cpp slot can also lower cache reuse.

Local and DeepSeek remain stateless HTTP providers and must include tools in
each request, but an unchanged canonical prefix can still be served from the
upstream prompt cache. Codex and Claude additionally restore completed durable
sessions when `persistProviderSessions` is enabled. Process startup and VS Code
tool registration still occur after reload; full-history prefill does not.

`chat.messages.auto_compact`, `chat.messages.hard_compact`, and overflow retry
logs report `compactDurationMs`. Exact `/apply-template` + `/tokenize` preflight
latency is reported separately by `chat.tokens.count.durationMs`.

## Measuring Cache Reuse

The Diagnostics group shows the last server-reported Prompt Cache value. Logs
record the same data under `chat.response.usage.promptCache`:

```json
{
  "promptTokens": 12000,
  "cachedTokens": 10800,
  "uncachedTokens": 1200,
  "hitPercent": 90
}
```

llama.cpp reports standard `prompt_tokens_details.cached_tokens`. DeepSeek's
`prompt_cache_hit_tokens` is normalized to the same shape. `n/a` means the
server omitted cache counters, not necessarily that no cache was used.

Codex reports cumulative and current-request usage through app-server token
notifications. The extension records per-model-segment snapshots and computes
billing deltas without double-counting a reused durable thread. When a
persisted Codex rollout is available, exact segment/tool timing replaces the
live-notification fallback in the final Session Quality record. These provider
session counters are separate from local HTTP KV-cache reuse.

Claude reports fresh input, cache reads, and cache creation as separate Agent
SDK counters. Session Quality uses `cache read / (fresh + read + creation)` for
the hit percentage and displays creation independently because those tokens are
written for possible later reuse, not served from cache in the current model
segment. Assistant usage also exposes per-segment thinking tokens; the terminal
result supplies the authoritative aggregate and `getContextUsage()` adds the
post-turn SDK context categories.

## Recommended Profiles

Quality-oriented local coding:

```json
{
  "llamacpp.thinkingMode": "deep",
  "llamacpp.reasoningBudget": 16384,
  "llamacpp.preserveThinking": true,
  "llamacpp.localDefaultMaxOutputTokens": 32768,
  "llamacpp.accurateTokenCounting": true,
  "llamacpp.cachePrompt": true,
  "llamacpp.toolCallingMode": "apiDirect",
  "llamacpp.apiDirectMaxTools": 70,
  "llamacpp.apiDirectToolTokenBudget": 12000,
  "llamacpp.apiDirectIncludeAllTools": false
}
```

Faster local turns can use Balanced without changing the cap. DeepSeek quality
uses Deep, a 65536 normal output default, and retains 393216 only as the hard
ceiling for explicitly large requests.
