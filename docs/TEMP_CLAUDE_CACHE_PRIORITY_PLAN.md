# Temporary Claude Cache Priority Plan

Status: active temporary plan
Priority: P0 until large Claude turns are proven safe
Incident baseline: `ca7f0d2c-6164-4c5b-ad6b-fec52929b4a4` on 2026-08-02

This file intentionally freezes the current improvement roadmap while Claude
cache reliability and five-hour quota safety have priority. Do not remove it
until the P0 acceptance criteria below pass against real sessions.

Implementation status (1.9.15):

- P0.1 partial: original resume failure is preserved; automatic full replay is
   now guarded by configurable `safe` / `never` / `always` policy, estimated
   replay tokens, snapshot freshness, and five-hour usage headroom. Explicit UI
   recovery actions and separate attempt records remain open.
- P0.2 partial: Agent SDK `maxTurns` and a local cumulative-input circuit
   breaker are active. Tool-call, cache-creation, no-visible-output, live usage,
   and warning-threshold guards remain open.
- Live report partial: compact JSON and the Claude detail card expose fallback
   decisions, replay estimates, configured limits, and safety-stop causes.
- Cross-provider reload fix: durable Codex resume now reapplies the stable
   thread-start settings instead of inheriting a new process permission profile;
   Windows cwd spelling is normalized before it reaches the prompt prefix.
- Cache keep-alive diagnostics implemented: the live report shows background
   state and reason even with no active Claude turn, plus usage freshness,
   candidate prefix, next/last attempt, last success/failure, and the latest
   cache-read/cache-write result. Unknown/stale usage now pauses fail-safe,
   retries are throttled, and maintenance turns stay out of user-turn rows.
- P0.2 cumulative-input breaker fixed for warm turns: cache reads are counted
   at 0.1x weight, so a warm multi-segment turn no longer trips the 2M limit,
   fails, tears the session down, and forces the next turn into a cold
   restore (first-segment miss, shrunken first segment, no eligible
   keep-alive sessions). The breaker now trips only on genuinely large fresh
   input. Remaining P0.2 guards: tool-call, cache-creation, no-visible-output,
   live usage, and warning-threshold.

## What the incident proves

- The third large user turn entered `resume-fallback`: restoring the persisted
  Agent SDK session failed and the provider automatically replayed full input.
- The first model segment was genuinely cold: 71,668 input tokens, 0 cache-read
  tokens, and 71,666 cache-creation tokens.
- Segments 2-48 were warm (93.6-99.8% cache hit). The final segment read 189,343
  of 190,481 input tokens from cache.
- The reported 6,616,976 prompt tokens are cumulative processing across 48
  model segments, not a unique 6.6M-token prompt. Even with a 97.1% aggregate
  cache-hit share, repeatedly processing a growing 72k-190k prefix can consume
  a large part of the five-hour subscription quota.
- The request made 73 tool calls and ran for 806 seconds before ending with
  `Claude API error: rate_limit`. Visible output appeared only after 676
  seconds. The current provider has no sufficiently early cost/quota circuit
  breaker for this pattern.
- The final context contained 47,211 MCP-tool tokens and advertised 86 tools.
  Tool-catalog size and stability are therefore material cache and quota risks.

Transcript forensics identified the structural trigger. The previous SDK
session `f2f43b5a...` received a normal user prompt at `07:04:26`, then ended at
`07:05:56` with `[Request interrupted by user]` and no completing assistant
message. The next request arrived 1.4 seconds later. Durable resume attempted to
continue that orphan user tail, failed, and fallback created `bc0c5c93...` with
`parentUuid: null`, proving a new full-input session. This was not a cache TTL
expiry. The exact SDK exception was not retained by version 1.9.11; preserving
that exception is part of the fix below.

## P0.1 - Make resume fallback fail-safe

1. Preserve and report the original resume failure:
   - error class/code/message;
   - failure stage (`resume_open`, first model request, stream, tool bridge);
   - persisted SDK session ID fingerprint and replacement session fingerprint;
   - runtime fingerprint comparison and exact changed components.
2. Estimate replay cost before constructing full fallback input.
3. Add a configurable fallback policy:
   - `safe` (default): automatically replay only below a conservative token
     threshold and while the five-hour limit has sufficient headroom;
   - `never`: fail without a cold replay;
   - `always`: preserve today's behavior for explicit opt-in.
4. Above the safe threshold, stop before the API call and offer explicit
   recovery choices: retry the persisted session, compact/start a new session,
   or allow one full replay.
5. Never classify a rejected resume and the fallback attempt as one opaque
   `resume-fallback` event. Both attempts need separate lifecycle records.

## P0.2 - Add a per-turn quota circuit breaker

Track and enforce configurable limits during an Agent SDK turn:

