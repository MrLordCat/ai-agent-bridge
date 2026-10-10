# Copilot Chat Integration

## Purpose

VS Code can consume extension-contributed language models through the stable
`LanguageModelChatProvider` API, but bundled Copilot Chat keeps part of its
native model UI behind an internal endpoint wrapper. This project integrates
with that wrapper in two ways:

1. the extension uses supported response metadata for native context usage;
2. its built-in guarded patch exposes controls that the public provider API
   cannot currently describe.

The context counter does not require the Copilot patch. Thinking Effort and the
provider-specific output limit do.

## Native Context Usage

Every streamed request sends:

```json
{
  "stream": true,
  "stream_options": {
    "include_usage": true
  }
}
```

Both llama.cpp's OpenAI-compatible server and DeepSeek return a final SSE chunk
with an empty `choices` array and a `usage` object. The extension validates and
forwards it as a `LanguageModelDataPart` with MIME type `usage`:

```json
{
  "prompt_tokens": 120,
  "completion_tokens": 30,
  "total_tokens": 150,
  "prompt_tokens_details": {
    "cached_tokens": 80
  }
}
```

Copilot Chat uses this data for the native Session Info panel. If an otherwise
compatible server does not return usage, the provider sends a conservative
character-based estimate so the panel does not stay at `0 / N tokens`.

The extension also normalizes llama.cpp `cached_tokens` and DeepSeek
`prompt_cache_hit_tokens` for its own Prompt Cache diagnostic. Copilot's native
panel still receives the standard OpenAI-compatible nested shape.

The context-window denominator comes from the model metadata advertised by the
provider. For local models this is resolved from runtime server metadata when
available; the configured fallback is used otherwise.

## Built-In Bundle Patch

`src/copilot-patch.ts` is compiled into the VSIX and modifies Copilot Chat only
for the `llamacpp` vendor. The extension applies compatible patches on startup
and exposes apply, status and restore commands; no installer or external patch
script is required. Patch v22 makes the following changes:

- `maxOutputTokens` uses the limit advertised by the selected model instead of
  the wrapper's fixed 8192-token value;
- `supportsReasoningEffort` exposes native session choices;
- the selected effort is forwarded as `modelOptions.reasoningEffort`;
- prompt rendering remains bounded by the effective advertised context window;
  it never replaces Copilot's endpoint budget with an unbounded JavaScript value;
- stale smaller per-session context overrides are ignored for this provider;
- a smaller global Copilot summarization threshold is ignored in favor of the
  model's advertised prompt window;
- Copilot does not reserve its full raw tool catalog before the provider has
  selected and compacted the tools it will actually send;
- Copilot's temporary Agent renderer does not reject raw tool results before
  the provider can sanitize and budget them;
- automatic background and foreground LLM summarization and wrapper-owned
  truncation are disabled for contributed `llamacpp` models. Provider-specific
  compaction remains authoritative. The explicit Compact Conversation command
  routes the active stable conversation id to a one-shot provider recovery
  compaction; non-`llamacpp` conversations keep Copilot's native `/compact`;
- Copilot's stable conversation id is forwarded through provider-private
  `modelOptions` so completed Codex threads can be reused even when Copilot
  rewrites generated history. The id is never written to extension logs.
- advertised tools and schema keys use deterministic ordering. Copilot waits for
  tool definitions only after their cached signature actually changes, avoiding
  an unnecessary tool-catalog cold start on every provider continuation;
- native terminal output and textual tool results are capped before VS Code
  serializes them into persisted chat history;
- binary and other non-text tool payloads are replaced by a compact history
  placeholder. The live tool card is unaffected.
- the tokenizer for extension-contributed models memoises token counts by
  content. Copilot otherwise calls `LanguageModelChat.countTokens` once per
  message, text part and tool-schema key on every agent round — measured at
  14 637 sequential round trips and ~155s of wall clock per round on a
  1 500-message conversation, while the provider itself spent 11ms on them.
  Built-in models already use a cached local tokenizer.
