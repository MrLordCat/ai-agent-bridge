# Codex Subscription Provider

The extension can expose models from an existing ChatGPT/Codex subscription in
the VS Code and Copilot Chat model picker. This is a separate provider from the
local OpenAI-compatible and DeepSeek transports.

This is a model-provider integration, not a separate `@codex` participant.
Selecting a discovered Codex model in the normal picker, including a model with
the native `xhigh` effort option, is the intended entry point.

## What Subscription Access Means

ChatGPT subscription access is not an OpenAI API key. The extension launches
the official `codex app-server --stdio` process and uses its JSON-RPC surface.
Codex owns browser login, refresh tokens, model discovery, rate limits, and the
inner reasoning/tool-selection loop. Native command, search, file, web, memory,
MCP, and other registered actions remain owned by the outer VS Code Chat
session.

The extension never reads, copies, logs, or stores the contents of
`~/.codex/auth.json`. It validates `account/read` and requires
`account.type == "chatgpt"`, then keeps that validated state for at most five
minutes and invalidates it on logout or app-server restart. API-key and Bedrock
sessions are deliberately rejected by this provider so they cannot cause
unexpected metered API usage.

Official references:

- [Using Codex with a ChatGPT plan](https://help.openai.com/en/articles/11369540-using-codex-with-your-chatgpt-plan)
- [Codex app-server protocol](https://github.com/openai/codex/blob/main/codex-rs/app-server/README.md)

## Runtime Architecture

```text
Copilot Chat UI
  -> llamacpp composite LanguageModelChatProvider
     -> codex:: model routing
     -> local codex app-server over JSONL/stdin
        -> ChatGPT-managed Codex service
        -> dynamic tool selection
           -> LanguageModelToolCallPart
              -> native VS Code tool card and approval
              -> tool result resumes the same app-server turn
```

Copilot Chat owns the visible chat history. With `persistProviderSessions`
enabled, the first provider request creates a durable Codex thread and stores
only its id plus validation fingerprints in VS Code workspace state. Native
tool-result rounds reuse the live thread, while a completed matching thread can
be reattached after a VS Code reload and receive only the new user turn. If the
stored thread is missing or its conversation anchor no longer matches, the
provider safely starts a new thread with the current full VS Code history.
Before any paid `turn/start`, the provider verifies that app-server honored the
requested durable/ephemeral mode. Cross-process restoration uses the official
`thread/resume` operation; metadata-only `thread/read` is never treated as a
resume. Run `npm run test:codex-persistence` to validate this contract without
starting a model turn or consuming subscription quota.

Codex owns the inner agent loop. Through the app-server experimental
`dynamicTools` protocol, it selects directly from the tools advertised by the
outer Copilot request. The provider emits the selection as a
`LanguageModelToolCallPart` and suspends the current provider response while the
app-server turn stays alive. Copilot then renders and executes the tool through
its standard agent loop. The following provider round contains the native
result and resolves the still-pending app-server dynamic tool request. Parallel
requests are emitted together and resume only after every matching result is
available. The original Codex turn continues directly: there is no interrupt,
second `turn/start`, serialized continuation prompt, or full-history prefill.
Continuations are matched by unique native tool call ids, time out after 24
hours if abandoned, and are never persisted as chat history. If VS Code adds
or removes advertised tools while a call is running, the active turn keeps its
original catalog until completion instead of restarting with the full history.

Copilot can advertise a large catalog whose size depends on the installed
extensions, attached MCP servers, workspace policy, and current Chat mode.
By default, the provider marks uncommon schemas with app-server
`deferLoading` inside the `vscode_deferred` namespace, while keeping workspace
reads, searches, terminal commands, edits, web verification, user input, and
planning immediately visible. Codex's built-in tool search loads a deferred
schema only when it is needed. Disable
`llamacpp.codexDeferNonCoreTools` if an older custom CLI does not support this
experimental app-server field. Outer tools named `apply_patch` and `view_image`
use the eager `vscode_native` namespace to avoid colliding with the Codex
built-ins while preserving native Copilot execution and tool cards.

Quick Access exposes a Codex working-context slider. It never claims to enlarge
the physical model window: the selected target is capped to the latest
`modelContextWindow` returned by app-server. For a cold full-history start, the
provider subtracts explicit output, dynamic-tool-schema, developer-instruction,
and safety reserves, then compacts semantic VS Code history only above the
remaining budget. This replaces the former extra `0.45` multiplier that could
shrink a 258.4k-window request to roughly 87k message tokens.

Completed durable conversation threads stay available for up to seven days
(maximum 16), matching Claude session retention. Reuse first checks the complete SHA-256 history and answer
digests. Copilot patch v16 additionally forwards a stable conversation id and
turn index so the provider can tolerate rewritten service, tool, or rendered
prompt history while still requiring an advancing turn and the exact prior
answer. Without the patch, a conservative fallback ignores mutable tool
plumbing but requires the complete bounded suffix of recent semantic user
messages. Model, workspace, sandbox, approval policy, and app-server process
generation must still match. The dynamic tool catalog may drift: a reused thread retains the
catalog and namespace routes supplied at `thread/start`, while the provider
allows only the intersection with the current Copilot request. Newly advertised
tools wait for a fresh thread; removed, re-namespaced, and schema-changed tools
are unavailable. Editing a recent user request, regenerating an answer, changing
runtime configuration, restarting Codex, or missing the cache starts a fresh
thread with the bounded full Copilot history.
Quick Access reports both the in-process thread-reuse ratio and the last
prompt-cache percentage returned by Codex. Body-free
codex.chat.thread_reuse_miss events categorize reuse failures without logging
conversation ids, text, or hashes.

If the native VS Code transcript has already become too large, run
`Local LLM: Continue Latest Codex Thread in New Chat`. The command arms the
newest durable completed Codex thread for 24 hours and opens a clean chat.
Keep the same Codex model selected and send the next user message there. The
provider resumes the inner Codex thread but does not serialize the old VS Code
transcript again.

This design also supports private caller tools that are not present in
`vscode.lm.tools`, including Copilot's terminal implementation. Native calls use
the session's own permission level, terminal auto-approval rules, and `Bypass
Approvals`. While delegation is active, internal Codex command and file approval
requests are declined without an extra modal prompt so Codex can select the
matching outer tool instead.

If Codex nevertheless starts an internal action, the bridge rejects it and
waits for the app-server interrupt to settle. The provider then starts one
bounded recovery turn on the same thread with an explicit native-tool reminder.
The prohibited action never executes, completed VS Code tool results are not
repeated, and the visible transcript is not replayed into a cold replacement
thread.

Agent commentary and reasoning summaries are emitted through the native VS Code
thinking stream when that API is available. Final answer text and server token
usage are emitted through the normal language-model response stream.

## Live Diagnostics

`Local LLM: Open Session Quality Report` updates while a Codex turn is running.
One logical user turn is upserted instead of duplicated across native tool
result rounds. The report includes:

- app-server model usage segments with input, cached input, output, reasoning,
   total tokens, and cache-hit percentage;
- ordered model/tool steps with running, completed, failed, timed-out, or
   cancelled state and native tool duration;
- separate processed cache cost across every model segment and final or
   continuation-segment reuse, so an uncached first segment does not hide a
   healthy cached continuation;
- a separate cold Codex startup count, so a recovered 0% first segment remains
   visible without marking the entire logical turn unhealthy;
- thread mode, reuse-miss reason, lifecycle phase, and terminal detail;
- first-model-event and first-visible-text latency;
- context-window, compaction, serialized-message, and tool-schema budgets;
- exact rollout-derived metrics when a durable rollout is available, with a
   live-notification fallback for ephemeral or not-yet-persisted turns.

Records contain metrics and request identifiers, not message or tool-result
bodies. Markdown and JSON snapshots are written to extension global storage.

### New user turn while a native tool is still running

If Copilot forwards a newer user turn while the same conversation is waiting on
a native VS Code tool (including `runSubagent`), the provider interrupts the
pending Codex app-server turn and marks its Live Report record terminal. When
the model, runtime, tool catalog, process generation, and conversation identity
still match, the provider starts the new user turn on that same app-server
thread and sends only the latest user tail. It does not serialize the whole VS
Code transcript into a new cold thread.

The extension cannot forcibly terminate the implementation behind a native VS
Code tool card after ownership has passed to VS Code. It can stop waiting for
that result, reject a late continuation, and unblock the Codex thread. A native
tool that remains unresolved for 24 hours is recorded as `timed_out` rather
than staying `running` forever.

## Setup

The provider resolves the executable in this order:

1. `llamacpp.codexCliPath`
2. Codex bundled with the official `openai.chatgpt` VS Code extension
3. `codex` on `PATH`

Use `Local LLM: Sign In to Codex Subscription` for a managed browser OAuth
flow. An existing ChatGPT session created with `codex login` is shared
automatically. Signing out from the extension also signs out that shared local
Codex CLI session.

Use `Local LLM: Show Codex Subscription Status` to verify the ChatGPT plan and
current Codex rate-limit window. OAuth tokens and the account email are not
shown or written to extension logs.

## Settings

| Setting | Default | Purpose |
| --- | --- | --- |
| `llamacpp.enableCodexSubscription` | `true` | Advertise subscription-backed Codex models. |
| `llamacpp.codexCliPath` | empty | Optional explicit Codex executable. |
| `llamacpp.codexReasoningEffort` | `auto` | Use model default or a supported effort. |
| `llamacpp.codexReasoningSummary` | `auto` | Thinking summary detail. |
| `llamacpp.codexFastServiceTier` | `false` | Request priority service when offered; uses quota faster. |
| `llamacpp.persistProviderSessions` | `true` | Resume completed Codex and Claude sessions across reloads. |
| `llamacpp.codexEphemeralThreads` | `false` | Force Codex threads to stay in-memory and disable cross-reload resume. |
| `llamacpp.codexContextLength` | `258400` | Pre-telemetry fallback window; server-reported model context takes precedence. |
| `llamacpp.codexWorkingContextTarget` | `258400` | Cold-start target capped to the server window before explicit reserves are deducted. |
| `llamacpp.codexMaxInputChars` | `900000` | Serialized conversation hard cap after token-aware compaction. |
| `llamacpp.codexMaxToolResultChars` | `12000` | Per-result history cap that preserves more conversational turns. |
| `llamacpp.codexDeferNonCoreTools` | `true` | Keep core coding tools eager and load uncommon schemas through Codex tool search. |
| `llamacpp.codexMaxOutputTokens` | `32768` | Reply reserve advertised to VS Code. |

The model catalog supplies the supported Thinking Effort values dynamically.
The native per-chat selector takes precedence over the global default. If an
effort is unavailable for a selected model, the provider falls back to that
model's catalog default.

Codex actions always use Copilot's native VS Code tool loop. The provider
forces the internal runtime to `read-only` plus `on-request`, disables built-in
action capabilities, declines internal permission requests, and interrupts a
turn if an internal action still appears. There is intentionally no opt-out.

## Troubleshooting

### No Codex models in the picker

Run `Local LLM: Show Codex Subscription Status`. A valid state is
`Connected (<plan>)`. Then run `Local LLM: Refresh Models`.

If the status says `API auth blocked`, run `codex logout`, then sign in with a
ChatGPT account through `codex login` or the extension command. This provider
does not use `OPENAI_API_KEY`.

### Codex CLI cannot be started

Install the official OpenAI extension, install `@openai/codex`, or set an
absolute `llamacpp.codexCliPath`. After changing the path, reload VS Code and
refresh models.

### Commands or searches remain inside the thinking block

A command routed through the native bridge produces `codex.chat.tool_delegated`
and a normal Copilot tool card. Copilot then executes it using the current
session approval mode. `codex.internal_tool.declined` or
`codex.internal_tool.blocked` means the runtime attempted a forbidden internal
path; the provider denied or interrupted it instead of executing invisibly.

### Native VS Code tool delegation is unavailable

Dynamic calls arriving after one native card detaches but before its result
resumes the turn are queued and logged as `codex.chat.tool_delegation_queued`.
They are shown in the next native tool segment. A remaining
`codex.chat.tool_delegation_unavailable` event includes an explicit reason;
`detached-without-pending-turn` indicates an unrelated call with no valid
Copilot result round to resume and is intentionally rejected.

### Context display differs from the runtime

The current runtime reports a 258400-token window. Before telemetry arrives the
provider uses `codexContextLength` as a fallback; afterwards the server-reported
window is authoritative. Actual usage from `thread/tokenUsage/updated` is
returned after every completed turn.

### Input exceeds 1048576 characters

Copilot may pass a long chat containing large tool results as more than one
million serialized characters even when its token indicator is still below the
model context window. The provider keeps the first and newest messages, omits
older middle history, and truncates the newest message only as a last resort.
Before dropping messages it bounds individual historical tool results, which
usually keeps all user and assistant turns available.
`llamacpp.codexMaxInputChars` defaults to `900000` as a final hard character
cap after token-aware compaction. The `codex.chat.start` log event records the
model window, selected working target, message budget and every reserve, plus
original/final character counts and omitted or truncated content. Images
belonging to omitted history messages are not resent.

Patch v16 additionally caps terminal and native tool data before VS Code writes
it into its own chat-session snapshots. This prevents future transcript growth;
it does not shrink sessions that were already persisted. Use the Codex rollover
command above to leave an existing oversized chat while preserving the latest
durable completed Codex thread.
