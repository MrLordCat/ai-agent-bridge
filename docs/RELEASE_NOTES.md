# AI Agent Bridge 1.20.3

A patch release: "Follow the Codex window" applies right away instead of
waiting for the first Codex request.

## Shared context follows Codex immediately

- With `llamacpp.sharedContextFollowCodex` on, the shared context stayed at
  the slider value until a Codex request in the current workspace, although
  Codex had already catalogued 475K for gpt-6.1-sol. Provider Context also
  showed the 258.4K fallback setting as the Codex window.
- Before the first request the shared context now follows Codex's default
  model, or the largest catalogued window while the model list is not loaded.
  After a request it follows the last used model, as before. A used model whose
  window is still unknown does not borrow another model's window, and the
  fallback setting never drives the limit.
- The last used Codex model is stored globally, like the shared context
  itself; the 1.20.2 per-workspace value is migrated.
- Provider Context names why a model is followed (last used, Codex default or
  largest known) and updates the followed window while the panel is open,
  without dropping unsaved edits. The toggle is saved with Apply.

## Boundaries and verification

- Windows: 843 extension-host tests passed on the installed VS Code (14
  platform or opt-in skips), together with compile, lint and metadata checks.
  Release CI repeats metadata checks, lint and tests on Windows and Linux
  before packaging and publication.

## Install from VSIX

Installations of 1.20.0 or newer are offered this release by the updater.
To install it manually, download the package matching your platform:

```sh
# Windows x64
code --install-extension llama-vscode-chat-v1.20.3-win32-x64.vsix --force
# Linux x64
code --install-extension llama-vscode-chat-v1.20.3-linux-x64.vsix --force
```

Run **Developer: Reload Window**. Existing profiles and chat keys are retained.
Compatible Chat, terminal and agent-host patches apply on startup; reload again
if a patch notification asks for it.
