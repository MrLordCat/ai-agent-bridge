# Snowflake Coco

Since 1.18.14, all adapters receive the common conversation journal; Codex,
Coco and Cursor prepare handoffs using one token-budget planner. The old
million-character Coco cutoff is gone. See [shared context](SHARED_CONTEXT.md)
for settings, native continuation, archive/image preservation and long-run errors.

Since 1.18.13, requests with VS Code callback tools use native ACP even when
SDK is selected: the bundled CLI expires SDK callbacks after 30 seconds,
including time spent waiting for Chat approval and tool execution. ACP retains
the native session and supports longer tool waits. Text-only requests can
still use SDK. See [the live reproduction and measurements](PERFORMANCE_RESEARCH.md).

For the reproduced full-tool-name failure and the 1.18.12 fix, see
[the tool-name incident diagnosis](COCO_TOOL_NAME_INCIDENT.md). SDK aliases
include the MCP namespace in the 64-character backend limit and are checked
before inference. Request bounds and sanitized failures are recorded as
`coco.request.prepared` / `coco.request.failed` without prompt text.

Coco keeps a native session for each workspace, conversation, model and
Snowflake connection. Follow-ups append new entries, including entries from
another provider that continued the same Chat. Compatible completed sessions
resume after a VS Code reload. Rewinding/editing history creates a fresh native
branch; interrupted tool cycles are cancelled rather than reused.

Since 1.18.8, `llamacpp.cocoTransport=auto` uses the Snowflake `/code` SDK on
Node 22.22+ and ACP on older hosts. Explicit `sdk` and `acp` choices are available.
The CLI owns conversation history; the bridge preserves its native session ID.
Bindings are stored atomically on disk and mirrored in workspace state.
Failed load or preflight checks preserve the previous binding without silently
starting a fresh session. A confirmed native continuation can proceed even if
the optional handoff journal is unavailable.

A cold handoff uses one native prompt without hidden ACK imports. Since 1.18.11,
large handoffs are prepared locally: retain the complete latest request, prefer
user requirements and recent context, and put older tool output/images and
omitted text in an exact archive. Chat shows the reduction and archive path.
The model can read that archive through VS Code tools when a detail is missing;
an archive is not proof that every detail is in the active model context.
Historical @ references are quoted to avoid automatic attachment loading.
The working target is at most 1,000,000 text characters, reduced for smaller
configured windows. It is not a measured token limit: SDK 0.0.2 exposes no exact
model tokenizer. A current request that alone exceeds the target is rejected
before inference. The CLI owns its actual finite window and subsequent native
compaction. There is no automatic multi-request replay after a failure.
A separate 64 MiB limit on encoded content
protects bridge memory/transport and includes JSON escaping, UTF-8 and image data.
Exceeding that safety limit archives the payload and stops before inference;
it is not a token count or model window. `llamacpp.cocoMaxHistoryImportParts`
is obsolete. Full transcripts, image bytes and oversized tool outputs remain
available locally for rereading.

An interrupted native turn requires a new explicit user message. The bridge
resumes the stored session and skips the already-sent request. Repeated native
callback IDs reuse completed results visible in Chat. Missing acknowledgements
across process loss still require reconciliation; arbitrary new tool IDs are
not treated as proof that an earlier action did or did not execute.

Current Cortex ACP can emit `Error: internal error (request_id: ...)` and still
report `end_turn`. The bridge recognizes that exact error frame as a failed
request. Older checkpoints whose associated answer was this frame are rebuilt
from visible context on the next explicit user turn; original native histories
are preserved. It does not automatically replay an unsuccessful action.

The exact `claude-opus-5-5` ID starts with a verified 1,000,000-token window.
`llamacpp.cocoModelContextLengths` overrides per-model baselines; unknown models
use `llamacpp.cocoContextLength` (128,000 by default). Measured runtime windows
take precedence. A model's finite window and native compaction still apply.
See [continuity, storage and cache verification](COCO_CONTINUITY.md).

For the investigation behind SDK-managed native sessions, see the
[Coco native integration research](COCO_NATIVE_INTEGRATION_RESEARCH.md).
Current implementation and runtime checks are described here and in the changelog.

Install the Snowflake VS Code extension. AI Agent Bridge uses its bundled
`cortex` CLI through the Snowflake SDK and ACP. If your Snowflake CLI has
one connection, its name is selected automatically; otherwise set
`llamacpp.cocoConnection`. The `Auto (Coco)` entry is available immediately.
The models granted to your Snowflake role appear after an ACP connection
succeeds. Use **AI Agent Bridge: Refresh Models** to retry discovery.

