# AI Agent Bridge 1.16.5 — release notes

A security patch release with updated dependencies and safer handling of API
keys, HTTP errors, and installer privileges. It also includes the Copilot Chat
bundle compatibility fix from the 1.16.4 development build.

## API keys stay with their configured server

The primary API key is used for the configured global server. A workspace can
still choose another server, but that override does not receive the global
key. The key reaches DeepSeek only when the primary server is the official
HTTPS DeepSeek API, or when a separate DeepSeek key is saved. Host detection
rejects lookalike domains.

## HTTP errors are bounded and kept out of diagnostics

Only the first 8 KiB of an HTTP error body is read, within three seconds, when
the provider needs to classify a context overflow or a tool format error. The
body is not written to logs or shown in errors. Other error paths report the
HTTP status without reading the body.

## Installer and Copilot patch

The Linux/macOS installer no longer runs the patch code through `sudo` or
`pkexec`, or transfers ownership of system VS Code files. Run it as a regular
user. If your VS Code installation is system-owned, use a user-owned or portable
installation to apply bundle patches without administrator rights.

The VS Code workbench patch now recognizes the serializer shape in the current
bundle. It was verified against the installed VS Code build. The installation
requirements and error meanings are documented in `docs/COPILOT_PATCH.md`.

## Install in one step

This release ships the extension **and** the installer script together.
Download both files into the same folder and run the script for your platform:

```bash
# Linux (including CachyOS)
chmod +x install-ai-agent-bridge.sh
./install-ai-agent-bridge.sh
```

```bat
:: Windows
install-ai-agent-bridge.cmd
```

The Linux script installs the extension and applies compatible patches when
the application files are writable by the current user. On Windows the
extension applies patches on the next window reload.

## Verification

- `npm audit` reports zero vulnerabilities in the complete dependency tree.
- TypeScript and lint checks pass; the extension-host suite contains 506 tests.
- The Linux installer passed `bash -n` and its non-mutating dry run.
