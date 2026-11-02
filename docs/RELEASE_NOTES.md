# AI Agent Bridge 1.20.12

A patch release: subscription usage statistics for Codex and Claude, short
notices when a plan limit or a provider balance runs out, tools that appear
after a Codex thread started, and a cleaner Live Report.

## Subscriptions tab in the Live Report

- A new Subscriptions tab shows Codex and Claude token use per 5-hour and
  weekly limit window: input, cache misses, cache reads, cache writes, output,
  request counts, cache hit percentage and per-model totals.
- Each window starts at zero. When a window reaches 100% it is saved as a
  finished window and the next one starts empty, so a period never mixes usage
  from two windows. Windows that were already running when tracking began are
  marked partial, and a provider timestamp that only sometimes appears is not
  treated as a boundary.
- Only windows that really tracked tokens are kept. An idle provider reports
  0% with a reset time that moves every minute; those samples used to create a
  new one-minute window on every refresh. They are ignored now, so the
  finished list and the capacity estimate (how many tokens a plan window
  provides) use real periods only.
- The ledger lives in extension global storage, so every VS Code window of the
  profile writes to one history.

## One line instead of long errors and retries

- A Claude or Codex usage limit now answers with one English line, for example
  `Claude 5-hour limit reached. It resets at 16:00 EET (in 2 h 15 min). Wait
  for the reset, then send the message again. No retry was made.` The reset is
  read from the provider text (clock with its zone, ISO time or "try again at
  ..."), remembered per provider, and every request until the reset returns
  the same line without starting a provider turn, thread or fallback.
- An empty provider balance behaves the same way. HTTP 402 Payment Required
  and "insufficient balance" bodies (including DeepSeek's JSON error) become
  `DeepSeek balance is empty (Insufficient Balance). Top up the account, then
  send the message again. No retry was made.` The request finishes instead of
  failing, so the host does not repeat it five times. Context-length and
  rate-limit errors are not mistaken for a balance problem.

## Codex tools and editor behaviour

- Codex can use tools that appear after its thread started. Its dynamic tools
  are fixed at `thread/start`, and a reused thread kept only the tools it
  already had, so tools behind Copilot's `activate_*` groups (for example the
  Meshy MCP tools) were enabled in VS Code but never callable. A mid-turn
  activation continues in a new thread with the shared context; schema-only
  changes keep the warm thread.
- Diagnostics panels (Live Report, Providers Manager, Shared Memory) open as a
  tab in the current editor group instead of forcing a new group to the side.

## Earlier patches included

- 1.20.4–1.20.8: no Snowflake CoCo attribution in commits and files; a cold
  first turn after a model switch with a shared transcript; the
  `providerSwitchContextTokens` budget (default 250K) for every native
  provider; MCP tools with the `mcp__` prefix for Codex; interrupted tool
  rounds in HTTP chats; an append-only JSON Lines chat journal that is much
  faster on long chats; a 512 MiB transcript limit and unreferenced image
  pruning.
- 1.20.9: the repaired chat session keeps screenshots as valid placeholder
  images, so VS Code can load it.

## Verification

- 896 extension-host tests passed on the installed VS Code, together with
  compile, lint and metadata checks. Release CI repeats metadata checks, lint
  and tests before packaging and publication.

## Install from VSIX

Installations of 1.20.0 or newer are offered this release by the updater.
To install it manually, download the package matching your platform:

```sh
# Windows x64
code --install-extension llama-vscode-chat-v1.20.12-win32-x64.vsix --force
# Linux x64
code --install-extension llama-vscode-chat-v1.20.12-linux-x64.vsix --force
```

Run **Developer: Reload Window**. Existing profiles and chat keys are retained.
Compatible Chat, terminal and agent-host patches apply on startup; reload again
if a patch notification asks for it.
