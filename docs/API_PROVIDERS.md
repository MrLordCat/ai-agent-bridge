# API Providers

> **Renamed in 1.14.2**: the manager is now the unified **Providers Manager** —
> Local LLM, DeepSeek, Codex, Claude, and custom API profiles share one window.
> Offline providers are hidden from Quick Access and reappear when they come
> back online; the reason for being offline is shown in the manager.

AI Agent Bridge can load models from multiple OpenAI-compatible HTTP APIs at
the same time. Profiles are managed from:

`Quick Access → Providers → Providers Manager`

Each enabled profile contributes its discovered models to the native VS Code
model picker without replacing the built-in Local LLM or DeepSeek source.

## Profile Fields

| Field | Purpose |
|---|---|
| Name | Human-readable source label shown beside discovered models |
| Base URL | API root, with or without a trailing version segment such as `/v1` |
| API format | Controls request fields: OpenAI-compatible, DeepSeek native, or llama.cpp |
| Model family | Controls context/output/reasoning defaults independently from API format |
| Context | Discovered automatically from the model catalog or runtime; choose a smaller working limit with the card's slider after saving |
| Enabled | Adds or removes the profile from discovery without deleting it |
| API key | Optional Bearer token stored only in VS Code SecretStorage |

The add/edit form does not require a context size. For example, when the API
reports a 1,000,000-token model window, choose 500,000 with **Working context**.
**Use automatic context** restores the discovered maximum. Each model still
uses its own limit when a provider offers models with different windows.
If no maximum is reported, the card labels its safe fallback explicitly.
Existing saved context values become working caps; editing the connection
preserves them. Presets do not override discovered context limits.

### Choose models by provider

Click **Models by Provider** (the tree icon) in the Chat or Quick Access title
bar, or run **AI Agent Bridge: Models by Provider** from the command palette.
Choose a provider first, then one of its models. Use **Back to providers** to
change the group. API profiles remain separate even when their names match;
an enabled profile with an unavailable catalog stays visible with zero models.

Choosing a model updates the current chat without sending a message. Models
without local tool calling use Ask mode. Cursor SDK models with Tools remain
available in Agent mode.
The regular VS Code model dropdown remains available for model configuration.

### Cursor billing

Cursor balance and budget integration was removed in 1.17.15. The Admin API
requires additional administrative access that ordinary chat credentials do not
provide. Quick Access and Providers Manager do not display a Cursor balance or
request an Admin token, and no background budget requests are made.
Check billing in the Cursor dashboard. Chat keys, models, context settings and
per-request token metrics continue to work independently of billing access.

### Cursor official API

`https://api.cursor.com/v1` supplies the [Cursor model catalog](https://cursor.com/docs/cloud-agent/api/endpoints).
Choose the **Cursor** preset or **Cursor SDK (VS Code tools)** API
format in Providers Manager. Existing profiles on `api.cursor.com` are detected
automatically and retain their saved key, profile ID and enable/disable control.
The profile discovers available models and their supported configuration values;
reported context windows feed the same working-context slider as other profiles.
When Cursor does not report a numeric maximum, the card labels the fallback.

When a model reports reasoning levels, **Thinking Effort** appears next to the
model in the native chat input. Values and defaults come from Cursor's catalog,
including variant-only metadata. The bridge translates the native
`reasoningEffort` option to Cursor's original parameter name (`effort`,
`reasoning_effort`, `thinking_level`, etc.) before starting the SDK run.
Models whose catalog has no supported reasoning levels do not show this picker.

