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
for the `llamacpp` vendor. `scripts/patch-copilot-chat.mjs` is a thin development
CLI over that same implementation, so runtime and repository commands cannot
drift apart. Patch v9 makes the following changes:

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
- automatic background and foreground LLM summarization is disabled for this
  provider. The explicit Compact Conversation command remains available.
- Copilot's stable conversation id is forwarded through provider-private
  `modelOptions` so completed Codex threads can be reused even when Copilot
  rewrites generated history. The id is never written to extension logs.
- native terminal output and textual tool results are capped before VS Code
  serializes them into persisted chat history;
- binary and other non-text tool payloads are replaced by a compact history
  placeholder. The live tool card is unaffected.

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
runtime checks only `vscode.env.appRoot`, which is the active VS Code build. It
does not scan old extension or application directories. If patch v9 is already
present, startup is silent. If the active bundle is changed, the extension asks
for one window reload. A repeated compatibility failure is logged but shown at
most once per VS Code build.

Command Palette exposes:

- `Local LLM: Apply Copilot Chat Patch`;
- `Local LLM: Show Copilot Chat Patch Status`;
- `Local LLM: Restore Original Copilot Chat`.

The repository CLI remains useful before installing a VSIX or for recovery:

Run from the repository with the Node environment used to build the extension:

```sh
npm run patch:copilot:status
npm run patch:copilot
npm run patch:copilot:restore
```

The CLI locates the active Windows VS Code installation through `code.cmd`.
For a portable or test build, pass the application root explicitly:

```sh
npm run patch:copilot:status -- --root <path>
npm run patch:copilot -- --root <path>
```

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

Applying patch v9 over patch v2 through v8 uses the preserved original backup
rather than stacking edits on the already modified bundle.

The patch is deliberately fail-closed. If a Copilot update changes the bundle
shape, the extension stops instead of applying a broad replacement and leaves
the active bundle unchanged. VS Code updates normally install a new application
directory, so the next extension startup checks and patches that new active
directory without touching older installs.

The implementation has been exercised against the local VS Code 1.127 /
bundled Copilot Chat 0.55 installation and the repository's VS Code 1.130 test
host. These are verification snapshots, not a promise that future minified
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

Run `Local LLM: Show Copilot Chat Patch Status`. If the patch is applied, reload
all VS Code windows and start a new chat session with a model from this provider.

### VS Code Was Updated

The new installation has a new Copilot bundle. With auto-patch enabled, activate
Local LLM once and accept its reload prompt. Otherwise run `Local LLM: Apply
Copilot Chat Patch`. Do not copy a patched bundle from an older VS Code build.

### Patch Guardian Keeps Offering Changes

`llama-vscode-chat` 1.6.0 embeds both the Copilot native-controls patch and the
required subagent `model` schema for its Codex and Claude bridges. Patch Guardian
is not needed for this extension and can be disabled or uninstalled. The built-in
runtime targets only the active VS Code application root, so stale side-by-side
extension versions cannot inflate the applied-target count.

## Ownership Boundary

The VSIX owns model discovery, routing, prompts, tools, memory, streaming,
context usage, thread validation, diagnostics, subagent schema enforcement, and
the guarded Copilot bundle lifecycle. The bundle patch remains deliberately
narrow: it owns only the missing native controls and stable conversation
identity that the public request surface does not expose. The exact original
bundle backup keeps restoration deterministic; without the patch, the provider
falls back to conservative rendered-history matching.
