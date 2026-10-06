# AI Agent Bridge 1.16.6 — release notes

A patch release on top of 1.16.5. Everything from 1.16.0 is included.

## 1. Patching no longer needs administrator rights

The previous releases looked for Copilot Chat in exactly one place: the
`extensions/copilot` folder of `vscode.env.appRoot`. That fails as soon as the
extension host is not the process that renders the window, and the error it
reports — `Could not locate the bundled Copilot Chat extension` — is misleading,
because Copilot Chat is usually installed and simply lives elsewhere:

- **Remote-WSL / SSH / containers.** `vscode.env.appRoot` is the Linux server
  (`~/.vscode-server/bin/<commit>`). It ships Copilot Chat, but it has no
  `out/vs/workbench/workbench.desktop.main.js` — the workbench runs on the
  client — and the old lookup required both next to each other, so the candidate
  was discarded and the message claimed Copilot Chat was missing.
- **Code - OSS and CachyOS.** Copilot Chat is a normal user extension in
  `~/.vscode-oss/extensions` or `~/.vscode/extensions`, outside any application
  root.

The patch code now searches the way VS Code actually installs things: the active
application root, the user extension directories, the Linux server of a remote
session, and — from WSL — the Windows installation under
`/mnt/c/Users/<you>/AppData/Local/Programs/Microsoft VS Code/<commit>`, matched
by the commit of the running server. Every copy found is patched, and each one
borrows the workbench of the window, because the server has none.

Verified on a real WSL session: two bundles found (the Linux server at
`~/.vscode-server/bin/<commit>/extensions/copilot` and the Windows installation
at `/mnt/c/.../Microsoft VS Code/<commit>/resources/app/extensions/copilot`),
each patched and restored byte-for-byte, **without any elevation**. The Windows
files under `/mnt/c` are owned by the user (User Installer), which is why this
works at all.

## 2. Parts are applied independently, and the log says what was searched

The Copilot Chat bundle and the VS Code workbench are now separate parts: if a
workbench is missing or read-only, it is reported as a `Notice:` in the status
output and the Copilot patch still applies. “Could not locate” is impossible
when the bundle was found, and a failure lists every application root and
extension directory that was checked in the `AI Agent Bridge Copilot Patch`
output channel.

## 3. Elevation is offered when it is genuinely needed

For a system-wide Linux installation (`/usr/share/code`, `/usr/lib/code`),
`AI Agent Bridge: Apply Copilot Chat Patch` now offers **Retry with
administrator rights**: the extension writes a small runner to the temp folder
and starts it through `pkexec` (policy-kit password dialog) or passwordless
`sudo`, then reloads. When neither is available it prints the exact command to
run. A WSL extension host cannot elevate into Windows and says so instead of
offering a broken retry.

## Install in one step

Download the VSIX and the installer script for your platform into one folder and
run the script:

```bash
# Linux (including CachyOS; also from a WSL terminal)
chmod +x install-ai-agent-bridge.sh
./install-ai-agent-bridge.sh
```

```bat
:: Windows
install-ai-agent-bridge.cmd
```

The script installs the extension and applies the patches in the same run with
the extension's own compiled patch code. `SKIP_PATCHES=1` installs only,
`DRY_RUN=1` prints what would happen, `VSCODE_APP_ROOT` and `VSCODE_EXTENSIONS_DIR`
describe custom layouts.

## Verification

- 513 extension-host tests passing, including the new search tests (WSL commit
  matching, user-extension installs, a server bundle without a workbench) and a
  patch/restore round trip with no workbench present.
- Lint and TypeScript compilation clean.
- The apply/restore round trip above was run on a real WSL session against both
  real bundles, using copies so the installed VS Code stayed untouched.
