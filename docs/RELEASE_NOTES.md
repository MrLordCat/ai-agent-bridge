# AI Agent Bridge 1.16.3 — release notes

A patch release on top of 1.16.2. Everything from 1.16.0 is included — the
sections about reasoning, patches, tools, sessions and memory in the 1.16.2
notes still describe that feature set.

## 1. Subscription limits read as two lines

The Codex rows `Session Limit (5h)` and `Weekly Limit` packed the percent used
and the reset moment into a single line, and a VS Code tree row is too narrow
for both: `resets 9/23/2026, 3:11:00 PM` was cut off exactly where the
timestamp begins. Each row now keeps the short `0% used` summary on its own
line and shows `Next Reset` on an indented child row, which starts at the left
edge of the tree and therefore shows the whole timestamp. The rows open
expanded, and the fallback `Usage Limit` row uses the same layout.

## 2. The installers pick the newest VSIX by version

Both installer scripts compare the VSIX files next to them as versions instead
of as names, so `llama-vscode-chat-1.16.10.vsix` wins over `1.16.9` — a plain
name sort installs the older file. The Windows script no longer carries a
hardcoded `PRIMARY_VSIX` pointing at the release it shipped with; set it only
to force one specific file.

Verified in an isolated fixture (a stub CLI and a stub VS Code tree), so no
real installation was modified: the script selects the newest version, copies
the VSIX to a temp folder, calls the CLI, finds the application root and the
installed extension, applies what it can, reports every patch and exits 0.
Against a bundle it does not recognise it reports the failure instead of
claiming success; with no VSIX next to it, it prints the download link; and
`SKIP_PATCHES=1` / `DRY_RUN=1` do exactly what they say.

## 3. Platform and install notes in the README

The README claimed Windows was the only supported platform and described the
Linux installer as "VSIX installation only". Both were stale: the Linux
installer applies the VS Code / Copilot Chat patches in the same run, using
the extension's own compiled patch code, and the Codex runtime is chosen per
platform in `src/codex/app-server-client.ts`. The install section now covers
Windows and Linux, the real installer behaviour (temp copy, newest-version
selection, polkit password dialog, ownership hand-back,
`~/.local/share/llama-vscode-chat/apply-patches.sh`), every environment
override, and the current version in its examples.

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

The Linux script installs the extension and then applies the patches itself.
It never blocks on a password typed into a terminal: admin rights are
requested only after an unelevated pass actually hits a permission error, and
then through passwordless `sudo`, the polkit system dialog, or a graphical
`SUDO_ASKPASS` helper. Files written under elevation are handed back to your
user, so **AI Agent Bridge: Restore Copilot Patch** keeps working without root
later. On Windows the extension applies the patches on the next window reload.

## Verification

- 499 extension-host tests passing; lint and TypeScript compilation clean.
- The Windows installer was run end-to-end: it selected `1.16.3` out of four
  VSIX files in the folder and installed it, and the installed extension
  reports `1.16.3` with `source: vsix`.
- The Linux installer was exercised in the isolated fixture described above,
  including the missing-VSIX error path and the `SKIP_PATCHES=1` branch.
- GitHub Actions CI and Release workflows green for this tag.
