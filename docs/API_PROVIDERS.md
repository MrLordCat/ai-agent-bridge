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
| Context length | Advertised model context when the endpoint does not provide a usable runtime value |
| Enabled | Adds or removes the profile from discovery without deleting it |
| API key | Optional Bearer token stored only in VS Code SecretStorage |

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
