# AI Agent Bridge 1.14.3 — release notes

Centralized provider management. All model sources now live in one control
surface, Quick Access reacts to real availability instead of static config
flags, and every provider explains why it is offline.

## 1. Providers Manager — one place for every source

The former "Manage API Providers" panel is now the **Providers Manager** and
manages everything:

- **Local LLM** — enable/disable, endpoint, model refresh, live
  online/offline status.
- **DeepSeek** — enable/disable, API key, context sliders, AI compaction
  summaries, plus live balance and peak/off-peak billing state.
- **Codex** — enable/disable, sign in, account status, subscription usage
  percent and reset time.
- **Claude** — enable/disable, sign in, account status, subscription limits.
- **Custom API profiles** — unchanged add/edit/delete/toggle/key workflow.

Buttons execute the same registered `llamacpp.*` commands as Quick Access
(unknown command ids are rejected), so behavior is identical everywhere. The
panel re-renders on directory changes, subscription status changes, and the
60-second usage timer — balance, usage, and limits stay current while open.

## 2. Provider directory — one status model

A new `ProviderDirectory` service knows every source and its state:
`checking / off / unconfigured / online / offline / paused`.

- HTTP sources (Local, DeepSeek, custom APIs) are probed with a lightweight
  `GET /models` every 5 minutes (5s timeout, TTL-guarded).
- Codex and Claude states come from their providers' own periodic refresh.
- Probe results are bound to the endpoint, so changing a URL resets the
  status instead of showing a stale result.

## 3. Quick Access is dynamic

A provider that is enabled but unreachable disappears from Quick Access and
reappears automatically as soon as the probe sees it online again. Disabled
and unconfigured sources stay visible, so nothing can silently vanish from
the user's mental model. The offline reason is always visible in the
Providers Manager.

## Verification

- 408 extension-host tests passing (VS Code 1.131, Windows).
- Lint and TypeScript compilation clean.
- GitHub Actions CI and Release workflows green for this tag.
