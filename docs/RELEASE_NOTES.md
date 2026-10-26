# AI Agent Bridge 1.20.0

The extension now updates itself from GitHub releases. This stable release also
fixes three failures in long, tool-heavy chats. It consolidates the
1.19.1–1.19.4 development patches.

## Updates from GitHub releases

- The extension checks the latest stable release one minute after startup and
  then every 6 hours. `llamacpp.autoUpdate` is `notify` (default: offer the
  update), `install` (download, verify, install and offer a reload) or `off`
  (manual checks only).
- Only a version newer than the installed one is offered, so a local
  development build is never replaced by an older release.
- The VSIX for the current platform is downloaded only from this repository's
  releases. It is installed only when its size and SHA-256 digest match the
  release. Several windows show one notification per version, and only one
  window installs at a time.
- Quick Access has a new **AI Agent Bridge** group: Current Version, Last Check
  (time and latest release, or the failure reason), Check for Updates, Install
  Update or Reload Window, and Automatic Updates. The same actions are
  available as commands.

## Fixes for long chats

- **Claude follow-up messages.** Claude received the first message of the chat
  on every follow-up turn and answered that it had arrived again. Copilot adds
  about 16K characters of skills and instructions context to each follow-up
  request, and a size rule skipped those requests. A real chat turn
  (`<userRequest>`) is now always sent.
- **Long autonomous requests (Codex, Coco, Cursor).** A request that ran for
  hundreds of tool rounds failed with "The current request and required
  instructions exceed the shared context budget" on retry or after an error.
  Only the request message is pinned now. The newest steps that fit are kept
  as they are, and the older steps of the same request become a summary.
- **Screenshot-heavy transcripts.** Screenshots in tool results were stored
  inline in the shared transcript in addition to their `assets/` file. A few
  large screenshots filled the 64 MiB limit and the next round failed with
  "Cannot save the incoming Chat transcript". The transcript now references
  each image by its asset file. Older transcripts are rewritten on their next
  save. The save error now names its cause.

## Boundaries and verification

- Automatic updates start with this version. Installations of 1.19.0 or older
  need this release installed manually once.
- Windows: 834 extension-host tests passed on VS Code 1.131 (12 platform or
  opt-in skips), together with compile, lint, metadata and unused-locals
  checks. Release CI repeats metadata checks, lint and tests on Windows and
  Linux with VS Code 1.131 and 1.141 before packaging and publication.

## Install from VSIX

Download the package matching your platform from this release:

```sh
# Windows x64
code --install-extension llama-vscode-chat-v1.20.0-win32-x64.vsix --force
# Linux x64
code --install-extension llama-vscode-chat-v1.20.0-linux-x64.vsix --force
```

Run **Developer: Reload Window**. Existing profiles and chat keys are retained.
Compatible Chat, terminal and agent-host patches apply on startup; reload again
if a patch notification asks for it. Native capabilities are detected first.
For a system-owned Linux installation, use **Prepare User VS Code (Linux,
no root)** or the existing administrator-authorization flow. Remote
SSH/WSL/container windows still need the desktop application prepared locally.
