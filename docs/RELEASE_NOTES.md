# AI Agent Bridge 1.14.0 — release notes

Storefront and stability release. Consolidates the 1.13.1–1.13.3 development
patches — most importantly, Claude finally receives your new messages while a
tool chain is running — plus the repository makeover: README showcase, real
logo and screenshots, GitHub metadata, and measured cache-hit numbers.

## 1. Claude: follow-up messages reach the resumed session

Previously a new user message sent while a tool chain was running ("stop",
"switch to the 3D task") was dropped: the continuation request only forwarded
the tool results to the Agent SDK, so the model kept executing the old chain
for minutes without ever seeing the new instruction.

- The trailing user text of a continuation is now extracted
  (`extractFollowUpUserText`) and pushed to the SDK as a fresh user message
  right after the tool results.
- `claude.chat.tool_resumed` now logs `followUpTextPresent` and
  `followUpTextPreview` (first 120 chars), so delivery is observable in the
  logs.
- Regression tests cover pure tool continuations, fresh follow-ups, and stale
  history that must not be mistaken for a follow-up.

## 2. Claude: 300 s active-turn timeout with a pending-tool guard

The active-turn watchdog failed long tool executions: the SDK is silent by
design while a delegated tool runs, so the timer could fire mid-tool. Now the
timer extends while any delegated tool is in flight, and real dead SDK streams
still fail after 300 seconds instead of the old 90.

## 3. DeepSeek peak hours in Quick Access (local time)

DeepSeek switches to peak/off-peak billing on **Aug 16 2026, 16:00 UTC**:
peak = 01:00–04:00 and 06:00–10:00 UTC (2× price), everything else is
off-peak at half the peak rate.

- The DeepSeek group in Quick Access shows a `Peak Hours` row with the current
  billing state, both peak windows and the next transition in your local time.
- While peak is active the row and group icon turn orange (`charts.orange`)
  and the headline reads `PEAK 2×`; the highlight fades automatically when the
  window ends.
- Verified against the official pricing page on 2026-08-13
  (https://api-docs.deepseek.com/quick_start/pricing). Logic lives in
  `src/deepseek-peak-hours.ts` with tests for window boundaries, the
  switchover instant, and midnight wrap-around.

## 4. Repository storefront

- README rebuilt as a showcase: logo, badges, clickable screenshots, install
  section, model sources, honest comparison with Continue and Cline/Roo, and
  the request-flow diagram.
- Measured cache efficiency front and center: a real long-running DeepSeek
  v4-pro session (266 turns, 267 segments) reached **99.3% prompt cache hit**
  — 36.8M prompt tokens, 36.5M from cache, 3 misses. Cached input is billed at
  a fraction of uncached input, so this directly reduces API cost.
- Custom API profiles are documented as implemented for OpenAI-compatible
  endpoints but not yet field-tested against third-party gateways.
- New extension logo (512 px, transparent corners), social preview for link
  shares, restored activity-bar icon, and refreshed GitHub description/topics.

## Verification

- **396 extension-host tests passing** (VS Code 1.131, Windows).
- Lint and TypeScript compilation clean.
- Real Claude Opus smoke test: native tool call succeeded, second response
  passed as `WARM`; cache creation 675+21, 5-hour usage 0%.
- GitHub Actions CI and Release workflows green for this tag.
