# AI Agent Bridge 1.18.0

Cursor and Snowflake Coco now retain available Chat history across provider
switches and window reloads, with native token/cache metrics in diagnostics.
This stable release consolidates the work since 1.17.3, including a shared
provider infrastructure, model navigation and a more responsive Quick Access.

## Cursor in native Agent Chat

- Configure Cursor through its existing Providers Manager profile and saved
  chat key. Models advertise Tools and Vision; supported Thinking Effort
  choices, model parameters and context limits come from Cursor's catalog.
- The official local SDK delegates commands, file access, edits and questions
  to native VS Code callback tools and approvals. Built-in Cursor execution,
  external MCP servers and project/user SDK settings are excluded.
- Reuse agents between messages and restore completed native checkpoints
  after reload. If restoration fails, rebuild from the full available history.
- Read input/output and cache read/write counters directly from SDK run usage.
  Attribute metrics to the saved API profile and API usage history.
- Remove Cursor balance/budget controls and Admin API requests. An Admin token
  is not needed for chat or per-request token/cache metrics.

## Coco and cross-provider context

- Keep native ACP sessions warm and restore compatible completed sessions.
  Returning after another provider adds its new visible messages and tool
  results without replaying completed actions.
- Keep a shared workspace-local journal of visible Chat messages. It can
  recover earlier details that Chat has stopped including in later requests,
  provided the extension received those details before.
- Import large histories in bounded requests with tools disabled, preserving
  all transferred text and image bytes. Archive large tool outputs in full;
  expose the archive path so VS Code file/search tools can recover exact details.
- Report native Coco prompt usage/cache counters independently of context
  occupancy. Use a verified 1M initial window for the exact Opus 5.5 model ID;
  observed runtime windows take precedence over configured baselines.
- Isolate conversations, profiles and credentials; reject stale tool results
  after cancellation and keep incomplete native runs out of durable checkpoints.

## Models, Quick Access and diagnostics

- Select a provider first in **Models by Provider**, then choose one of its
  models. Existing native IDs, profile identities and model settings remain.
- Discover API context maxima automatically and choose a separate working
  context using the Providers Manager slider.
- Render consistent provider snapshots and per-profile metrics. Supported
  balances load in the background without blocking the Quick Access tree.
- Distinguish Cursor/Coco sessions in Session Diagnostics and separate fresh
  input, cache reads and cache creation. Missing native counters stay unreported.
- Stream Codex reasoning and live context updates; keep the native VS Code
  question tool immediately available for clarification.

## Boundaries and verification

- Model windows remain finite and native compaction still applies. Archived
  history is recoverable through tools; it is not all simultaneously present
  in model attention. Hidden reasoning and content never supplied to this
  extension cannot be reconstructed. Server caches do not transfer providers.
- Cold imports may consume additional model usage. The Coco and Cursor
  `MaxHistoryImportParts` settings default to 16. Oversized transfers stop
  explicitly with a complete local archive; Cursor's chat-only Cloud fallback
  rejects overflow instead of silently discarding early history.
- Journals, native stores and archives live in VS Code workspace storage,
  not the repository. They contain local copies of visible chat content;
  deleting workspace storage removes those copies. Archive cleanup is manual.
- Windows regression suites passed 703 tests on VS Code 1.131 and 701 on
  VS Code 1.141 before release preparation, with conditional/platform skips.
  Metadata checks, lint and tests on Windows/Linux with both VS Code versions
  gate the platform packages and GitHub publication.
- Real Coco Opus 5.5 cold/warm/restored requests retained synthetic facts and
  reported native cache counters. Installed Cursor SDK create/resume is
  verified without inference; paid Cursor generation remains an opt-in test.
  See [Coco continuity](https://github.com/MrLordCat/ai-agent-bridge/blob/v1.18.0/docs/COCO_CONTINUITY.md) and
  [Cursor continuity](https://github.com/MrLordCat/ai-agent-bridge/blob/v1.18.0/docs/CURSOR_CONTINUITY.md)
  for exact evidence and limits.

## Install from VSIX

Download the package matching your platform from this release:

```sh
# Windows x64
code --install-extension llama-vscode-chat-v1.18.0-win32-x64.vsix --force
# Linux x64
code --install-extension llama-vscode-chat-v1.18.0-linux-x64.vsix --force
```

Run **Developer: Reload Window**. Existing profiles and chat keys are retained.
Compatible Chat, terminal and agent-host patches apply on startup; reload again
if a patch notification asks for it. Native capabilities are detected first.
For a system-owned Linux installation, use **Prepare User VS Code (Linux,
no root)** or the existing administrator-authorization flow. Remote
SSH/WSL/container windows still need the desktop application prepared locally.