The Snowflake extension's Azure sign-in session is passed to its own Coco panel
through a private API. AI Agent Bridge uses the CLI's Snowflake connection and
credential cache, so an Azure browser sign-in may be required once for the CLI.
No token is copied from the Snowflake extension. Coco delegates tools offered
for the turn, including private Copilot tools, to the native Chat tool loop.
Chat controls approvals (including Allow All), execution cards and results.
The same ACP prompt stays alive while Chat executes each tool and returns its
result. Tool aliases distinguish these client tools from Cortex built-ins.
The bridge stops built-in Cortex actions that attempt to bypass Chat, reporting
the problem in Chat instead of opening a separate permission picker.
Cortex's own system prompt asks Coco to sign commits and pull requests with
"Generated with [Snowflake CoCo](…)" and "Co-authored-by: Snowflake CoCo
<noreply@snowflake.com>". The bridge policy forbids that, and every tool call
Coco hands to Chat is cleaned before it runs: `-m`, `--message` and `--trailer`
arguments holding only that attribution are dropped, and lines holding only it
are removed from commands, messages and file contents. Text an edit must match
(`oldString`, `old_str`) is kept, so an earlier attribution can still be
removed from a file; text that only mentions Snowflake CoCo is left alone.
Use the Snowflake Coco panel for its own built-in SQL and other agent tools.
Commands run through **cocoRunInTerminal** in ordinary integrated terminals
named `Coco 1`, `Coco 2`, etc., including in the Agents Window. Sequential commands
automatically reuse the last idle terminal, preserving its directory and shell
variables even when the model omits `terminalId`. Occupied or closed terminals
are skipped. Set `newTerminal: true` only when a separate shell is needed. If
`cwd` is specified, reuse requires that terminal's reported directory to match.
Open the terminal
panel to type input, press **Ctrl+C**, or close a terminal with its trash icon.
Chat still controls approval of the command. Native Agents `powershell`/`bash`
Background Shell tools are excluded from Coco's catalog. The companion tools
**cocoReadTerminal**, **cocoSendToTerminal**, and **cocoKillTerminal** read output,
send input, and close a terminal using the returned `terminalId`.
Finite commands use sync mode; a timeout leaves the command running and returns
its status. Servers can use async mode. Closing a terminal releases any pending
tool wait without automatically restarting the command. Shell integration must
be enabled with a supported default shell (PowerShell 7, bash or zsh). If it
cannot activate, the bridge reports the problem before sending the command.
After updating the extension, reload VS Code and start a new request so Coco
receives the updated tool catalog. Existing Background Shells remain separate.
The bridge sends text and image attachments. The picker enables vision after
ACP advertises image input. SDK 0.0.2 ignores image blocks on its stdin API,
so image turns use ACP with the same native session ID. Replay stays hidden;
images retain their original bytes and MIME types. The next text turn resumes
that same history through SDK. This capability choice happens before inference.

The model picker exposes **Thinking Effort** using the levels advertised by
Coco (currently Auto, Minimal, Low, Medium, High, and Max). The chosen value is
sent to the session before the prompt. Native thought deltas appear in the
thinking block, separately from the answer. A model or endpoint that does not
return thought deltas will only show its answer.

Coco also reports measured context usage to the native Chat indicator when ACP
sends `usage_update`. The current token count and total window come from the
runtime's `used` and `size` fields; the snapshot persists across tool-result
continuations and can decrease after compaction. Observed windows replace the
configured fallback for that model. The bridge does not treat cumulative billing
tokens as context or invent a measured count when the runtime sends none.

SDK/ACP prompt results also provide measured usage: uncached input, cache reads,
cache writes and output. These populate Coco's own Token Usage category,
Quick Access metrics and session diagnostics. Input totals include cache reads
and writes exactly once. SDK cumulative counters are differenced per process; current
context remains a separate snapshot. Cache availability depends on the backend;
a warm or restored session does not promise a hit. Missing counters show as
unreported.

`node scripts/coco-sdk-smoke.mjs --run --cli <cortex> --connection <name> --vision`
verifies a callback, warm continuation, process restart, image and subsequent
SDK continuation. It uses real model requests only with `--run`. On the verified
Opus 5.5 run, the marker survived all stages and the tool ran once. Warm input
was 82,664 tokens (82,596 cache reads); restored input was 82,924 (82,506 reads).
These are measurements of that test, not a cache-hit guarantee.

The opt-in test `live large handoff` in `coco-sdk.test.ts` uses
`AAB_COCO_LIVE_ARCHIVE` and optionally `AAB_COCO_LIVE_CLI`. It sends two real
diagnostic prompts with no callable project tools. On 2026-10-19, the reported
3,045,868-character archive was prepared and both control facts survived the
first prompt and native restart (34 seconds total). Normal tests skip it.

Quick Access has a **Coco** section with live ACP connection status, the
discovered model count, an on/off source toggle, Snowflake connection selection,
catalog refresh, and links to the native thinking picker, Coco settings, and the
Snowflake Coco panel. Status checks open an ACP session without running inference.
Background discovery reuses fresh status results. Since 1.18.10, manual
**Connection Status** and **Refresh Models** force one shared check, preserving
the catalog and thinking levels while it runs. Selecting the existing
**Snowflake Connection** also retries it without rewriting settings; cancelling
the picker does nothing. The notification shows
the current stage and supports **Cancel**. Startup and model discovery together
have a 45-second deadline; a timeout or cancellation stops the owned CLI and
reports an actionable status. Repeated refresh clicks share the same operation
instead of restarting it or adding more notifications.
**Open Snowflake Coco** selects Snowflake's secondary-sidebar view on current
VS Code, falling back to the classic view when needed. It shows cancellable
activation progress with a 45-second deadline and reports failures. Cancelling
or timing out prevents a late panel opening from that attempt. Credentials are
managed by Snowflake/CLI: a valid cached login does not require a new sign-in.
The section stays visible when Coco is offline so reconnect and setup controls
remain available.