- the rendered agent history is capped for llama.cpp models
  (`llamacpp.agentHistoryRounds`, default 400 tool-call rounds, 0 disables the
  cap). Copilot's prompt-tsx builds a node tree from every tool-call round and
  walks it repeatedly for token accounting and node coalescing, so a
  1 500-message conversation costs minutes of host CPU per step even after the
  token-count RPCs are memoised. The oldest 20% of rounds are kept as a stable
  prefix for the upstream prompt cache plus the newest rounds; the cap only
  trims what is rendered into the prompt — the persisted chat session is never
  modified.

The extension maps native values to its request modes:

| Native value | Extension mode |
| --- | --- |
| `none` | `off` |
| `low` | `light` |
| `medium` | `balanced` |
| `high`, `max` | `deep` |

Local models expose `None`, `Low`, `Medium`, and `High`. DeepSeek exposes
`High` and `Max`. The session value overrides `llamacpp.thinkingMode` only for
that chat request.

## Apply And Restore

`llamacpp.autoPatchCopilot` defaults to `true`. On extension startup, the
runtime discovers installed Copilot bundles and associates them with the active
desktop workbench. Read-only bundles from another Linux installation are
skipped. If patch v22 is already present, startup is silent. If a bundle is changed, the extension asks
for one window reload. A repeated compatibility failure is logged but shown at
most once per VS Code build.

Command Palette exposes:

- `AI Agent Bridge: Apply Copilot Chat Patch`;
- `AI Agent Bridge: Show Copilot Chat Patch Status`;
- `AI Agent Bridge: Restore Original Copilot Chat`.

On a local Linux desktop, permission failures and partial application offer
**Prepare User VS Code (no root)** and **Apply patches with administrator rights**.
The first creates a writable desktop copy. The second asks the operating system
to authorize patching the current installation through `pkexec`. If graphical
authorization cannot complete, a visible VS Code terminal uses sudo when
installed, or su otherwise. **Run sudo in Terminal** asks for your user's
password; **Run su in Terminal** runs `su - root -c` and asks for root's password.
Enter it directly in the terminal. The runner is retained after a failed attempt:
use **Retry in Terminal**, or press **Apply Patch** in Quick Access to reopen
the retry workflow. **Close Attempt** discards the retained runner and starts
a fresh workflow. While a command is active, Apply Patch reveals its terminal
and does not send another command into the password prompt.

No elevation occurs until the administrator action is selected. The runner uses
paths discovered as the desktop user, so root does not search another profile;
it retains the ordinary compatibility, syntax and backup checks. It also applies
enabled terminal/Agents patches for that desktop build. Individual patch toggles
and restoration offer recovery when permissions prevent their operation.

Run `Developer: Reload Window` in every open VS Code window after applying or
restoring the patch.

## Safeguards

Before writing, the patcher:

1. checks the Copilot manifest and expected wrapper structure;
2. locates the active VS Code workbench bundle from `vscode.env.appRoot`;
3. requires every minified-code anchor to be unique;
4. changes only the identified Copilot endpoint and chat-history serializers;
5. validates the Copilot bundle with `vm.Script` and the ESM workbench bundle
   with `node --check`;
6. creates separate restorable backups beside both bundles;
7. records original and patched SHA-256 hashes for both files.

Applying patch v22 over an older supported patch marker uses the preserved
original backup rather than stacking edits on the already modified bundle.

The patch is deliberately fail-closed. If a Copilot update changes the bundle
shape, the extension stops instead of applying a broad replacement and leaves
the active bundle unchanged. VS Code updates normally install a new application
directory, so the next extension startup checks and patches that new active
directory without touching older installs.

The 1.17.0 Debian verification exercised VS Code 1.131 and 1.141 as UID 1000
with writable, system-owned and prepared user-owned application files.
The agent-host native capabilities were also checked on 1.136.1.
These are verification snapshots, not a promise that future minified
bundles retain the same structure.

