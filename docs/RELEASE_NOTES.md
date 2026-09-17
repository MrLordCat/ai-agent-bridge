# AI Agent Bridge 1.16.0 — release notes

Install in one step, Claude and Codex sessions that recover instead of failing,
accurate subscription state, a new terminal-wait tool for agents, and long
conversations that no longer collapse into a fragment.

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

## 1. VS Code 1.136.1 / Copilot Chat 0.64.1, and older builds

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

## 2. Agents that wait for real results

New tool **`llamacpp_wait_for_terminal`**: an agent waits until a terminal
command actually finishes instead of sleeping for a guessed duration, and gets
back the command line, exit code, working directory and duration. Built-in tools
are now injected into the catalog by the provider itself, so they reach the model
even on hosts that do not propagate newly registered tools without a restart.

## 3. Claude sessions that recover

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

## 4. Accurate subscription and billing state

- **Codex** shows both rate-limit windows — «Session Limit (5h)» and «Weekly
  Limit» — with percent used and reset time, and the duplicate «Usage Limit» row
  is gone.
- **DeepSeek** peak windows are weekday-aware (`01:00–04:00` and `06:00–10:00
  UTC, Mon–Fri`) and roll over the weekend to Monday.
- **DeepSeek vision** models are advertised as image-capable (OpenAI `image_url`
  blocks), verified against the official Vision guide.

## 5. Long conversations stay usable

- Compaction no longer drops the tail to fit `compactMaxReasoningChars`: it
  trims the **reasoning content** of the oldest retained turns instead, keeping
  turns and their tool results in context.
- Reasoning-heavy turns beyond the cap are folded into the summary, while
  retained turns keep their `reasoning_content` verbatim so the DeepSeek API
  requirement still holds.

## 6. Memory hygiene

Store guardrails (4096-char cap, one thought per entry), a search output budget
with head+tail clipping and a `full: true` escape hatch, pinned entries always
injected, and a new **Memory Health** report covering counts, token totals,
longest entries and duplicate candidates.

## Verification

- 492 extension-host tests passing.
- Lint and TypeScript compilation clean.
- The installer was verified end-to-end against a pristine, root-owned copy of a
  VS Code tree: patches apply, ownership returns to the calling user, and the
  restore path works unaided afterwards.
- GitHub Actions CI and Release workflows green for this tag.
