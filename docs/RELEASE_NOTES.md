# AI Agent Bridge 1.17.3

Snowflake Cortex Code (Coco) now works in native VS Code Chat with visible,
controllable tools and terminals. Linux desktop installations can apply the
required patches using a user-owned copy of VS Code, without root, or explicitly
authorize patching the current system installation. This release replaces
the withdrawn 1.17.0 release and includes its Coco features with Linux fixes.

## Coco in native Chat

- Models and supported reasoning choices come from the active ACP session.
  Thinking streams into Chat, and image input is enabled when ACP advertises it.
- Native Chat owns tool execution and approvals. Commands use interactive VS
  Code terminals that reuse idle shells and preserve state. Users can type,
  interrupt commands or close the actual terminal.
- Quick Access exposes Coco status, connection, refresh and reasoning controls.
  Connection checks have a deadline and can be cancelled.
- Context usage comes from ACP usage snapshots and the runtime context window,
  including across tool-result continuations.
- Azure OAuth uses the configured Snowflake CLI connection and its credential
  cache; credentials are not copied from the Snowflake extension.

## Install from VSIX

Download the package for your platform from this release:

```sh
# Windows x64
code --install-extension llama-vscode-chat-v1.17.3-win32-x64.vsix
# Linux x64
code --install-extension llama-vscode-chat-v1.17.3-linux-x64.vsix
```

Run **Developer: Reload Window**. Compatible Copilot Chat, terminal and agent-host
patches apply on extension startup; reload again after a patch notification.
External installer scripts and the repository patch wrapper have been removed.

For Linux with a system-owned VS Code installation, run
**AI Agent Bridge: Prepare User VS Code (Linux, no root)**. Open **AI Agent Bridge
Code** from the application menu or use `~/.local/bin/code-ai-agent-bridge`.
The copy lives under your home and uses a separate profile. Configure accounts
and settings in that profile. System files remain unchanged; repeating the
command for the same build preserves existing patches.

Alternatively, choose **Apply patches with administrator rights** in the
permission notification. The extension requests graphical authorization first.
When it is unavailable, **Run sudo in Terminal** or **Run su in Terminal** uses
the installed command. Enter your user's password for sudo or root's password
for su directly in the visible terminal; Debian does not need sudo installed.

After a failed password entry, **Apply Patch** in Quick Access reopens the retained
terminal and offers **Retry in Terminal** or **Close Attempt** for a fresh
workflow. Commands wait for shell integration, and an active password prompt
does not receive duplicate commands. Backups and syntax checks also work when
the application is read-only.

Native capabilities are detected before patching. Unknown bundle layouts and
read-only files remain visible in patch status. Remote SSH/WSL/container windows
need the desktop application prepared locally.

## Audit and verification

- Hardened ACP parsing and request handling, including string IDs, fragmented
  replies, malformed messages, process shutdown and synchronous handler errors.
- Updated dependency fixes and the VSIX packager; npm audit reports zero known
  vulnerabilities on 2026-10-10.
- Platform-specific Windows/Linux builds and tests gate publication.
- Debian verification covers ordinary VSIX installation, automatic patches,
  root-owned files, migration without root, and real bash terminal control on
  VS Code 1.131 and 1.141 as UID 1000. Administrator apply/restore is checked
  through real su commands; failed-command retry is checked in the same real
  bash shell on both versions.
- Local suites passed 596 Windows tests and 601 Linux tests, with platform
  skips. Interactive password entry was verified manually by the GUI tester.
- Paid provider authentication and generation are not exercised in the Debian
  fixture. See `docs/DEBIAN_VERIFICATION.md` for the tested scope.
