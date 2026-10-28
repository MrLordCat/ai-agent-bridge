# AI Agent Bridge 1.20.2

The first patch release. Patch releases are now published like stable ones,
and the updater offers them. This release also makes the Codex window known
before the first turn, lets the shared context follow it, fixes failing update
checks and keeps screenshots out of saved chat sessions (1.20.1).

## Codex context window

- Codex models have different windows: 475K for gpt-6.1-sol and
  gpt-6.1-terra, 258.4K for the others. The window now comes from Codex's own
  model catalog (`models_cache.json`, context_window × effective percent), so
  it is right immediately after a reload. Before, the 258.4K fallback was
  advertised until the first turn, and Copilot compacted to the smaller budget.
  A value Codex reports during a turn still takes precedence.
- New `llamacpp.sharedContextFollowCodex`, off by default, with a toggle in
  Provider Context. With it on, the shared context for Codex, Claude, Coco and
  Cursor is the window of the last used Codex model. It grows when that window
  is larger and shrinks after switching to a smaller model. The slider value is
  kept for when the toggle is off. A window change rewrites the Claude and Coco
  prompt caches once, as moving the slider does.
- Provider Context lists each Codex model with its window and source and shows
  the largest Codex window.

## Updates

- Patch releases such as this one are offered by the updater.
- The automatic check runs at most every 5 hours (was 6). When GitHub cannot be
  reached, for example right after the computer wakes up, it retries after
  30 minutes. Before, such a check showed a bare `fetch failed` in Last Check
  until the next check 6 hours later; the error now names the network cause.
- A manual check asks GitHub at most once every 5 minutes. Within that time it
  shows the last result and when the next check is possible.

## Release retention

- After each publication the workflow deletes old releases with their tags.
  x.y.0 of the three newest lines (1.20, 1.19, 1.18) and the two newest patches
  of the newest line stay; a new x.y.0 removes the patches of the previous line.
  `npm run prune:local` applies the same rule to local VSIX files and tags.

## Screenshots in saved chat sessions (1.20.1)

- Copilot patch v28: screenshots no longer make a chat fail with
  `Invalid string length`. Copilot saved each `view_image` result in the turn
  metadata with its full bytes; one chat reached 632 MB. The saved copy now
  replaces image and binary tool data above 64 KB with a short note. The
  running request still sees the image.
- A Copilot bundle with any older patch version is upgraded from its backup.
  Before, v28 failed with "Backup already exists" and the bundle kept v27.

## Boundaries and verification

- Windows: 840 extension-host tests passed on the installed VS Code (14
  platform or opt-in skips), together with compile, lint and metadata checks
  and the retention script tests. Release CI repeats metadata checks, lint and
  tests on Windows and Linux before packaging and publication.

## Install from VSIX

Installations of 1.20.0 or newer are offered this release by the updater.
To install it manually, download the package matching your platform:

```sh
# Windows x64
code --install-extension llama-vscode-chat-v1.20.2-win32-x64.vsix --force
# Linux x64
code --install-extension llama-vscode-chat-v1.20.2-linux-x64.vsix --force
```

Run **Developer: Reload Window**. Existing profiles and chat keys are retained.
Compatible Chat, terminal and agent-host patches apply on startup; reload again
if a patch notification asks for it.
