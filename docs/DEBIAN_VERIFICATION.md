# Debian VS Code installation verification

Verified on 2026-10-10 using Debian 12 (bookworm), Node 22.23.3 and AI Agent
Bridge 1.17.0. Every VS Code instance and extension ran as UID 1000. Docker's
root setup process only created application fixtures, including a root-owned
installation to reproduce the permissions of a system package.

## Local 1.17.1 follow-up

The 2026-10-10 follow-up passed 591 Linux tests (one Windows-only test skipped)
and the same six installation scenarios on VS Code 1.131 and 1.141. Windows
passed 588 tests, with four Linux-only tests skipped. Both VSIX packages were
built; the Windows copy was installed through the Code CLI as `source: vsix`.

`scripts/debian/verify-elevation.mjs` checks the administrator runner in a
disposable container: normal users can read but cannot patch system fixtures;
root applies compatible patches, a repeated application succeeds, user-owned
backups retain their owner, and restoration returns exact original workbench
and agent-host bytes. Both VS Code versions passed. Real `pkexec` authorization
and interactive sudo password entry remain manual checks.

Evidence is in `artifacts/debian/patch-1.17.1/`, including `elevation.log`.
The Linux VSIX is available in the running GUI container at
`/packages/llama-vscode-chat-1.17.1-linux-x64.vsix` for manual installation.

## 1.17.0 results

The Linux extension-host suite passed **581 tests**, with **one Windows-only
PowerShell test skipped**. Compilation, ESLint and Linux VSIX packaging passed.

| VS Code | Application ownership | Installed extension | Automatic Copilot controls | Automatic workbench patch | Live bash |
| --- | --- | --- | --- | --- | --- |
| 1.131.0 | User-writable | VSIX, active | Applied | Applied | Passed |
| 1.131.0 | Root-owned, read-only to UID 1000 | VSIX, active | Permission denied | Permission denied | Passed |
| 1.131.0 | Migrated from root-owned to user-owned, without root | VSIX, active | Applied | Applied | Passed |
| 1.141.0 | User-writable | VSIX, active | Applied | Applied | Passed |
| 1.141.0 | Root-owned, read-only to UID 1000 | VSIX, active | Permission denied | Permission denied | Passed |
| 1.141.0 | Migrated from root-owned to user-owned, without root | VSIX, active | Applied | Applied | Passed |

The migration invoked the preparation module from the installed production
VSIX as UID 1000. It copied application files to the user's home, then reused
that copy on a second call. Installation used the generated launcher. A normal
window loaded the copied application with its separate profile and shared
extension directory; patch commands were not invoked. Its current `appRoot`,
file ownership and the unchanged system bundles were checked explicitly.

The workbench terminal patch also applied automatically in writable scenarios.
On 1.131.0 the agent-host thinking and response compatibility patch applied on
startup; on 1.141.0 those capabilities were detected as native and no write was
needed. Before 1.16.16 the agent-host patch only had a manual command, which
explained one difference between normal VSIX activation and the installer.

The live bash check executed commands in an integrated terminal, captured their
output, reused the shell and its variables, sent input to a running command, and
confirmed that closing the terminal ended its actual shell process.

The VSIX was installed with the standard Linux `code --install-extension` CLI.
An ordinary VS Code window then loaded the installed bridge. A separate probe
waited for automatic activation and inspected patch status. It never called the
bridge's activate method, apply-patch commands, or the installation script. The
default `llamacpp.autoPatchCopilot: true` was retained.

## What explains the reported Linux failure

Installing a VSIX through the CLI does not execute its startup patch. The patch
runs when the installed extension activates in a VS Code window; a reload is
then needed to use modified bundles. On a writable installation this worked
without external installer scripts on both tested versions.

The root-owned case failed with real `EACCES` errors while writing the bundled
Copilot Chat file and the workbench backup. Extension activation and integrated
terminals still worked. An unprivileged extension cannot modify protected
application files just because its VSIX was installed. A script faces the same
restriction unless it obtains the required write access.

