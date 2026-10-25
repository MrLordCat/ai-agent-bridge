# AI Agent Bridge 1.19.0

Long agent chats stay fast without starting new sessions, and Codex, Claude,
Coco and Cursor share one working context. This stable release consolidates
the work since 1.18.0, including the 1.18.1 and 1.18.2 patch releases.

## Long chats

- Copilot patch v27: for a chat backed by the shared workspace transcript,
  Copilot renders only the newest 12 tool rounds and 8 previous turns
  (`llamacpp.journalRenderRounds`, `llamacpp.journalRenderTurns`). The
  extension restores the full history from the transcript, so the model still
  receives every turn. In a chat with about 2,400 tool rounds, Copilot's
  per-step render cost fell from about 35 s of extension-host CPU to 0.7–1.6 s
  between tool rounds. Subagents and chats without a transcript keep
  `agentHistoryRounds`/`agentHistoryTurns`.
- The transcript merge keeps saved turns when Copilot drops middle turns from
  its render; only a request missing from the stored order counts as an edit.
- Patch v26: a subagent no longer replaces Copilot's main-agent model, which
  made VS Code re-read every provider catalog on each parent/subagent switch.
  Catalog bursts, Quick Access rebuilds and patch status checks no longer
  block the extension host.

## Shared working context

- `sharedContextLength` drives Codex, Claude, Coco and Cursor, so switching
  provider after a rate limit keeps the same history budget. Each provider
  advertises min(limit, real model window) and passes the limit to its own
  auto-compaction.
- Every provider receives the same workspace journal before routing. One
  token-budget handoff planner prepares native Codex, Coco and Cursor sessions;
  large histories are archived in full instead of being cut silently.
- Subagents run without the parent chat's conversation id: they cannot cancel
  its pending tool turn, take over its native session or overwrite its journal.

## Providers

- **Codex:** VS Code tools no longer trigger repeated full-context `wait`
  polls (34–46% of model calls in measured rollouts). Rollout metrics read only
  the finished turn; usage-limit and capacity failures are final; after an
  app-server restart only the matching thread is resumed.
- **Claude:** Opus 5.5 through the official Claude Code runtime. Cache
  keep-alive now runs while idle: usage is refreshed from the live session at
  no model cost, the interval stays inside the 1-hour cache TTL, and it stops
  after `llamacpp.claudeCacheKeepAliveMaxIdleMs` (2 hours by default).
  Keep-alive remains optional.
- **Cursor:** an indexed native store starts a long chat in seconds instead of
  minutes. Bindings persist across reload; a failed or interrupted run
  continues without re-executing completed tools or replaying history.
- **Coco:** callback tools run through native ACP sessions, so long tool waits
  no longer expire. Tool names fit the 64-character limit, `tool_search` is
  allowed, reasoning-only turns are continued instead of returned empty, and
  large handoffs are prepared locally with complete archives.

## Copilot patches and saved sessions

- Stored tool results are bounded, so saved sessions no longer grow past the
  V8 string limit; `scripts/repair-chat-sessions.cjs` repairs an existing one.
- MCP tools with tuple schemas (`prefixItems` without `items`) no longer fail
  the whole chat.
- Patch backups are written only from an unpatched bundle, serialised across
  windows, and a contaminated backup is reported and refused.

## Boundaries and verification

- Model windows remain finite and native compaction still applies. Server
  caches do not transfer between providers. Claude cache keep-alive consumes
  subscription usage while it runs and does not survive a window reload.
- Windows: 824 extension-host tests passed on VS Code 1.131 (12 platform or
  opt-in skips). Linux (Arch on WSL, Xvfb): 828 passed (8 skips), together
  with compile, lint, metadata and unused-locals checks. Release CI repeats
  metadata checks, lint and tests on Windows/Linux with VS Code 1.131 and
  1.141 before packaging and publication.

## Install from VSIX

Download the package matching your platform from this release:

```sh
# Windows x64
code --install-extension llama-vscode-chat-v1.19.0-win32-x64.vsix --force
# Linux x64
code --install-extension llama-vscode-chat-v1.19.0-linux-x64.vsix --force
```

Run **Developer: Reload Window**. Existing profiles and chat keys are retained.
Compatible Chat, terminal and agent-host patches apply on startup; reload again
if a patch notification asks for it. Native capabilities are detected first.
For a system-owned Linux installation, use **Prepare User VS Code (Linux,
no root)** or the existing administrator-authorization flow. Remote
SSH/WSL/container windows still need the desktop application prepared locally.
