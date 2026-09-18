# AI Agent Bridge 1.16.2 — release notes

A patch release on top of 1.16.0: model reasoning now reaches a llama.cpp
server that sits behind an OpenAI-compatible gateway, the thinking level you
pick in the model picker finally changes what the model does, and the
installer picks the newest VSIX on its own. Everything from 1.16.0 is
included — sections 4 to 9 describe that feature set.

## Install in one step

This release ships the extension **and** the installer script together.
Download both files into the same folder and run the script:

```bash
bash install-ai-agent-bridge.sh
```

The script installs the extension and then applies the VS Code / Copilot Chat
patches itself, reusing the extension's own compiled patch code, so the
installer and the running extension can never disagree.

- It never blocks on a password prompt typed into the extension's terminal.
  Admin rights are requested only after an unelevated pass actually hits a
  permission error, and then in this order: passwordless `sudo`, the **system
  (polkit) password dialog**, a graphical `SUDO_ASKPASS` helper — or, when none
  is available, it applies everything it can and prints the single command to
  finish the rest.
- The reason for the password is always printed: which files need writing and
  which feature each one unlocks. Nothing is downloaded, no system package is
  changed, and every original is backed up before it is touched.
- Files written under elevation are handed back to your user, so
  **AI Agent Bridge: Restore Copilot Patch** keeps working without root later.
- A user-local VS Code installation needs no elevation at all.

## 1. Model reasoning through an OpenAI-compatible gateway

Reasoning was only ever switched on for the `llamacpp` API format. A custom
provider configured as OpenAI-compatible therefore never received
`chat_template_kwargs.enable_thinking` — and a Qwen3 chat template with
thinking disabled emits no reasoning at all, so the same model appeared to
have no thoughts through the gateway while showing them when called directly.

Custom API providers now have a **llama.cpp server behind this endpoint**
option (Providers Manager → provider → Edit). With it enabled the provider
sends `cache_prompt`, `chat_template_kwargs.enable_thinking` and
`thinking_budget_tokens` on top of the OpenAI-compatible shape: the gateway
still gets the request format it expects, but the llama.cpp server behind it
receives the fields that turn thinking on. It stays off by default, because a
strict OpenAI endpoint rejects unknown request arguments, and the
DeepSeek-native format keeps its own fields either way.

## 2. The reasoning level now reaches the server

The level picked in the model picker changed nothing but the (unused)
`thinking_budget_tokens`. The Qwen3 chat template shipped with llama.cpp reads
its effort from `chat_template_kwargs.reasoning_effort` and never looks at the
budget, so every conversation ran at the template default regardless of the
pick.

The level is now forwarded as `reasoning_effort` using the canonical names the
template validates: `low` for Light, `medium` for Balanced and `high` for
Deep. `auto` is omitted so the server default applies, and Off keeps using
`enable_thinking`. The template maps `high` onto `xhigh` and raises a template
exception for any other value, so forwarding our internal level names
verbatim would have failed every request with a 400.

`thinking_budget_tokens` is still sent, so older llama.cpp builds that consume
the budget keep working unchanged. Measured against a live llama.cpp b9506
server running the same model, `low` produced 108 reasoning characters and
`xhigh` produced 625 — the field changes model behaviour, not just the request
body.

## 3. Installer and logging fixes

- The installer picks the newest VSIX by version instead of preferring a
  hardcoded file name for the release it shipped with, so an older `.vsix` can
  no longer win when several sit in the download folder.
  `LLAMACPP_VSIX=<path>` overrides the choice.
- The log no longer reports a bogus `chat_template_kwargs` field for requests
  that never carried one. `cloneForLog(undefined)` fell through
  `JSON.stringify`, threw in `JSON.parse` and logged the literal string
  `"undefined"`, which made it look like a malformed field was being sent — it
  was never part of the real request.

## 4. VS Code 1.136.1 / Copilot Chat 0.64.1, and older builds