For a writable installation, install the VSIX, open VS Code and accept the
reload prompt. For a protected installation, inspect **AI Agent Bridge Copilot
Patch** in Output and **AI Agent Bridge: Show Copilot Chat Patch Status**. A
user-owned VS Code installation permits automatic patching. Run
**AI Agent Bridge: Prepare User VS Code (Linux, no root)** in the local Linux
desktop window, then launch **AI Agent Bridge Code** or
`~/.local/bin/code-ai-agent-bridge`. The separate profile needs its own settings
and account configuration. The existing administrator workflow was not tested.

The system fixture contained the bundled, root-owned Copilot Chat. A separate
user-installed Copilot Chat copy can make the controls writable while the
system workbench remains protected; that mixed installation was not part of
this six-case matrix.

Authentication and paid requests to external model providers were not exercised
in these isolated profiles. The result covers Linux tests, VSIX installation,
automatic activation, patch application and real terminal interaction.

## Repeat the verification

```sh
docker build -t ai-agent-bridge-debian .
docker run --name ai-agent-bridge-debian-check --shm-size=1g ai-agent-bridge-debian
docker cp ai-agent-bridge-debian-check:/workspace/artifacts/debian ./artifacts/debian
```

The default driver compiles, lints, runs the Linux extension-host suite, builds
the Linux VSIX and checks writable, read-only and no-root migration scenarios on VS Code
1.131.0 and 1.141.0. `DEBIAN_VSCODE_VERSIONS` can select versions. The `--install-only`
driver option resumes installation checks after the suite has already passed.
Fresh VS Code downloads require network access.

The headless windows use Xvfb and `--no-sandbox` inside the isolated container.
On Docker Desktop's WSL2 kernel, the driver sets `DONT_PROMPT_WSL_INSTALL=1`
because it intentionally runs the Linux desktop build in Debian.

Generated reports and logs are under `/workspace/artifacts/debian`. The test
driver and artifacts are excluded from the extension package. Local evidence:

- `artifacts/debian/release-1.17.0/summary.json`: the six scenarios for 1.17.0, including
	no-root migration, all patch statuses and live bash checks.
- `artifacts/debian/release-1.17.0/unit-tests.log`: 581 passing, one platform skip.
- `artifacts/debian/llama-vscode-chat-1.17.0-linux-x64.vsix`: Linux-built 1.17.0.

## Debian su follow-up: local 1.17.2

The Debian GUI fixture has su but no sudo or pkexec. Administrator patching now
selects the installed terminal command and passes the runner through
`su - root -c`. Failed terminal attempts retain the runner for a retry.

The local 1.17.2 verification passed 594 Linux tests (one Windows-only skip),
all six installation scenarios above, and real su commands on root-owned
VS Code 1.131.0 and 1.141.0 fixtures. Those commands checked denied ordinary-user
writes, successful application, idempotence, backup ownership and exact restore.
The su fixture runs as root and exercises command parsing and patch behavior;
interactive password authentication is a separate manual GUI check.
See [the GUI instructions](DEBIAN_GUI.md) for root password setup.

Evidence:

- `artifacts/debian/patch-1.17.2/unit-tests.log`: 594 passing, one platform skip.
- `artifacts/debian/patch-1.17.2/summary.json`: six installation scenarios.
- `artifacts/debian/patch-1.17.2/su-elevation.log`: apply/restore through real su.
- `artifacts/debian/llama-vscode-chat-1.17.2-linux-x64.vsix`: Linux-built 1.17.2.

## Patch authorization retry: local 1.17.3

Quick Access Apply Patch now resumes a retained authorization attempt instead
of being blocked after a failed password entry. A failed attempt offers a retry
in the same terminal or closure followed by a fresh workflow. Commands wait
for shell integration and use execution identity to observe completion.

Verification passed 601 Linux tests (one platform skip), all six installation
scenarios, and a separate seven-test retry suite on VS Code 1.141.0.
The real bash test on both 1.131.0 and 1.141.0 runs a command that deliberately
fails once, retries in the same shell, then verifies successful cleanup.
Interactive sudo/su password entry remains a manual GUI check.

Evidence:

- `artifacts/debian/patch-1.17.3/unit-tests.log`: Linux suite on VS Code 1.131.0.
- `artifacts/debian/patch-1.17.3/patch-retry-1.141.log`: retry suite on 1.141.0.
- `artifacts/debian/patch-1.17.3/summary.json`: six installation scenarios.
- `artifacts/debian/llama-vscode-chat-1.17.3-linux-x64.vsix`: Linux-built 1.17.3.