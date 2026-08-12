# AI Agent Bridge 1.13.0 — release notes

Hotfix release. Two integration breakages are fixed and verified end-to-end:
Claude restored sessions could burn the whole 5-hour allowance without ever
producing a token, and Codex subagents (Luna) could silently lose screenshots.

## 1. Claude: durable restore no longer hangs or burns the rate limit

A persisted resume checkpoint could point into the middle of a tool chain,
where the SDK transcript splits one assistant message into thinking/text/tool
fragments. Restoring from such a boundary made the SDK initialize but then
produce no stream activity until the 90-second timeout — twice, with the same
broken session selected again on retry. The diagnostics showed
`resume_failed (sdk_resume, timeout)` and a blocked 176K-token full replay.

Fixes:

- **Checkpoints advance only after a successful logical turn.** A thinking or
  tool-use fragment is never treated as a completed boundary anymore.
- **Resume boundaries are validated from the transcript before any model
  request.** Missing, non-assistant, and incomplete tool-use boundaries are
  quarantined immediately — no second retry against the same broken session.
- **Failed resumes stay quarantined until a successful recovery replaces
  them.** If a full replay exceeds the configured 64K safety limit, Claude
  starts a fresh session with only the latest user message, after a
  conservative 2x cost estimate (including 8K SDK overhead) and a fresh
  five-hour-usage check. If even that bounded recovery is unsafe, the request
  fails **before contacting the model** instead of silently spending the
  remaining allowance.
- A completely fresh cold start is also guarded by the same token limit, so a
  missing transcript file or an extension reload cannot bypass the protection.

Verified with a real Opus smoke run: native tool call succeeded, the follow-up
turn resumed warm (cache write 675 → 21 tokens), and the 5-hour usage stayed
at 0%.

## 2. Codex: vision subagents (Luna) actually see screenshots

VS Code does not deliver file attachments into subagent prompts, so the
extension extracts image references from the prompt text. Two failure modes
were found and fixed:

- The prompt contained a PNG data URI that decoded successfully but was the
  first 1,080 bytes of a 1,100-byte file — missing the mandatory `IEND` chunk.
  Codex replaced it with `image content omitted because it could not be
  processed`. **Data URIs are now checked for format-specific end markers**
  (PNG IEND, JPEG EOI, WebP RIFF size, GIF trailer), not just base64
  decodability.
- Local screenshots are now sent through the native app-server `localImage`
  input instead of being re-encoded into data URIs. When an inline image is
  truncated, the provider recovers it from an exact byte-prefix match in
  `%TEMP%` (`codex.prompt_image.recovered`); unrelated files cannot match.
  Prompt image paths also resolve through git-bash aliases (`/tmp/x.png`,
  `C:/tmp/x.png`, `/d/GitHub/x.png`), and wrapped multi-line base64 is
  reassembled.

## Quality

- 389 passing tests, ESLint clean, TypeScript clean.
- The VSIX for this tag is attached to this release; install with
  `code --install-extension llama-vscode-chat-1.13.0.vsix`.
