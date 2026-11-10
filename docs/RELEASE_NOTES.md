# AI Agent Bridge 1.21.0

A stable release that consolidates the 1.20.13–1.20.23 patches: several
ChatGPT subscriptions side by side, Codex turns that survive a prompt sent
mid-flow, subscription statistics from complete windows only, and safer
VS Code patches.

## Several ChatGPT subscriptions

- `llamacpp.codexAccounts` adds extra ChatGPT accounts. Each one gets its own
  `CODEX_HOME` (default `~/.codex-<id>`), app-server process, file-based login,
  native threads and usage windows, so two plans never mix. The built-in
  account keeps `~/.codex` and the existing `codex::<model>` ids.
- Quick Access → Codex → **ChatGPT Accounts** adds, switches, signs in, signs
  out and removes accounts; a new account signs in by itself after the reload.
  `llamacpp.codexShowAllAccounts` lists every account's models at once.
- Codex sign-in no longer needs the official Codex extension; any Codex CLI can
  be used through `llamacpp.codexCliPath`.

## Codex during an active agent flow

- A prompt sent while a native VS Code tool is running reaches Codex. It used to
  resume the old turn with only the tool result and drop the prompt; the turn
  is now interrupted and the same thread continues with the result and the
  prompt as one new user turn.
- A tool result of an interrupted turn left deep in the chat history no longer
  rejects later requests with "belongs to an interrupted Codex turn" until a
  window reload. Only the current round is checked.
- A reset ChatGPT window no longer keeps answering "limit reached": the gate
  follows Codex's own window numbers, and limits read from error text are
  verified before a request is refused.
- Codex error notifications log their real message; errors Codex retries
  itself are warnings, and "no active turn to interrupt" is no longer an error.

## Subscriptions tab

- Every request counts in the provider window it ran in, a window spanning its
  reset time minus 5 hours or 7 days. Requests after a reset no longer land in
  the old window, and a Codex window that restarts right after a weekly 100%
  takes back its own start instead of being split into two rows.
- Finished windows and the capacity median keep only windows tracked from
  start to end. A window first seen already in use, or one that kept rising
  without requests from this extension, is shown while it runs, marked partial,
  and never saved.
- Codex records the tokens of failed and cancelled turns, including the turn
  that runs into the usage limit, which every exhausted window used to miss.

## Patches and settings

- The Copilot chat-history, workbench terminal and agent-host patches write
  through a temporary file and a rename, take one cross-window lock, are
  syntax-checked before writing, and restore in place: restoring one patch no
  longer drops another, and an outdated backup is never copied over a newer
  file.
- `codexCliPath`, `claudeCliPath`, `cocoCliPath` and `codexAccounts` are
  machine-scoped, so a workspace cannot choose the executable the extension
  starts.

## Other fixes

- Subagents on bridge models work again: `runSubagent.model` lists the
  qualified `Name (llamacpp)` labels VS Code resolves.
- Links in answers open: attachment placeholders and Windows paths quoted by a
  model become `file:` links, and links to missing files become code spans.
- Coco reuses its idle terminal and changes directory in it instead of opening
  a terminal per command, and only `cd`s into safe existing directories.
- Long chats keep only the newest 100 images in the shared transcript
  (`llamacpp.journalImageRetention`), so reloading them is fast again.
- Quick Access is tidier: Claude limits show the reset on its own row, and
  duplicated rows are merged.

## Verification

- 964 extension-host tests passed on the installed VS Code, together with
  compile, lint and metadata checks. Release CI repeats metadata checks, lint
  and tests on Windows and Linux with VS Code 1.131 and 1.141 before packaging
  and publication.

## Install from VSIX

Installations of 1.20.0 or newer are offered this release by the updater.
To install it manually, download the package matching your platform:

```sh
# Windows x64
code --install-extension llama-vscode-chat-v1.21.0-win32-x64.vsix --force
# Linux x64
code --install-extension llama-vscode-chat-v1.21.0-linux-x64.vsix --force
```
