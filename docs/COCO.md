# Snowflake Coco

Large conversations are shortened before sending a new ACP prompt. The bridge
keeps the latest user request and its image bytes, initial instructions, and
recent history; older long text and tool outputs are bounded. The text budget
reserves space for tool definitions and agent instructions. Token counting does
not reject a large historical message. If the latest request itself cannot fit,
reduce its current text or attachments instead of starting over merely because
the old chat is long.

Install the Snowflake VS Code extension. AI Agent Bridge uses its bundled
`cortex` CLI through the Agent Client Protocol (ACP). If your Snowflake CLI has
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
The bridge sends text and image attachments and starts a fresh ACP session for
each new user request. The picker enables vision after the active ACP runtime
advertises image input. Images retain their original bytes and MIME types in
separate ACP content blocks. Warm reuse between user turns is not yet supported.

The model picker exposes **Thinking Effort** using the levels advertised by
Coco (currently Auto, Minimal, Low, Medium, High, and Max). The chosen value is
sent to the session before the prompt. ACP thought deltas appear in the native
thinking block, separately from the answer. A model or endpoint that does not
return thought deltas will only show its answer.

Coco also reports measured context usage to the native Chat indicator when ACP
sends `usage_update`. The current token count and total window come from the
runtime's `used` and `size` fields; the snapshot persists across tool-result
continuations and can decrease after compaction. Observed windows replace the
configured fallback for that model. The bridge does not treat cumulative billing
tokens as context or invent a measured count when the runtime sends none.

Quick Access has a **Coco** section with live ACP connection status, the
discovered model count, an on/off source toggle, Snowflake connection selection,
catalog refresh, and links to the native thinking picker, Coco settings, and the
Snowflake Coco panel. Status checks open an ACP session without running inference.
Fresh status results are reused. **Refresh Models** forces one shared check,
preserving the catalog and thinking levels while it runs. The notification shows
the current stage and supports **Cancel**. Startup and model discovery together
have a 45-second deadline; a timeout or cancellation stops the owned CLI and
reports an actionable status. Repeated refresh clicks share the same operation
instead of restarting it or adding more notifications.
The section stays visible when Coco is offline so reconnect and setup controls
remain available.