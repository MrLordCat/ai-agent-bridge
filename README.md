# Local LLM Chat Provider for VS Code

**One Copilot Chat workflow for local LLMs, DeepSeek, Codex, and Claude subscriptions.**

A single VS Code extension that adds local models, DeepSeek, Codex (ChatGPT),
and Claude (Agent SDK) to the native Copilot Chat model picker. Switch models
mid-conversation without changing extensions or global endpoints — all sources
share the same agent tools, approvals, history, and diagnostics.

Originally a fork of a llama.cpp provider, now an independent product.
The `llamacpp.*` settings and vendor namespace are retained for compatibility.

## Key Design Decisions

**Native tools only, no backdoors.** Codex and Claude built-in actions (shell,
files, web, MCP, browser, plugins, subagents) are disabled. Every action must
return through Copilot's native VS Code tool cards with the current approval
mode. The extension cannot access Codex or Claude credential files.

**Prompt-cache prefix stability as a first-class concern.** Local and DeepSeek
canonicalize tool order, JSON Schema key order, reasoning injection, and system
prompt placement so the upstream KV-cache prefix survives turn-to-turn and even
VS Code reloads. DeepSeek reasoning is persisted to `globalState` and restored
by exact `callId` match — a reload no longer causes a cache miss on every
historical tool-call message.

**Durable subscription sessions survive reloads.** Codex threads and Claude
Agent SDK sessions are stored in `workspaceState`, reattached on startup, and
keyed by a stable Copilot conversation identity. Incremental input is sent
instead of re-materialising the full history.

**Budget-tier subagent routing at schema level.** The `runSubagent` tool
requires an explicit `model` field drawn from the advertised catalog. Local
models (Qwen, free/unlimited) are preferred for narrow verifiable tasks;
DeepSeek for focused reasoning; premium subscriptions only when necessary.
GPT-5.6 Sol is excluded from subagent use to conserve quota.

**Fail-closed everywhere.** Codex fails closed on internal actions outside the
tool loop. Claude MCP is allowlisted to `mcp__vscode__*` only. The Copilot
patch validates bundles, creates restorable backups, and refuses incompatible
VS Code builds.

**One patch for native controls.** The stable provider API doesn't expose
Thinking Effort, provider-owned context budgets, or conversation identity.
A guarded fail-closed Copilot Chat patch adds these controls. Patch v9 also
bounds terminal and tool payloads before VS Code stores them in chat history.

## Working Scenarios

These scenarios reflect the actual multi-model workflow the extension enables:

### DeepSeek V4 Pro delegates vision to local Qwen 3.6

DeepSeek has no vision support. When it encounters a screenshot or UI capture:

1. DeepSeek recognises it cannot analyse the image and calls `runSubagent` with
   `model="Qwen3.6-27B-Q4_K_M.gguf (Local)"` and the `view_image` task.
2. Qwen opens the image locally, inspects layouts, elements, colours, and text,
   then returns a structured description.
3. DeepSeek continues reasoning with the visual context it received from Qwen.

No subscription tokens are consumed for vision — the free local model handles it.

### Local Qwen delegates reasoning to DeepSeek V4 Pro

Qwen is fast and unlimited, but weaker on multi-step reasoning:

1. Qwen identifies a cross-file refactoring task it cannot complete reliably.
2. It spawns `runSubagent` with `model="deepseek-v4-pro (DeepSeek)"`, targeting
   a specific set of files and a bounded goal.
3. DeepSeek analyses the codebase, plans the change, reports back.
4. Qwen applies the edits and verifies with `get_errors` and test runs.

Budget tokens are burned only on the reasoning step — the mechanical work stays local.

### Large Unity project: Codex for architecture, Qwen for mechanical edits

1. Codex (GPT-5.6 Luna) analyses the project structure, proposes an architecture
   change, and delegates each file edit to Qwen subagents.
2. Qwen performs `replace_string_in_file`, `get_errors`, `list_dir` — unlimited
   tokens, no rate limits.
3. Codex reviews the consolidated results and continues the high-level plan.

### Claude Opus 5 for security audit, durable session across reloads

1. Claude runs a thorough security audit on the repository with full native
   tool access (files, grep, terminal).
2. VS Code is reloaded (extension update, crash, or explicit restart).
3. The Claude Agent SDK session is reattached from `workspaceState`. Only the
   new user message is sent — the full transcript is not replayed.
4. Claude continues as if the chat was never interrupted.

### Long chat recovery: roll over into a clean transcript

When a chat grows too large for VS Code's renderer-to-extension-host RPC:

1. Run `Local LLM: Continue Latest Codex Thread in New Chat` (or Claude equivalent).
2. A fresh lightweight chat opens with just the new user message.
3. The completed Codex thread / Claude SDK session is reattached — the model
   retains full conversation context without the bloated VS Code transcript.