Upstream renamed minified bindings and added `modelCapabilities` and
`conversationId` to `makeChatRequest2`, which broke every patch anchor. The
patch now captures the minified names with regex groups:

- `reasoningEffort` is injected from the upstream `modelCapabilities` binding
  (older bundles keep the injected `__llamaModelCapabilities` slot);
- `conversationId` is read from the signature and forwarded to llama.cpp as
  `_copilotConversationId`;
- the agent-history cap, `getAvailableTools`, the git repositories guard and the
  workbench bundle anchors follow the new shapes;
- the git guard counts occurrences with `RegExp.exec` instead of `String.split`,
  because the capture group skewed the count.

VS Code 1.136.1 also implements all three agent-host behaviours natively
(verified in the shipped `agentHostMain.js`), so that patch is now
**capability-detected** rather than assumed: a build that provides them itself is
reported as native, mutates nothing and creates no backup, while builds such as
1.131 are still patched exactly as before. Only a genuinely unknown bundle shape
raises an error, and it names what it could not satisfy.

## 5. Agents that wait for real results

New tool **`llamacpp_wait_for_terminal`**: an agent waits until a terminal
command actually finishes instead of sleeping for a guessed duration, and gets
back the command line, exit code, working directory and duration. Built-in tools
are now injected into the catalog by the provider itself, so they reach the model
even on hosts that do not propagate newly registered tools without a restart.

## 6. Claude sessions that recover

- **Cross-provider recovery**: switching from Codex/ChatGPT no longer strands
  Claude with only the current request — the current transcript is replayed when
  the estimate and usage guard allow it, with latest-message recovery as the
  bounded fallback. The safe replay budget rises from 64K to 256K tokens.
- **Sign-out/sign-in clears durable sessions**, so a renewed subscription no
  longer fails with `oauth_org_not_allowed` and quarantines the chat.
- **Recovery works without a usage snapshot**: the endpoint can report
  `rate_limits: null` even on an active plan, which previously made every
  recovery fail with `usage_unknown`. A *known exhausted* limit still blocks it.
- **Bounded recovery warns you** when only the latest message could be sent, and
  explains how to raise the cap.
- **Usage is no longer erased** by the 5-minute background probe overwriting
  live limits with `null`.

## 7. Accurate subscription and billing state

- **Codex** shows both rate-limit windows — «Session Limit (5h)» and «Weekly
  Limit» — with percent used and reset time, and the duplicate «Usage Limit» row
  is gone.
- **DeepSeek** peak windows are weekday-aware (`01:00–04:00` and `06:00–10:00
  UTC, Mon–Fri`) and roll over the weekend to Monday.
- **DeepSeek vision** models are advertised as image-capable (OpenAI `image_url`
  blocks), verified against the official Vision guide.

## 8. Long conversations stay usable

- Compaction no longer drops the tail to fit `compactMaxReasoningChars`: it
  trims the **reasoning content** of the oldest retained turns instead, keeping
  turns and their tool results in context.
- Reasoning-heavy turns beyond the cap are folded into the summary, while
  retained turns keep their `reasoning_content` verbatim so the DeepSeek API
  requirement still holds.

## 9. Memory hygiene

Store guardrails (4096-char cap, one thought per entry), a search output budget
with head+tail clipping and a `full: true` escape hatch, pinned entries always
injected, and a new **Memory Health** report covering counts, token totals,
longest entries and duplicate candidates.

## Verification

- 499 extension-host tests passing.
- Lint and TypeScript compilation clean.
- The reasoning fields were confirmed against a live llama.cpp b9506 server:
  `reasoning_effort` changes the amount of reasoning the model produces, and
  the canonical values are accepted without a template error.
- The installer was verified end-to-end against a pristine, root-owned copy of a
  VS Code tree: patches apply, ownership returns to the calling user, and the
  restore path works unaided afterwards.
- GitHub Actions CI and Release workflows green for this tag.