## Troubleshooting

### Session Info Shows `0 / N tokens`

1. Install the newest VSIX and reload the window.
2. Send a new chat turn; old responses cannot be retroactively annotated.
3. Open the latest extension log and find `chat.response.usage`.
4. `source: "server"` means exact upstream counters were used.
5. `source: "estimate"` means the server omitted its final usage chunk.

The denominator can be correct while usage stays zero: model limits and response
usage travel through separate metadata paths.

### Context Window Is Wrong

Check the selected model tooltip and Quick Access context breakdown. For a local
llama.cpp server, verify `/v1/models` and `/slots` expose the active runtime
context. Set `llamacpp.localContextLength` only as a fallback or explicit local
override.

### Thinking Effort Is Missing

Run `AI Agent Bridge: Show Copilot Chat Patch Status`. If the patch is applied, reload
all VS Code windows and start a new chat session with a model from this provider.

### VS Code Was Updated

The new installation has a new Copilot bundle. With auto-patch enabled, activate
AI Agent Bridge once and accept its reload prompt. Otherwise run `AI Agent Bridge: Apply
Copilot Chat Patch`. Do not copy a patched bundle from an older VS Code build.

### Patch Installation Without Administrator Rights

Open the `AI Agent Bridge Copilot Patch` output channel to identify the failure.
`Copilot bundle shape changed` or `VS Code workbench shape changed` means the
patch needs an update for the installed VS Code build; elevation cannot fix it.

The patch code searches for Copilot Chat instead of trusting one path, so most
installations need no administrator rights at all:

- **Official Windows/macOS build** — the bundled `extensions/copilot` inside the
  application root.
- **Code - OSS, CachyOS, Marketplace installs** — the user extension in
  `~/.vscode-oss/extensions`, `~/.vscode/extensions`, or the matching insiders
  folder, which always belongs to your account.
- **Remote-WSL** — both copies: the Linux server that runs chat
  (`~/.vscode-server/extensions` or the server's own `extensions/copilot`) and
  the Windows installation that renders the window, found through
  `/mnt/c/Users/<you>/AppData/Local/Programs/Microsoft VS Code/<commit>` by
  matching the commit of the running server. The workbench bundle is always the
  Windows one, because a server installation has no `workbench.desktop.main.js`.
- **Remote-SSH and containers** — `~/.vscode-server/extensions` and the server
  application root on the remote side.

The Copilot Chat bundle is patched on its own and the workbench/agent-host parts
are applied on a best-effort basis: a read-only workbench no longer fails the
whole operation, it is reported as `Notice:` in the status output.

For `EACCES`, `EPERM` or `EROFS` on a system-wide local Linux installation,
use either recovery choice described above. Syntax validation uses a private
temporary directory rather than writing test files beside a read-only bundle.
Failed restoration retains the backups for an authorized retry. On Windows use
the VS Code **User Installer** or a portable
installation in a directory owned by your account: those files are writable
without elevation, and a WSL extension host cannot elevate into Windows. Do not
change ownership of a system installation or copy patched bundles between VS
Code versions.

### Patch Guardian Keeps Offering Changes

`llama-vscode-chat` 1.6.0 embeds both the Copilot native-controls patch and the
required subagent `model` schema for its Codex and Claude bridges. Patch Guardian
is not needed for this extension and can be disabled or uninstalled. The built-in
runtime reports discovered bundle paths in its output channel. The elevated
runner limits application patches to the active desktop installation.

## Ownership Boundary

The VSIX owns model discovery, routing, prompts, tools, memory, streaming,
context usage, thread validation, diagnostics, subagent schema enforcement, and
the guarded Copilot bundle lifecycle. The bundle patch remains deliberately
narrow: it owns only the missing native controls and stable conversation
identity that the public request surface does not expose. The exact original
bundle backup keeps restoration deterministic; without the patch, the provider
falls back to conservative rendered-history matching.