Chat uses the official [Cursor TypeScript SDK](https://cursor.com/docs/sdk/typescript)
in local mode. Inference runs on Cursor's servers. Commands, edits, questions
and other actions use the tools supplied by Copilot Chat: the SDK callback waits
while VS Code displays and approves the tool call, then resumes with its result.
The SDK's built-in filesystem, shell and web tools are excluded. Project/user
configuration and external MCP servers are not loaded into this bridge.

The bridge instruction is included in the request text. It does not use the
SDK's `systemPrompt` override, which some Cursor runtimes reject as
`unknown option '--system-prompt'`. Failed runs report Cursor's original error
message and code, with credentials redacted, instead of only `status error`.

Cursor models advertise **Tools** and **Vision**, making them selectable in the
native Agent picker. The SDK requires Node.js 22.13 or newer in the extension
host and its supported platform package (Windows x64, Linux/macOS x64 or arm64).
It loads only when Cursor is used; the JSONL store avoids a node:sqlite dependency.
On unsupported hosts the Cloud Agents transport remains a chat-only fallback
and the models do not advertise Tools. Cancelling stops the active SDK run;
profile/key changes and stale tool results cannot resume another conversation.
Compatible gateways remain ordinary OpenAI-compatible profiles. There is no
separate Cursor enable setting or key store.

Cursor SDK sessions stay warm between user messages and restore completed
native checkpoints after reload, using an atomic disk binding in addition to
workspaceState. Interrupted follow-ups retain the prior completed checkpoint.
Native resume failure preserves that checkpoint and sends no inference request;
it never silently starts a full-history replay. The shared visible Chat journal supports switching
from Codex/Coco/Claude and returning to Cursor with foreign turns retained.
Automatic multi-prompt history imports are disabled. Each user request starts
one SDK run; native model/tool iterations can still occur within it. Unmatched
history branches stop before inference and preserve the completed session.
New sessions replay at most 64,000 history characters by default, controlled by
`llamacpp.cursorMaxColdHistoryChars`; larger cold transfers stop before inference
and retain a full archive. Warm/restored deltas do not use that cold budget.
`llamacpp.cursorMaxHistoryImportParts` is deprecated and ignored. The Cloud
fallback rejects oversized history explicitly instead of dropping early messages.
Native SDK cache read/write counters feed profile metrics and diagnostics,
independently of billing permissions. See [Cursor continuity](CURSOR_CONTINUITY.md)
for storage, verification and finite-context limitations.

The API format and model family are deliberately separate. For example, a
DeepSeek model routed through OpenRouter normally uses:

- API format: **OpenAI-compatible**
- Model family: **DeepSeek**

This keeps the gateway payload standard while retaining DeepSeek-specific
context and output behavior.

## Endpoint Rules

The manager accepts `http://` and `https://` URLs. Credentials, query strings,
and fragments are rejected. Versioned roots are supported directly:

- `https://api.openai.com/v1`
- `https://openrouter.ai/api/v1`
- `https://company.example/openai/v1`

When the URL already ends in a version segment, AI Agent Bridge appends
`/models` and `/chat/completions` directly. Otherwise it inserts `/v1`.
The official DeepSeek host keeps its native endpoint layout.

## Storage and Isolation

Profile metadata is stored in extension `globalState`, so the same list is
available across VS Code workspaces. API keys use one SecretStorage entry per
profile.

The manager receives only a `hasApiKey` flag. It never reads a saved secret
back into HTML or JavaScript. Editing a profile with an empty key field preserves
its current key; the explicit **Delete saved API key** option removes it.
Deleting a profile removes both metadata and its SecretStorage entry.

Every profile has a stable source ID. Model catalogs, runtime context probes,
and in-flight discovery are keyed by that ID as well as endpoint information,
so two accounts on the same gateway do not share extension caches.

## Compatibility

The current custom profile path targets services that implement:

- `GET /models` in OpenAI-compatible shape;
- streaming `POST /chat/completions`;
- optional `Authorization: Bearer …`.

The **OpenAI-compatible** format omits llama.cpp-only fields such as
`cache_prompt`, `chat_template_kwargs`, and `thinking_budget_tokens`.
The **DeepSeek native** and **llama.cpp** formats retain their provider-specific
payloads.

Azure deployment URLs and `api-key` headers, arbitrary custom headers,
non-streaming-only APIs, and endpoints without model discovery are not yet
represented by the generic profile schema.