### Multi-model task: DeepSeek plans, Qwen executes, Claude reviews

1. DeepSeek analyses a feature request and produces a task breakdown.
2. Qwen subagents execute file edits, terminal commands, and tests in parallel.
3. Claude performs a final review pass — security, edge cases, API consistency.

## Model Sources

| Source | Models | Best For |
|---|---|---|
| Local llama.cpp / Qwen | Qwen 3.6 27B, any GGUF | Free, unlimited tokens. Narrow verifiable tasks, vision inspection, file/grep reads, terminal I/O, subagent execution. |
| DeepSeek API | DeepSeek V4 Pro | Budget API. Multi-step reasoning, cross-file analysis, architecture decisions, reasoning-heavy subagent. |
| Codex (ChatGPT subscription) | GPT-5.6 Luna, Terra, Sol | Premium subscription. General coding, single-file edits, code review. Sol for complex refactoring (not subagent-eligible). |
| Claude (Agent SDK) | Claude Opus 5 | Premium subscription. Security audits, high-stakes analysis, complex implementation review. |

All sources appear together in the native picker — `(Local)`, `(DeepSeek)`, `(Codex)`, `(Claude)`.
Internal prefixes route requests, never sent upstream.

## Quick Start

Open `Local LLM: Open Sidebar`, configure sources, refresh models, pick from the Copilot Chat picker.

**Local:** Start `llama-server`, set URL via `Local LLM: Set Local Server URL`.
**DeepSeek:** `Local LLM: Configure DeepSeek` → enter API key → refresh.
**Codex:** Install Codex CLI, `codex login`, `Local LLM: Sign In to Codex Subscription`.
**Claude:** Install Claude Code CLI, sign in, `Local LLM: Sign In to Claude Subscription`.

## Important Commands

| Command | Purpose |
|---|---|
| `Local LLM: Open Sidebar` | Quick Access with connections, behavior, memory, diagnostics |
| `Local LLM: Refresh Models` | Refresh every enabled source |
| `Local LLM: Configure DeepSeek` | Store DeepSeek API key |
| `Local LLM: Sign In to Codex Subscription` | Authenticate Codex app-server |
| `Local LLM: Sign In to Claude Subscription` | Authenticate Claude Code runtime |
| `Local LLM: Continue Latest Codex Thread in New Chat` | Resume durable Codex thread in clean transcript |
| `Local LLM: Continue Latest Claude Session in New Chat` | Resume durable Claude session in clean transcript |
| `Local LLM: Run Provider Health Check` | Probe all sources and runtime features |
| `Local LLM: Open Session Quality Report` | Cache hits, latency, context, tool metrics |
| `Local LLM: Open Shared Memory` | Inspect/edit durable shared memory |
| `Local LLM: Apply Copilot Chat Patch` | Enable native Thinking Effort, context budgets, session resume |
| `Local LLM: Restore Original Copilot Chat` | Restore exact pre-patch bundle backup |

All settings: `llamacpp.*`. Use Quick Access or `Local LLM: Open Settings`.

## Documentation

| Document | Contents |
|---|---|
| [Architecture](docs/ARCHITECTURE.md) | Runtime boundaries, request flow, invariants |
| [Codex Subscription](docs/CODEX_SUBSCRIPTION.md) | Authentication, app-server flow, security model |
| [Copilot Chat Integration](docs/COPILOT_PATCH.md) | Patch mechanics, auto-update, fail-closed guarantees |
| [Tokens, Reasoning, and Cache](docs/TOKENS_REASONING_CACHE.md) | Context budgets, thinking modes, cache behaviour |
| [Shared Memory](docs/MEMORY.md) | Scopes, retrieval, persistence, Agent tools |
| [Reliability and Diagnostics](docs/RELIABILITY_DIAGNOSTICS.md) | Tool validation, health checks, session reports |
| [Agent Tools Guide](docs/AGENT_TOOLS_GUIDE.md) | Compact CLI workflows for agent sessions |
| [Knowledge Verification](docs/KNOWLEDGE_VERIFICATION.md) | Source policy, cache-stable instructions |
| [Project Audit](docs/AUDIT.md) | Quality gates, refactoring status, residual risks |

## Development

```sh
npm install
npm run compile
npm test              # 253 extension-host tests
npm run package       # → llama-vscode-chat-{version}.vsix
code --install-extension ./llama-vscode-chat-{version}.vsix
```

The independent extension id is `mrlordcat.llama-vscode-chat`.

## License

[MIT](LICENSE)

## References

- [llama.cpp](https://github.com/ggerganov/llama.cpp)
- [DeepSeek API](https://api-docs.deepseek.com/)
- [VS Code Extension API](https://code.visualstudio.com/api)
