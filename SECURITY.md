# Security Policy

## Supported Versions

The extension is distributed as a VSIX from GitHub Releases and is validated
against VS Code 1.131 on Windows (win32-x64). Only the latest release is
supported.

| Release | Supported |
| ------- | --------- |
| latest  | ✅        |
| older   | ❌        |

## Reporting a Vulnerability

Do **not** open a public issue for a security vulnerability.

Report it privately to the repository owner:

- GitHub: open a new issue and select the **"Security vulnerability"** template
  (it marks the report to be handled privately), or
- email the maintainer (see the repository owner profile for contact details).

Please include:

1. The affected version (the installed VSIX file name, for example
   `llama-vscode-chat-1.14.13.vsix`).
2. Steps to reproduce.
3. Impact (what an attacker can do).
4. Any logs, redacting secrets and personal data first.

You will receive an acknowledgment within 5 business days, and a status update
within 30 days. When the fix ships, the reporter is credited in the release
notes unless they ask not to be.

## What We Consider a Vulnerability

- Leakage of API keys, subscription tokens, or SecretStorage values into logs,
  UI, or the VSIX package.
- Remote code execution through model output, tool calls, or webview content.
- SSRF through user-configured endpoints (custom API profiles, local servers).
- The Copilot Chat patch (`Restore Original Copilot Chat` must always reverse
  it) — a patch that cannot be reverted is a bug.
- Crash-loops or context-exhaustion paths that persist across restarts.

## Security Model (How Secrets Are Handled)

- API keys are stored in VS Code SecretStorage (`context.secrets`), never in
  settings files, logs, or the VSIX package.
- Authorization headers are redacted from logs.
- The extension never reads ChatGPT/Claude credential files; those runtimes
  own their authentication.
- Claude tools are restricted to the allowlisted native VS Code MCP namespace;
  Codex internal action items are denied.
