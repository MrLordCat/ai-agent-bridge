# AI Agent Bridge 1.17.0 audit

Reviewed on 2026-10-10. Scope: the accumulated Coco integration, terminal and
conversation lifecycles, Linux patch installation, dependency tree, packaging
and release workflow.

## Corrections made

- ACP ignores non-object input, handles fragmented replies and supports string
  request IDs. Handler failures produce a protocol result or close the session.
  Pending replies are rejected after stdout drains on process shutdown.
- Dependency updates include MCP SDK 1.32.1, proxy-addr 2.0.8 and VSCE 4.0.0.
  Full `npm audit` reports zero known vulnerabilities.
- CI and publication build Windows x64 and Linux x64 independently. VSIX target
  metadata and bundled Claude runtimes match their platforms.
- External installers and the repository patch wrapper were deleted. Compatible
  patches apply during extension activation. Linux users can prepare a writable
  desktop copy from the extension without root.
- The optional manual administrator runner uses a private temporary directory,
  quotes recovery arguments and starts Electron in Node mode. It is outside the
  no-root verification matrix; no elevated command was executed for this audit.
- README, release notes, build version and lockfile are aligned to 1.17.0.

## Verification

| Check | Result |
| --- | --- |
| Windows extension-host suite | 580 passing, 2 Linux-only tests skipped |
| Debian extension-host suite | 581 passing, 1 Windows-only test skipped |
| TypeScript, ESLint, editor diagnostics | Passed |
| Full npm dependency audit | 0 vulnerabilities |
| Windows x64 and Linux x64 VSIX metadata | Correct targets and native runtimes |
| External installer/patch scripts in either VSIX | 0 |
| Local Windows installation | 1.17.0, source VSIX; all 78 runtime JS files match |
| Debian desktop installation matrix | All 6 scenarios passed on VS Code 1.131.0 / 1.141.0 |
| Linux terminal control | Output, reuse, input and process termination passed in every scenario |
| Migration without root | UID 1000; system unchanged; repeated preparation reuses the copy |

Debian checks cover writable applications, system-owned applications with
reported permission failures, and migration to a user-owned copy. The detailed
report is in [DEBIAN_VERIFICATION.md](DEBIAN_VERIFICATION.md).

Local evidence is under `artifacts/debian/release-1.17.0/`. These generated
files and VSIX binaries are excluded from Git.

## Limits of the verification

Paid provider authentication and model generation were not exercised in Debian.
The fixture disables providers and checks installation, activation, patches and
actual bash terminals. Docker's GUI harness uses Xvfb and `--no-sandbox`; the
production launcher does not add that flag. Desktop sandbox policy outside this
fixture and administrator-based patching were not tested. Unknown bundle
layouts and protected system files retain explicit status instead of being
silently treated as patched.
