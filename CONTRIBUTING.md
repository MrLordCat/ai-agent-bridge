# Contributing

Thanks for helping! This extension bridges local models and subscription
providers (DeepSeek, Codex, Claude) into native VS Code Chat. It is
Windows-first and validated against VS Code 1.131.

## Ground Rules

- One bug — one focused change. Do not touch unrelated areas.
- Every behavior change ships with a changelog entry (`CHANGELOG.md`) and, for
  fixes, a short note in `docs/BUGS.md` when the bug was tracked there.
- New logic requires tests. We practice red test first: add a failing test,
  then implement, then make the suite green.
- Versioning: dev patches increment the patch digit only (1.14.14, 1.14.15).
  Minor bumps (1.15.0) happen only on an explicit release command.

## Dev Setup

Windows with git-bash, Node 22+.

```bash
npm ci
npm run compile        # tsc -p ./
npm test               # full suite on the pinned VS Code 1.131 (vscode-test)
npm run lint
```

The test suite runs inside VS Code 1.131 pinned by `.vscode-test.mjs` because
the agent-host / Copilot patch patterns are version-specific.

## Build & Install

```bash
npm run package        # builds llama-vscode-chat-{version}.vsix
code --install-extension llama-vscode-chat-{version}.vsix --force
```

Never copy extension folders into `~/.vscode/extensions/` by hand.

## Line Endings

`.gitattributes` pins `eol=lf` for source files, but Windows working copies
often have CRLF. Before multi-line edits check `file <path>`; for CRLF files
prefer node scripts that normalize `\r\n → \n` and back, or single-line
replacements.

## Areas

- `src/llama-provider.ts` — local + DeepSeek chat provider, request shaping,
  context budget, compaction, loop guards.
- `src/codex/`, `src/claude/` — subscription providers.
- `src/byok/` — VS Code 1.131 agent-host bundle patch (thinking levels,
  non-streaming JSON, reasoning_effort forwarding). Patterns are validated by
  `src/test/agent-host-thinking-patch.test.ts` against the installed bundle.
- `src/ui/` — Quick Access tree and the Providers Manager webview.
- `src/context/`, `src/memory/`, `src/tools/` — context budgeting/compaction,
  shared memory, tool-call reliability.

## Pull Requests

- Open a PR against `main` with a clear description and test evidence
  (`npm test` output).
- CI runs lint, the full test suite, and a VSIX build on Windows.
- Do not bump the minor version in a PR.