- model segments;
- tool calls;
- cumulative processed input tokens;
- cumulative cache-creation tokens;
- elapsed time without visible output;
- fresh five-hour usage percentage.

The installed Agent SDK already exposes `maxTurns` and `maxBudgetUsd`, while
the current adapter forwards neither option. Wire `maxTurns` as an immediate
upstream guard and evaluate `maxBudgetUsd` as a secondary guard; retain local
cumulative-token and subscription-usage guards because subscription quota cost
does not necessarily map cleanly to the SDK's USD estimate.

Use a warning threshold followed by a hard threshold. On warning, expose the
reason in the live report. On hard limit, stop cleanly with a resumable session
instead of continuing until the upstream `rate_limit` error. Unknown or stale
usage data must be shown as unknown, never treated as 0% used.

Initial defaults must be derived from real traces. The incident's 48 segments,
73 tools, 6.6M cumulative input tokens, and 11.3 minutes without visible output
are the first unsafe baseline, not proposed default values.

## P0.3 - Fix durable resume correctness

Audit and test the complete session-ID lifecycle:

- initial SDK session ID;
- forked session ID returned after `resume`;
- atomic durable-state update after every successful turn;
- cancellation/follow-up during an active stream;
- extension reload between consecutive large turns;
- stale, missing, locked, or already-forked transcript handling.

Runtime/tool-catalog fingerprints must be deterministic. Persist component
hashes separately (model, context target, effort, cwd, tool names, tool schemas)
so a mismatch report names the actual changed component instead of only saying
`runtimeChanged: true`.

## P0.4 - Make live reports cost-oriented

Add separate fields and UI rows for:

- initial-segment cache hit and cold rewrite tokens;
- continuation cache hit;
- unique final context size;
- cumulative processed input tokens;
- cumulative cache-read and cache-creation tokens;
- replay-attempt number and failure stage;
- quota snapshot age and five-hour usage delta during the turn;
- model/tool segment count and time since last visible output;
- projected cost/quota risk and circuit-breaker state.

Do not summarize this incident only as `97.1% cache hit`: that aggregate hides
the initial cold replay and the 48-fold repeated processing. Running/provisional
records must be visibly separate from terminal records.

## P0.5 - Regression and fault-injection tests

Required scenarios:

1. Three consecutive large turns in one VS Code conversation without reload:
   turns 2 and 3 reuse the warm session and do not enter fallback.
2. Reload between large turns: durable resume succeeds and the forked session ID
   is persisted for the next turn.
3. Forced resume rejection with a large context: `safe` policy blocks automatic
   replay before any cold API request.
4. Cancellation and follow-up while a tool/model segment is active: no dead
   stream reuse and no stale durable session ID.
5. Long tool loop: warning and hard budgets trigger before upstream rate limit;
   the session remains resumable.
6. Dynamic tool registration/order changes: canonical tool catalog remains
   stable unless names or schemas materially change.
7. Unknown/stale subscription usage: UI and guard logic remain fail-safe.

## Acceptance criteria for leaving P0

- No unexplained `resume-fallback` in three consecutive real large-session
  trials.
- A forced large-context resume failure cannot silently cold-replay under the
  default policy.
- A long agent loop stops at the configured local budget before an upstream
  five-hour `rate_limit` failure.
- The report distinguishes cold replay, incremental writes, warm continuation,
  and cumulative processing at a glance.
- Every fallback contains the original resume error and exact fingerprint diff.
- Compile, lint, full tests, VSIX install, and post-install runtime checks pass.

## Deferred roadmap after Claude P0

1. Separate cache keep-alive into a maintenance turn that cannot pollute user
   transcript or ordinary turn statistics; select candidates by expiry risk and
   prefix value, not only recency.
2. Reuse a background Claude account/usage probe and expose snapshot freshness.
3. Stabilize a small core tool catalog and lazy-load optional tools to reduce
   the 47k-token MCP schema prefix.
4. Add Quick Access session health: warm/restored/fallback, cache expiry ETA,
   last keep-alive result, active segment/tool, and local budget remaining.
5. Add a redacted one-click incident bundle containing the relevant lifecycle,
   fingerprint, usage, and rate-limit events.
6. Introduce a shared turn coordinator for queueing, cancellation, supersede,
   stale-result rejection, and finalization across providers.
7. Reduce VSIX size through bundling and platform-specific packaging.

## Investigation notes to fill next

- [x] Structural trigger: interrupted transcript ended on an orphan user tail;
   fallback then created a new root session.
- [ ] Exact original resume error for incident `ca7f0d2c...`.
- [ ] Persisted SDK session ID before turn 3 and ID returned by the last
      successful fork.
- [ ] Whether runtime/tool-catalog fingerprint changed between turns 2 and 3.
- [ ] Five-hour usage before the request, at fallback, and at terminal failure.
- [ ] Safe replay threshold and local cumulative-input budget from additional
      real traces.
