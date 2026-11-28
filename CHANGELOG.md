# Changelog

## 2.1.4 - 2026-11-28

- Fixed: SubHarness chat compaction can use the primary API key when the
  trusted primary server is the official DeepSeek API and no dedicated
  DeepSeek key is configured.

## 2.1.3 (stable release) - 2026-11-28

Also brings the 2.1.1 and 2.1.2 development builds below.

- Changed: tools fit their output to what the model's provider takes in one
  result, instead of the provider dropping its middle (Claude at 16,000
  characters, Codex 12,000, HTTP models 24,000). `read_file` stops early and
  ends with the `startLine` to continue from, and shows a line longer than the
  page cut; the terminal tools return less of the newest output; `changes_diff`
  names the files it left out.
- Changed: every built-in tool schema lists the arguments it takes
  (`additionalProperties: false`); 22 of 30 took any argument and ignored an
  unknown one silently (`grep_search` got `-A` three times). A call with an
  unknown argument still runs without it, and its result names the argument
  and the ones the tool takes, on Claude too, whose tool check drops it first.
- Changed: self-cleaning also shortens what earlier requests' edits and
  subagent tasks wrote: `content`, `oldString`/`newString` and `prompt` from
  300 characters become a note with their size, while the file and the other
  arguments stay. Tool call arguments were a third of the live window. The
  **Context cleaned** card and Session Quality count them.
- Changed: an open subagent is cleaned like the chat before its next task, when
  its history is over the chat budget or half its model's context: stale
  results, edit arguments and memory indexes of its earlier tasks become
  stubs, and the provider starts its session again from the cleaned history.
  Its panel shows **Earlier tasks cleaned**. Before, it only shortened long
  results at half the context and refused at 80%.
- Added: Session Quality → **Request breakdown**: what the first request of
  each turn spends its tokens on (system prompt, tool schemas, summary, memory,
  user requests, model answers, tool arguments, tool results, images), for the
  latest turn and on average; the log has it as `chat.request.breakdown`.
- Changed: a terminal result in the state `running` says how to wait for it
  with `read_terminal` and `waitMs`, or stop it, instead of starting it again;
  `run_in_terminal` says how long a terminal ID lives and that a call without
  one reuses an idle terminal.
- Changed: the system prompt no longer repeats what the `subagent` and memory
  tools say about themselves: 605 characters less in every request.
- Fixed: after a test run, a click on a chat notification in Windows opened an
  empty window of the test build of VS Code. Every VS Code start takes over
  `vscode://` links; `npm test` now gives them back to the installed VS Code
  (`node scripts/run-vscode-test.mjs --restore-only` repairs them by hand).

## 2.1.2 (development build) - 2026-11-27

- Changed: the VSIX is 10.6 MB instead of 115 MB. The Claude runtime
  (`claude.exe`) is no longer packaged: it must match the Agent SDK version, so
  the extension downloads that platform package from npm (about 100 MB, sha512
  checked, the binary must start) into its global storage. Signed-in Claude
  users get it in the background a few seconds after updating; otherwise
  sign-in offers it, and `SubHarness: Install Claude Runtime` installs it.
  Quick Access shows **Claude Runtime: Not installed** while it is missing, and
  a Claude request without it fails at once with the command to run. The
  Anthropic Claude Code extension's binary and `llamacpp.claudeCliPath` still
  come first.
- Changed: the extension loads from one file. Packaging bundles
  `out/extension.js` and its modules with esbuild; module loading takes about
  104 ms instead of 225 ms. Tests and development keep the per-file `tsc`
  output.
- Changed: unused files left the package: the CommonJS and Bun builds of the
  Cursor SDK, the CommonJS build of the Cortex SDK, Statsig browser bundles,
  `.d.cts` declarations and the old webview output; `stream-json` moved to
  `devDependencies` (only `scripts/repair-chat-sessions.cjs` uses it).
- Changed: DeepSeek session state is kept in one file per conversation under
  `session-state/` instead of one `session-state.json` (68 MB). Nothing is read
  at startup (the file used to be parsed twice, about 0.6 s); a conversation's
  file is read the first time it is used, and a turn writes only that file
  instead of reading and rewriting the whole store. Files unused for 7 days go,
  at most 24 files and 48 MB stay. The old file is split once, about a minute
  after startup or on the first DeepSeek request, and then deleted.
- Changed: storage cleanup in the background after startup. Logs start a new
  file every 16 MB and keep the folder under 60 MB; `chat.context.usage` logs
  prompt segment totals instead of the full list, and `chat.turn.complete` no
  longer repeats it (together 75% of the log bytes). The chat's snapshot
  repositories are packed once they hold 2,000 loose objects (6,766 files
  here), keeping every object; a repository of a folder that is gone goes
  after 30 days. Cursor agents and archives unused for 30 days, provider
  transcripts unused for 30 days (the folder capped at 100 MB) and stray chat
  temp files are removed. Chat logs are never removed by cleanup.

## 2.1.1 (development build) - 2026-11-26

- Fixed: a subagent report reaches the agent whole. Claude cut every tool
  result to 16,000 characters (Codex 12,000, HTTP 24,000) and dropped its
  middle, so the main agent lost most of a long report it cannot fetch again.
  `subagent` and `wait_subagents` results now pass up to 60,000 characters on
  Claude, Codex (also in a replayed conversation) and HTTP models; longer ones
  still keep their head and tail. Other tools keep the provider's limit.
- Changed: context cleaning also removes old images. An image counts about
  4,096 tokens, so a `view_image` result goes stale one request later and an
  image in another tool's result counts as a large result; the stub keeps the
  call and its path.
- Changed: context cleaning keeps only the newest copy of the shared memory
  index; older user messages lose their index, the entry texts stay.
- Fixed: the cleaning budget counts the tool schemas, not only the system
  prompt, so a chat with many tools is cleaned before it goes over.
- Changed: provider usage is refreshed when it is needed instead of every
  minute. The DeepSeek balance (only with `llamacpp.enableDeepSeek`), Codex
  status and Claude usage refresh at startup, after requests, when Quick
  Access opens (at most every 5 minutes), from its refresh button, once after
  a known window reset, and every 15 minutes otherwise; the minute timer only
  redraws a visible Quick Access. Catalog probes of API profiles run every 15
  minutes instead of 5. An idle window sent about 47 such requests an hour.
- Fixed: a Codex window whose reset time has passed no longer counts as used
  up because of an old snapshot, and the Codex limit text names the window
  that blocks with its own percent (a used-up week showed "(1%)").
- Changed: DeepSeek reasoning is kept in `deepseek-reasoning-map.json` in the
  extension's global storage instead of VS Code's state database (4 MB
  rewritten every turn, with VS Code's "large extension state" warnings). It
  is written only when it changes; the old key is moved once and cleared.
- Changed: clearer tool errors and schemas. An unknown argument names the
  allowed ones (`run_in_terminal does not take "maxResults"; allowed: …`), a
  missing tool points to `list_tools` and `request_tools`, and edit, rename,
  binary-file, web, `run_checks` and round-limit errors say what to do next.
  `send_to_terminal` says that `text` is required unless `interrupt` is true,
  memory search takes `full`, and every terminal and check parameter has a
  description.
- Changed: `chat.tool_results.execution_errors` and
  `chat.tool_results.truncated` log the tool names and the start of each
  error.

## 2.1.0 (stable release) - 2026-11-26

Consolidates the 2.0.12 and 2.0.13 development builds below.

- A chat cleans its own context over `llamacpp.chatContextBudget`: stale tool
  results become one-line stubs and older turns are summarized; a **Context
  cleaned** card shows what left. The cleaned history fits a provider switch
  and Claude's replay whole.
- Two or more Claude subscriptions, like the Codex accounts; a limit card
  offers **Continue on Claude 2** / **Continue on Codex 2**.
- **Always allow** on approval cards, by the kind of action, kept in the user
  setting `llamacpp.chat.alwaysAllow` and listed under **Always allowed**.
- Weekly limits show the right reset, and auto-continue waits for it.
- A subagent call to a used-up model answers at once; subagents get 1000
  rounds; the new `changes_diff` tool shows the agent's changes as a diff.
- One bad tool call no longer ends the turn for local and API models.
- Local-server probes back off to 5 minutes while the server is off; the
  compaction summary falls back to a local model and the chat model.
- The documentation keeps one current reference per topic.

## 2.0.13 (development build) - 2026-11-25

- Fixed: one bad tool call no longer ends the turn for local and API models
  (seen as a DeepSeek subagent stopping with `$.maxResults is not allowed`).
  An argument the tool's schema does not list is dropped when the call is
  valid without it. The valid calls of a round are passed on before a bad one
  is rejected, and a bad call after calls already passed on is skipped: those
  calls run, and the model reads `[tool call guard] The … call was not run:
  <reason>` and can call it again. A bad call before any other is still
  retried once with a correction prompt, as before.
- Changed: the documentation was cleaned up. Finished plans, old audits,
  `docs/BUGS.md` (a closed August registry) and one-off research and incident
  notes were removed; their still-valid facts moved into the reference
  documents. `docs/CURSOR_CONTINUITY.md` is now `docs/CURSOR.md`,
  `docs/PROVIDER_ARCHITECTURE.md` became the "Provider contracts" section of
  `docs/ARCHITECTURE.md`, and the remaining documents no longer describe the
  removed Copilot Chat integration. The removed files stay in git history.
- Added: a chat cleans its own context instead of growing until you start a
  new one. Over `llamacpp.chatContextBudget` (200,000 tokens by default, 0
  turns it off), a new request first replaces stale tool results of earlier
  requests with a one-line stub, then summarizes older turns, down to about
  60% of the budget. Stale means a file read that was edited or read again
  later, a command or check that ran again, a search or listing from an
  earlier request, or a large result two requests old. Sizes are measured in
  the provider's tokens, so a session the provider compacted itself does not
  trigger a cleaning. The first request after a cleaning starts the
  provider's session again from the cleaned history (`_aabHistoryReset`,
  handled like a model switch by Claude, Codex, Cursor and Coco; HTTP models
  drop their compacted snapshot), so the cache is rebuilt once per cleaning.
  A **Context cleaned** card shows what left the context; the full messages
  stay in the chat. Session Quality counts the cleanings and the tokens saved.
- Changed: a model switch compacts the already cleaned history, and only when
  it is still over `llamacpp.providerSwitchContextTokens`; a switch keeps the
  stubs of a cleaning.
- Fixed (found in the first live cleaning): the new Claude session replays the
  history within `providerSwitchContextTokens`, and a cleaned history of 120k
  tokens did not fit, so Claude dropped its oldest 189 messages together with
  the chat's summary. A cleaning now also stays within 70% of that limit, and
  a replay that still has to drop old messages keeps the summary
  (`<conversation_summary>`) after the instructions: in Claude's cold start
  and in the shared handoff of Codex, Cursor and Coco. The cleaning card
  counts only the stubs in kept messages, not results that went into the
  summary.
- Changed: a call to a subagent model whose subscription limit is used up on
  every account starts nothing and answers at once: `"GPT-6-Luna (Codex)"
  cannot start: … It resets at about 18:40. No subagent was started. Choose
  another model: …`, instead of `Unknown subagent model`. The tool description
  lists such models as used up, and an open subagent on one answers its next
  task the same way and stays open. Codex subagent profiles now carry the
  reset time.
- Changed: the compaction summary falls back DeepSeek → a local llama.cpp
  model (at least 32k context, two minutes) → the chat model → an extract. An
  empty DeepSeek balance is remembered for 30 minutes per key instead of being
  asked on every compaction.
- Changed: with the local server off, background probes of `/v1/models`,
  `/slots` and the provider directory back off from 15 s to 5 min (about 0.6
  requests a minute instead of 3). A success, a change of
  `llamacpp.localServerUrl` or `llamacpp.enableLocalServer`, **Refresh
  Models**, **Run Provider Health Check** and **Recheck** in the Providers
  Manager reset the pause; a chat request to a local model always tries.
- Changed: `scripts/chat-harness-shots.mjs` serves the harness itself on a
  random local port and takes `--widths=320,420,1000`.
- Added: the `changes_diff` tool returns a unified diff of the agent's changes
  from the Keep/Undo snapshots: the running turn with its subagents' edits, or
  everything waiting for Keep or Undo. A file list with line counts comes
  first; `paths`, `contextLines` and `maxChars` (40,000 by default) narrow it.
  A reviewer subagent can call it, and the delegation guide tells the agent
  so. It is read-only and starts no snapshot.

## 2.0.12 (development build) - 2026-11-25

- Changed: a subagent stops after 1000 tool rounds instead of 100; a broad
  review ran out of rounds before its report.

- Added: two or more Claude subscriptions, like the Codex accounts. Quick
  Access → Claude → **Add Claude Account…** (or `llamacpp.claudeAccounts`)
  gives an account its own `CLAUDE_CONFIG_DIR` (`~/.claude-<id>`); its chat
  sessions, usage probes and `claude auth` commands run with it, so both logins
  coexist and signing out of an added account leaves the built-in one alone.
  The picker shows a group per account with its own limits; subagents list
  each Claude model once and start on the active account, then on the next one
  with room; an open subagent moves to the same model of the other account.
- Added: when a limit stops an answer and another subscription of the same
  provider has room, the limit card offers **Continue on Claude 2** or
  **Continue on Codex 2**. The chat takes that subscription's model and
  continues the answer like Retry.
- Fixed: Quick Access tooltips said that only the active Codex account's
  models appear in the picker; every account's models do.

- Fixed: a weekly Claude or Codex limit could show a reset a few hours away,
  and auto-continue then ran into the same limit again. The reset text with a
  date (`resets Nov 28, 4pm`, `try again at Nov 28th, 2026 4:12 PM`) was not
  understood, Claude's `session`, `Opus` and `Sonnet` limit names gave no
  window, and with both Codex windows used up the 5-hour one decided. The
  window and reset now come from the provider's own report when there is one:
  Claude's rate-limit event of the request or a fresh usage report, Codex's
  window that resets later.
- Changed: a weekly limit keeps the **Continue automatically after the
  reset** box on the limit card, cleared; tick it to continue at the reset.
  Waits of a day or more read in days (`in 2 d 5 h`), and the limit notice
  names the date (`28 Nov, 16:00 EET`).

- Added: **Always allow** on the chat's approval cards. It covers the kind of
  action, not the one file or command line: every create, edit, rename or
  delete outside the workspace, every folder deletion, or every command that
  one rule of `llamacpp.chat.dangerousCommands` holds (every `git restore`,
  every `rm -r`). The card names what it covers. The choice holds in every
  workspace and is saved in the new user setting `llamacpp.chat.alwaysAllow`,
  which a workspace's `.vscode/settings.json` cannot set. A waiting card of
  the same kind in another chat or subagent goes through at once.
- Added: **Always allowed** at the end of the Tools list shows what runs
  without a card, with **Revoke** for each entry. The command **SubHarness:
  Manage Always Allowed Actions** (formerly "Allow External Tools Without
  Asking") lists and revokes them as well.
- Fixed: a command that matches several dangerous-command rules, such as
  `git restore x; rm -rf y`, named only the first one. The card now names
  every matched rule, and **Always allow** lets the command through only
  once all of them are allowed. Deleting a folder outside the workspace names
  both reasons.
- Removed: **Allow without asking…** beside external tool groups. It opened
  VS Code's own tool approval, which VS Code applies only inside its own chat
  sessions, so it never stopped the dialog for calls from this chat and could
  not show whether an approval existed. The group's note now says that tools
  which may change something, such as MCP tools not marked read-only, ask in
  VS Code's own dialog every time.

## 2.0.11 (stable release) - 2026-11-23

- Fixed: a subagent on DeepSeek missed the prompt cache after its system
  prompt and task on every tool round; requests to deepseek-flash kept about
  8–9k cached tokens of a 15–45k prompt. A subagent runs without the parent's
  conversation id, so the provider picked the shared memory block again every
  round, and its query included the latest tool results: the same entries
  came back in a different order right after the task. The one round with an
  unchanged order hit 99%. A subagent now gets memory once in its task
  message, like a chat message, and the provider adds no block of its own;
  the same run now caches 92–98% from its second round.
- Fixed: the provider's memory query uses only the user's messages, not tool
  results, so a run without a conversation id keeps the same memory block
  across tool rounds.
- Changed: with two or more ChatGPT accounts, Codex subagents are no longer
  bound to the active account. Every signed-in account offers its Luna and
  Terra, and the subagent list shows each model once (`GPT-6-Luna (Codex)`).
  A subagent starts on the active account, or on the next account in list
  order (Codex 1, Codex 2…) while the active one's 5-hour or weekly limit is
  used up; a limit a request just hit counts at once, before the next usage
  report. A signed-out account offers no subagents. Before, a used-up active
  account took every Codex model out of the subagent list although the other
  subscription had room.
- Changed: an open subagent whose account runs out or signs out moves to the
  same model of another account on its next task and keeps its conversation
  (the log shows `chat.subagent.moved`).

## 2.0.10 (stable release) - 2026-11-23

- Fixed: HTTP providers (DeepSeek, OpenAI-compatible, local) received the
  whole saved chat instead of the chat's compacted history. The common journal
  restored messages the chat had compacted away, a leftover from the Copilot
  Chat integration removed in 2.0.8: a chat compacted to 107k tokens on a
  switch to DeepSeek arrived as 1.7M. Every provider now gets the chat's own
  messages; the journal remains the transcript prompts link to and still
  records which model answered last.
- Fixed: a compaction kept 75% of its input even far over the budget, so one
  request made up to three summaries (1.7M → 1.3M → 0.9M → 0.68M) and an
  overflow retry sent 713k tokens against a 475k budget. Proactive and
  overflow compaction now keep the configured share of the smaller of the
  current size and the soft input target.
- Fixed: after a server rejected tool-role results, every later request of
  the chat repeated the rejected attempt before falling back to user-style
  results, and the snapshot saved in user format never matched again, so the
  history was compacted and missed the prompt cache on every request. The
  fallback is now remembered for the chat until the window reloads.
- Changed: `chat.request.error`, `chat.request.final_error` and
  `chat.tool_result_mode.fallback` log the first 500 characters of the
  server's error text.

## 2.0.9 (stable release) - 2026-11-23

- Added: several `subagent` calls in one model response run in parallel, up
  to three at a time, instead of one after another. Their results go back to
  the model in call order, so the prompt cache keeps a stable order.
- Added: background subagents. `subagent` with `background: true` returns an
  id at once and the main agent keeps working; the new `wait_subagents` tool
  waits for and collects their reports (each report once). When a background
  subagent finishes, the next tool result says so. The turn lasts until its
  background subagents finish, so Keep/Undo, approvals and **Stop** cover
  them; reports that were not collected arrive as one automatic message after
  the answer. At most three background subagents run per turn.
- Added: a subagent's report ends with **Files changed by this subagent**:
  each file its tools wrote, with added and removed lines (new, deleted, or
  "changed" for binary and very large files).
- Added: the `run_checks` tool runs the project's checks without a terminal
  and returns each check's status and duration, the mocha, TypeScript and
  ESLint failures, and the path of the full log (the last 50 logs are kept).
  The checks are the package scripts `compile`/`build`, `lint` and `test`, or
  those in `.subharness/checks.json`. Checks whose command matches a
  dangerous-command rule ask for approval; Stop and the timeout end the whole
  process tree.
- Added: after `create_file`, `replace_string_in_file` and
  `multi_replace_string_in_file` the result lists up to 10 errors the edit
  introduced, once the language servers have checked the file (at most
  1.5 s). Setting `llamacpp.chat.diagnosticsAfterEdit` (on by default).
- Added: a terminal command that stops at a prompt such as `(y/n)`,
  `password:` or `Press Enter` returns early with the state
  `waiting for input` instead of waiting for the timeout. Progress bars and
  spinners redrawn with `\r` are reduced to their last state and repeated
  lines to one line with a count, so the output cap keeps useful text.
- Changed: an unknown terminal ID error says why the terminal is gone (killed,
  closed by the user, replaced after a timeout, its owner ended, or a window
  reload) and lists the caller's live terminals.
- Fixed: after Retry the model did not know what the interrupted attempt had
  done when the provider resumed its native session before that answer
  (Claude resumes at its last completed turn). The continuation message now
  carries a digest of the attempt from the chat log: the tool calls with their
  key argument and first result line, the files it edited, the todo plan and
  the end of its text.
- Changed: the main agent's delegation guide describes parallel and
  background subagents, the changed-files block, a review of non-trivial
  changes by a cheap subagent, and `run_checks`.

## 2.0.8 (stable release) - 2026-11-23

- Removed: the GitHub Copilot Chat integration. The extension's models no
  longer register with VS Code, so they are not in Copilot Chat's or the
  Agents window's model picker; they run in the SubHarness chat only. Removed
  with it: the Copilot Chat, workbench terminal and agent-host thinking
  patches with their commands (Apply Copilot Chat Patch, Show Copilot Chat
  Patch Status, Restore Original Copilot Chat, Recover Patch Permissions, the
  two patch toggles, Prepare User VS Code) and settings
  (`llamacpp.autoPatchCopilot`, `workbenchTerminalPatchEnabled`,
  `agentHostThinkingPatchEnabled`, `agentHistoryRounds`, `agentHistoryTurns`,
  `journalRenderRounds`, `journalRenderTurns`), the commands Continue Latest
  Codex Thread in New Chat, Continue Latest Claude Session in New Chat, Choose
  Chat Model and Choose Model by Provider, the Patches group in Quick Access,
  and the Agents window BYOK flag. Patches already applied to a VS Code
  installation stay as they are; a VS Code update replaces them.
- Changed: the extension contributes no VS Code language model tools. The
  memory tools are now the chat's own tools (same names, still in the
  SubHarness group of the tool picker); the Coco terminal bridge tools and
  `llamacpp_wait_for_terminal` are gone, Coco uses the chat's terminal tools.
  HTTP models no longer get `llamacpp_wait_for_terminal` added to their tool
  list, which the chat could not run.
- Changed: the system prompts of Claude, Codex, Cursor and Coco name the
  SubHarness chat as their host instead of Copilot Chat, and Copilot's
  `runSubagent` tool is no longer rewritten. The first request of each
  provider after the update misses the prompt cache once.
- Added: on Windows, clicking the system notification of a finished turn, an
  approval request or a question focuses the VS Code window that ran the chat
  and opens that chat, instead of starting a new VS Code window. The first
  click may show VS Code's one-time "Allow 'SubHarness' extension to open this
  URI?" prompt.
- Added: **Allow without asking…** beside the tool picker's groups of other
  extensions' and MCP tools, and the command **SubHarness: Allow External
  Tools Without Asking** (also in the chat view's **…** menu), open VS Code's
  Manage Tool Approval at profile scope. Marking a server such as Playwright
  as always allowed there stops VS Code's dialog that popped up over
  everything before each of its tool calls.
- Fixed: a screenshot or file pasted, dropped or picked in the chat's input
  while a sent message was being edited landed in that message's edit box,
  out of view, and the next message went out without it. Each request now
  carries the box it came from, and the answer goes back to that box; a late
  answer for a closed edit is dropped. The commands that add the editor
  selection or a file still go to the edit box while one is open.
- Fixed: in the edit box of a sent message, a picker that opened downward (the
  model, thinking level or tools picker near the top of the chat) showed under
  the following messages, and clicks on it reached those messages instead.
- Changed: when the input's bottom row does not fit on one line, the model,
  thinking and tools pickers stay on the first line, and the second line has
  the limit chip, cache hit and context counter on the left and the buttons on
  the right. The limit chip moved next to the cache hit; on a wide input the
  row is unchanged otherwise.

## 2.0.7 (stable release) - 2026-11-22

- Added: the chat's system prompt has a guide for subagents whenever the
  subagent tool is offered. It tells the main agent to plan the work, hand
  routine steps to the cheapest model that fits, do tiny steps itself, write
  self-contained subagent prompts (goal, files it may change, context, project
  rules, checks, report format), review every report, send fixes with
  `subagentId` and close accepted subagents, fall back to a model of similar
  size when one is unavailable and agree on large plans first. Subagents
  themselves do not get it, and repository instructions such as `AGENTS.md`
  still take precedence. The guide is part of the stable system prompt, so it
  stays in the prompt cache.

## 2.0.6 (stable release) - 2026-11-22

- Changed: with two or more ChatGPT accounts the chat's model picker shows one
  group per account: Codex 1 is the built-in `~/.codex` account, Codex 2,
  Codex 3… follow in the order of `llamacpp.codexAccounts`. Every account
  lists its models, not only the active one, and each group shows its own
  5-hour and weekly limits and is dimmed on its own when they are used up. The
  quota chip follows the selected model's account, a limit card names its
  group ("Codex 2 usage limit reached"), and each signed-out account gets its
  own "Sign in to Codex 2" entry. With one account the group stays "Codex".
- Changed: the active account (`llamacpp.codexActiveAccount`) now only decides
  which account subagents, Quick Access and the Codex status commands use.
  `llamacpp.codexShowAllAccounts` is removed.

## 2.0.5 (stable release) - 2026-11-22

- Changed: the chat moved to the secondary side bar, next to Copilot Chat,
  Claude Code and Codex. It stays there without a keyboard shortcut and keeps
  its view id, so menus and commands work as before. The first start after the
  update shows it once and gives focus back to the editor. Quick Access stays
  in the activity bar.
- Changed: the repository is renamed from `MrLordCat/ai-agent-bridge` to
  `MrLordCat/SubHarness`. The updater asks under the new name first and falls
  back to the former name while the new one answers 404, and it accepts
  release packages under both names. Versions before 2.0.5 reject packages
  under the new name, so they need one manual install of 2.0.5.
- Changed: the README presents the SubHarness chat and no longer describes the
  Copilot Chat integration or its patches. The release notes summarize
  1.21.1 to 2.0.5.

## 2.0.4 (development build) - 2026-11-22

- Changed: the extension is now called SubHarness, formerly AI Agent Bridge.
  The extension id, settings, commands and saved chats are unchanged, so
  existing installs update in place.
- Added: file links in chat answers open the file. This covers Markdown links
  such as `[report](docs/report.md#L12)`, `file:` links and file paths in
  inline code such as `src/chat/index.ts:40`. A link with a line opens the file
  at that line, and a folder link reveals the folder in the Explorer. A bare
  file name opens its only workspace match or asks which match to open.
  When the chat is an editor tab, the file opens in another editor group.
- Changed: links that the provider rewrites to `file:` URIs keep their line.
  Agents are told to link the reports and files they mention.

## 2.0.3 (development build) - 2026-11-21

- Fixed: the Keep/Undo list no longer reports existing ignored files as added
  when a workspace snapshot reaches the ignored-file limit.
- Fixed: the main agent's tools can run alongside a subagent when called in
  the same tool round.
- Fixed: Stop switches to a stopping status while changes are saved. When
  the chat reports that it stopped, Keep and Undo are ready.

## 2.0.2 (development build) - 2026-11-21

- Fixed: existing Codex and Claude bridge chats refresh tool schemas on the
  next turn so the model can start and continue an open subagent.
- Changed: Follow the Codex Sol window uses the newest Sol model with a known
  window. Luna and Terra usage leaves the shared context unchanged.

## 2.0.1 (development build) - 2026-11-21

The rest of the 2.0 work list in `docs/WORK_PLAN_2_0.md`.

- Added: a chat keeps its newest 1,000 requests with their answers. Older ones
  are deleted from the chat and its log file when the chat is opened or VS Code
  starts; nothing is deleted by age.
- Added: open subagents. A subagent started with `keepOpen` stays open after
  its report with its own context; the model sends it follow-up tasks with
  `subagentId` and closes it with the new `close_subagent` tool. **Open
  subagents** above the input lists them with their status and lets you close
  one; they are saved with the chat and survive a reload.

- Fixed: terminal spam. A run reuses an idle terminal of its own chat or
  subagent; a terminal whose sync command timed out and printed nothing for a
  minute is closed before a new one opens; a chat or subagent has at most four
  terminals, and the model gets the list of busy ones instead of a fifth.
- Changed: each chat and each subagent has its own terminals, named after it
  ("Chat 3", "Subagent: Fix tests 4"). A subagent's idle terminals close when
  it finishes.
- Added: an operating-system notification (Windows toast, macOS Notification
  Center, Linux `notify-send`) when a chat finishes, waits for an approval or
  asks a question while VS Code is not focused or is minimized.
  `llamacpp.chat.systemNotifications` turns it off.
- Added: after the 5-hour Codex or Claude limit the chat continues by itself a
  minute after the reset, also in a background chat and after a reload. The
  limit card has a checkbox to turn it off; it stops after three continuations
  that hit the limit again.

## 2.0.0 (development build) - 2026-11-21

The 2.x line starts here; the release gets a new name. The plan is in
`docs/WORK_PLAN_2_0.md`.

- Changed: the chat's context indicator shows the model's full window (475k
  for a 475k Codex model instead of 443k). Its tooltip names the tokens
  reserved for the answer; compaction limits are unchanged.
- Fixed: images the agent looked at could not be opened from the chat. A click
  on the image line of a tool result opens it in VS Code's image viewer.

## 1.21.51 (development patch) - 2026-11-21

- Fixed: in a light theme, error and warning text in the chat was hard to
  read (Light Modern's red and yellow reach about 3:1). It is darkened to pass
  4.5:1; borders, bars and dark or high-contrast themes keep their colors.
- Changed: a wide editor tab keeps the messages, panels and input in one
  centered column of about 880 px instead of the full width.
- Changed: limit, compaction and subagent cards share the same inset.
- Added: `scripts/chat-harness-shots.mjs` saves screenshots of the chat harness
  in fixed scenarios (light theme, cards, wide tab, 320 px sidebar) without
  dialogs.
- Fixed: eight chat controller tests failed now and then. Since 1.21.48 the
  chat shows a run while it still prepares the turn, and these tests took that
  for a started model request; they now wait for the request itself.

## 1.21.50 (development patch) - 2026-11-21

- Fixed: a `request_tools` card with more than ten tools could not be answered.
  The host dropped an answer with more than ten selected tools, so **Enable**
  and **Deny** greyed out after a click and the card stayed until the next
  message dismissed it as a denial. Answers now take as many tools as one
  request may ask for (30).

## 1.21.49 (development patch) - 2026-11-21

- Added: **↓** at the bottom right of a chat scrolled up returns to the latest
  message; a dot marks a new message or a growing answer.
- Added: **Copy** under an answer copies its text as Markdown, and **⧉** next
  to a sent message copies that message. Hovering an answer shows its time; a
  sent message has it in the tooltip.
- Added: a sent message longer than twelve lines or 800 characters is folded
  with **Show more**.
- Added: **↑** in the empty input edits the last sent message.
- Added: chats can be renamed (**✎** in the chat list) and exported to a
  Markdown file (**⤓**). A chosen name stays through new messages and edits;
  an empty one brings the automatic title back.
- Changed: in the model picker, Tab moves through the stars without closing the
  list, a focused star is outlined, and **Ctrl+D** (**Cmd+D**) in the search box
  stars the highlighted model.

## 1.21.48 (development patch) - 2026-11-21

- Fixed: a queued message was lost when its delivery failed or no model was
  left. It now comes back into the input with a notice; in a chat you are not
  looking at it becomes the chat's draft.
- Fixed: while the bridge read the attachments and memory of a sent message,
  there was no **Stop**, and Stop or deleting the chat did not cancel the send.
  **Stop** now shows at once and stopping there sends nothing and returns the
  text to the input; a deleted chat starts no request.
- Fixed: with several Codex accounts, the subagent list kept only the models
  of the account listed last. Each account now keeps its own Luna and Terra,
  and an account that is hidden, signed out or off drops its own.

## 1.21.47 (development patch) - 2026-11-21

- Fixed: Codex models, the Luna and Terra subagents above all, refused to edit
  files: Codex told them "The sandbox only permits reading files" and to ask
  for escalation. Codex threads now leave out that permissions message
  (`include_permissions_instructions = false`). The read-only sandbox stays and
  still fences Codex's internal tools; edits and commands go through the
  VS Code tools as before.

## 1.21.46 (development patch) - 2026-11-21

- Changed: a failure the status and model polls repeat (no Codex CLI, an
  unreachable local server) is logged when it starts or its message changes,
  then at most every 10 minutes with the number of skipped repeats. A Codex
  recovery is logged as `codex.status.recovered`.
- Fixed: on Windows, saving the cache session state failed with `EPERM` when
  another window or a virus scanner held the file. The replace is retried
  three times, and a failed write no longer leaves a `.tmp` file behind.

## 1.21.45 (development patch) - 2026-11-20

- Fixed: with no model available, a message sent in the bridge chat was lost:
  the input and the draft were already cleared. It now comes back into the
  input with its attachments, next to the notice. An edit or a retry without a
  model changes nothing.
- Fixed: editing a message with **Undo changes** cut the chat and sent the new
  text even when the files could not be restored. The edit now stops and an
  error says why; the chat and the files stay as they were.
- Fixed: a file the chat could not attach (over 2 MB, binary, unreadable) was
  reported only to the model. Its chip under the sent message now shows **⚠**
  and the reason. When reading the attachments fails as a whole, the model is
  told which files are missing instead of getting no attachment block.
- Fixed: `send_to_terminal` sent `\u0003` or `^C` as text, so Ctrl+C never
  reached the command. It now has `interrupt: true`, and those texts also
  interrupt; the chat shows "Interrupted the terminal command".
- Fixed: in the chat list, Enter on the **New chat** or delete button opened
  the highlighted chat. List keys now act only from the search box.
- Fixed: a code block's **Copy** said nothing when the clipboard failed; it now
  shows "Copy failed". The message inputs have accessible names.
- Changed: tool descriptions say relative paths start from the first workspace
  folder, and `read_terminal` that `waitMs` 0 returns at once.
- Fixed: the Codex Terra subagent refused edits because Codex reports its
  internal sandbox as read-only. The Codex instructions now say that the
  sandbox binds only the internal Codex tools, not the VS Code tools that edit
  files and run commands.

## 1.21.44 (development patch) - 2026-11-20

- Changed: Codex subagents come only from the 6.x family. A 5.x Luna or Terra
  is no longer offered as a fallback, so an account without 6.x models has no
  Codex subagent.

## 1.21.43 (development patch) - 2026-11-20

- Fixed: Codex and Claude subagents never started in the bridge chat. Their
  subagent list used bare model ids (`gpt-5.6-luna`), while the chat looks the
  model up by its full id (`codex::gpt-5.6-luna`), so every call ended with
  "is not available right now". Both now register the chat model ids.
- Changed: from Codex the subagent list offers the newest Luna and the newest
  Terra of the subscription (now GPT-6-Luna and GPT-6.1 Terra) instead of only
  the 5.6 models, which Codex marks as legacy. Luna is described for small,
  well-defined steps (an edit in one or two files, a search, a test run), Terra
  for larger multi-step steps (several files with their tests, a refactoring),
  and Luna, the cheaper one, comes first. Before, both had the same description
  and Terra was wrongly called the cheaper one. Sol is still never a subagent.

## 1.21.42 (development patch) - 2026-11-20

- Added: favorites in the bridge chat's model picker. **☆** next to a model
  stars it; once a model is starred, the picker opens on the starred models,
  grouped by provider, plus the selected one, with **Show all models** below
  them. A search always covers every model. Stars are kept for every workspace.
  Only the model list scrolls now, so the search field and the buttons under
  the list stay in view.
- Added: when an answer used tools, its text after the last tool round is
  shown in a separate **Answer** block with a tinted background and a blue
  edge, apart from the commentary between the tool calls. It appears once the
  answer is complete; answers without tools look as before.

## 1.21.41 (development patch) - 2026-11-20

- Added: clicking the context counter in the bridge chat (`13.5k / 400k`)
  opens a popup with the **Shared context** slider for Codex, Claude, Coco and
  Cursor, the **Follow the Codex window** toggle (it shows the followed Codex
  model and window and disables the slider once that window is known), and the
  **Model switch** slider for the most a model receives when it takes over a
  chat. A value is saved when the slider is released. The popup edits the same
  settings as Provider Context, and a change in either place shows in the
  other.

## 1.21.40 (development patch) - 2026-11-20

- Fixed: compaction when another model takes over a bridge chat no longer
  shrinks a long task to its summary (397k → 11k tokens before). Cuts were
  only possible between your messages, so one long turn that did not fit the
  110k target went into the summary whole. Now the turn that does not fit keeps
  your request and the newest tool rounds of its answer, and only its earlier
  rounds are summarized. Tool results longer than 12,000 characters in the
  older kept turns are shortened to their start and end instead.
- Changed: the summary may be up to 32,000 characters (16,000 before) and
  carries your summarized requests verbatim; before, the extract turned a
  request into `<context> | </userRequest>`. It also names the chat's log file,
  so the model can look up what the summary left out.
- Added: when DeepSeek cannot write the summary (no key, an error, an empty
  balance), the model taking the chat over writes it from the same prompt,
  without tools; the extract is the last resort. The compaction card shows who
  wrote the summary, why a fallback was used, and the requests it kept.

## 1.21.39 (development patch) - 2026-11-20

- Fixed: **Retry** on a failed or interrupted answer no longer throws away its
  work. Before, it cut the chat back to the request, dropped the turn's files
  from Keep/Undo and sent the request again; Coco then refused it with "The
  previous Coco native turn was interrupted". Now the answer, its tool results
  and its file changes stay, and the bridge sends the model a continuation
  message with the error that stopped it, asking it to finish the task without
  repeating finished steps. The chat shows that message as a one-line marker
  that cannot be edited. To start a request over, edit it.

## 1.21.38 (development patch) - 2026-11-20

- Fixed: a Coco turn no longer ends with "Coco attempted an internal action"
  when Coco reaches for its built-in `write`, `edit` or `bash`. The bridge
  refuses the CLI's permission request with the one-time `reject_once` option:
  nothing runs, the turn continues, and its work and Keep/Undo changes stay.
  The next tool result tells Coco that the bridge refused the action
  automatically, not the user, and names the VS Code tools to use instead; if
  Coco ends its turn without another tool call, the same note goes as a
  follow-up prompt (at most twice). The turn still stops after eight refusals
  in one turn, and for built-in actions that run without asking permission.

## 1.21.37 (development patch) - 2026-11-20

- Added: Codex works without the OpenAI extension. When no Codex CLI is found
  (no `openai.chatgpt` extension, no `codex` on PATH, no `llamacpp.codexCliPath`),
  **Sign In to Codex Subscription** offers to download the official CLI from
  the npm registry: the `@openai/codex` platform package, about 185 MB to
  download and 530 MB on disk, kept in the extension's storage. The download is
  checked against the registry's sha512 and must start before it is used; the
  voice runtime is left out. **Install or Update Codex CLI** (Quick Access →
  Codex, Providers Manager) installs or updates it, and the new version
  replaces the old one. Without a CLI the status says "Codex CLI not
  installed".
- Added: Claude signs in without the Claude Code extension. **Sign In to Claude
  Subscription** runs the bundled Claude Code `auth login --claudeai` in a
  terminal and reads the result with `auth status`; a sign-in with API billing
  gets a warning. Sessions of the previous account are dropped. **Sign Out of
  Claude** runs `auth logout`, which signs Claude Code out on this computer,
  the Claude Code extension included. The account status names the sign-in
  method and plan, never the email.
- Added: the bridge chat's model picker offers **Sign in to Codex** and **Sign
  in to Claude** while that subscription is enabled but not signed in.

## 1.21.36 (development patch) - 2026-11-20

- Added: the bridge chat keeps unsent text and attachments per chat. They come
  back after switching chats and after Reload Window; a new chat that holds
  only a draft is no longer removed when you leave it.
- Added: Ctrl+V in the bridge chat attaches a screenshot or files copied in
  the system file manager, and files dragged from the file manager attach as
  well. Pasted files are saved in the extension's storage for 30 days. Image
  attachments (PNG, JPEG, GIF, WebP up to 3.75 MB) now reach models that
  accept images; other models get a note instead.
- Changed: the limits chip and the model picker show the 5-hour window; the
  weekly window appears only once it is used up. The tooltip and the popup
  still list every window.
- Changed: a bridge chat turn no longer stops after 100 tool rounds; it runs
  until the model stops calling tools or you press Stop. Subagents keep their
  100-round bound.
- Fixed: Claude reported the same usage again when a tool round brought no new
  model step (for example a second tool call of the same step), so the chat
  counted extra requests and inflated its totals. Claude also took a step's
  usage only from the full assistant message, which can arrive after the tool
  call; a round then reported the previous step or nothing. Usage now comes
  from the step's stream start and is reported once per step.

## 1.21.35 (development patch) - 2026-11-20

- Fixed: Coco and Cursor sessions that continued, even after a window reload,
  never received changed system instructions, such as new base rules of the
  bridge chat or an edited AGENTS.md: only the environment blocks were sent
  again. The bridge now saves a hash of the instructions with the session and
  sends them once more when they change. Sessions saved by an older version
  get them once.
- Fixed: the subagent model list put every model from an API profile into the
  local group, so Cursor models (Opus 5.5, GPT-5.6 Sol and others) were offered
  as free local models "without token or rate limits". The group now follows
  the model's source: llama.cpp servers, local addresses and llama.cpp behind a
  gateway are local; DeepSeek is DeepSeek; other API profiles form a new paid
  group that comes last and is used only on request. It has its own branch in
  the Subagents tree.
- Fixed: a model name that appeared twice (two Cursor "Auto" models) was
  listed twice for subagents; it is listed once.

## 1.21.34 (development patch) - 2026-11-20

- Fixed: Coco saw only the first 500 characters of each tool description (a
  Cortex CLI limit), so long ones stopped mid-word and the bridge chat's
  `subagent` tool lost its whole model list. Descriptions now go without the
  "VS Code Chat tool …" prefix, with collapsed whitespace, and a longer one is
  cut at the last sentence end that fits. Under Coco the `subagent` tool names
  its models in the `model` parameter.
- Changed: shorter descriptions for the chat's `run_in_terminal`, `subagent`
  and the extension's `llamacpp_coco_run_in_terminal`,
  `llamacpp_wait_for_terminal` and `llamacpp_store_memory`; every one fits in
  500 characters, and a test keeps it so.
- Changed: the bridge chat's instructions tell the agent to use `list_tools`
  and `request_tools` when the enabled tools are not enough; subagents are told
  they cannot enable tools. Coco's policy does the same when those tools are
  offered, and otherwise still asks it to explain the limitation.

## 1.21.33 (development patch) - 2026-11-20

- Fixed: the bridge chat never showed a prompt cache hit for Coco models
  (always "cache n/a"). Coco's per-request usage is the context size only; its
  real counters (cache reads and writes) come once, when the native answer
  ends. Coco now sends them to the bridge chat as a separate part; Copilot
  chats do not get it, and Coco's context usage is unchanged.
- Fixed: the chat's cache percentage counted requests that report no cached
  tokens, which lowered the rate. Only requests with cache counters count now.
  Older saved chats are read as before when all their requests reported cache.

## 1.21.32 (development patch) - 2026-11-20

- Fixed: Coco asked for a Snowflake sign-in after every window reload and every
  few minutes while it was not signed in, even when unused. Each status check
  starts a Cortex CLI process, and with Snowflake 1.44.0 each new process can
  open a browser sign-in (a CLI token-cache bug). The last check result is now
  saved across reloads, and an automatic check runs only for a CLI path or
  connection with no saved result. Failed checks are not retried by
  themselves; a Coco turn or **Connection Status** checks again.
- Changed: a manual Coco check waits up to 180 seconds and shows "Waiting for
  Snowflake sign-in". After a successful check the CLI gets 5 seconds to exit
  on its own before it is stopped. Failed checks log their kind (timeout, sign-in,
  CLI missing) with secrets redacted.
- Fixed: the README development block named 1.21.30 in the 1.21.31 build.

## 1.21.31 (development patch) - 2026-11-20

- Added: the bridge chat agent can list every tool the chat offers, including
  disabled ones (list_tools), and ask you to enable the ones it needs
  (request_tools). You approve them in a card; approved tools stay on.
- Fixed: in the bridge chat, Claude models now get tools enabled during a
  conversation with the next message. The live session resumes as a fork with
  the new tool list; before, it kept the tools it started with. Copilot chats
  are unchanged.

## 1.21.30 (development patch) - 2026-11-20

- Added: a memory panel in the bridge chat header. It lists this project's and
  the global memory entries with search and a scope filter, and lets you read,
  edit, pin, delete and add entries.

## 1.21.29 (development patch) - 2026-11-20

- Added: the bridge chat gives every provider the shared memory, not only the
  HTTP one. A message carries the index of entries, the pinned entries and the
  ones that match it; later messages carry only changes, so prompt caches stay
  valid. The HTTP provider skips its own memory overlay for chat requests.
- Fixed: a flaky teardown in the chat controller tests (ENOTEMPTY while
  deleting the temp folder).

## 1.21.28 (development patch) - 2026-11-20

- Added: the bridge chat's own manage_todo_list and ask_questions tools. The
  agent's todo list shows above the input (Todos done/total, click for the
  list). Questions appear in a card with options, a recommended choice and a
  text field; Skip, Stop or sending a message dismisses them. A chat in the
  background that waits for an answer shows "Waiting for you".

## 1.21.27 (development patch) - 2026-11-20

- Added: the bridge chat's view_image tool shows a PNG, JPEG, GIF or WebP file
  (up to 3.75 MB) to the model. Images returned by MCP and extension tools now
  reach the model too instead of being dropped; the chat shows each image's
  name and size under the tool result.

## 1.21.26 (development patch) - 2026-11-19

- Added: native bridge chat tools that replace Copilot's:
  multi_replace_string_in_file (several exact edits in one call, failures
  reported per item), fetch_webpage (http(s) pages as text with links, long
  pages filtered by a query), and list_code_usages, rename_symbol and
  workspace_symbols through the language servers. They appear in the Tools
  picker under Files, Search and the new Web group.

## 1.21.25 (development patch) - 2026-11-19

- Added: the bridge chat's model picker shows each provider's limits or
  balance and fetches them again when it opens or a model is picked. A provider
  with a used-up limit is dimmed with its reset time, and a warning above the
  input says so while one of its models is selected.

## 1.21.24 (development patch) - 2026-11-19

- Added: you can write to the bridge chat while the agent works. Send queues
  the message above the input and the agent reads it after the tool calls it is
  running now; several queued messages go out together and can be removed
  before that. Stop stays a separate button and puts queued messages back into
  the input.

## 1.21.23 (development patch) - 2026-11-19

- Changed: the bridge chat's changed-files list updates after every tool call
  that may write, so created, edited and deleted files show up while the agent
  works instead of only when the answer ends.
- Fixed: files excluded by .gitignore were missing from the changed-files list.
  They are recorded now, except build and dependency folders (node_modules,
  out, dist, build, .vscode-test and similar) and ignored files over 1 MB.
- Changed: the bridge chat no longer offers tools that only work inside
  Copilot Chat: the Copilot Chat extension's tools and the VS Code chat tools
  for questions, todo lists, chat terminals, tasks and the integrated browser.

## 1.21.22 (development patch) - 2026-11-19

- Fixed: grep_search in the bridge chat found nothing when includePattern
  named a subfolder, such as src/chat/**/*.ts. It also accepts ./ prefixes,
  backslashes and an absolute folder inside the workspace.
- Changed: create_file writes the line endings of neighbouring files of the
  same type (CRLF in this repository), falling back to files.eol.
- Added: delete_file in the bridge chat. Deleting a folder or anything outside
  the workspace asks first; deletions inside the workspace can be undone.
- Changed: chat terminals no longer open a pager for git, and terminal tools
  return plain text with the last 30,000 characters instead of escaped JSON,
  saying when earlier output was cut.
- Changed: tool output of the running answer is shown in full; older answers
  show a preview that says how much is left and loads on expand. Subagent
  steps can be expanded to show their input and the start of their output.

## 1.21.21 (development patch) - 2026-11-19

- Fixed: the bridge chat could hang when it opened a chat with a very long
  answer (many tool calls or a subagent). The view kept correcting its scroll
  position before it could measure the messages, and the window used one CPU
  core and several gigabytes of memory until VS Code was reloaded.
- Fixed: messages could disappear from a chat after scrolling them out of view
  and back. A message leaving the view reported a height of 0, which hid it for
  good.
- Fixed: model, thinking, tools and limit popups open downwards when there is
  no room above, for example while editing the first message.

## 1.21.20 (development patch) - 2026-11-19

- Added: a live prompt-cache indicator in the bridge chat composer. It shows
  the cache hit share of the selected model over its turns since it took
  over the chat, starts again after a model switch, and updates after every
  request; the tooltip lists cached and prompt tokens, the request count and
  the last request's hit rate.
- Changed: the bridge chat composer is one rounded box like Copilot Chat:
  attachment chips, the input and a flat toolbar with the model, thinking
  level, tools and quota, plus a round send button. The changed-files bar
  sits on top of the box.

## 1.21.19 (development patch) - 2026-11-19

- Changed: long bridge chats open much faster. Tool output reaches the chat
  window as a 600-character preview and long thinking as its last 1,000
  characters; both load in full when you expand them. A chat with 2,000
  messages and 3,000 large tool results now opens with about 2.4 MB instead
  of 14 MB.
- Added: recovery after VS Code closes or reloads while an answer runs. The
  chat reopens with a note that the answer was interrupted and a Retry
  button, and the changes panel says when files changed by such a turn could
  not be listed for Keep/Undo. Failed answers also get Retry, which sends the
  same message again with its attachments.
- Docs: [bridge chat guide](docs/CHAT.md).

## 1.21.18 (development patch) - 2026-11-19

- Changed: click a sent message in the bridge chat to edit it. The editor in
  its place is the full input: model, thinking level, tools, limits and
  attachments (📎, chips, Shift+drop) work as for a new message. Escape or
  Cancel closes it. Removing or adding attachments sends the new set;
  unchanged attachments are sent exactly as before.
- Fixed: scrolling up slowly near the end of a chat snapped back to the bottom,
  and scrolling through older messages jumped while their real heights were
  measured. Any upward scroll now releases the bottom, and the view stays put
  when messages above it change size.
- Changed: easier to read chats. Tool calls are one-line rows such as
  "Read message.tsx lines 210-260" or "Ran npm test", with a status mark;
  click a row to see its input and output. A subagent is one collapsed card
  showing its model, task and current step; expand it for the prompt, the
  steps and the report. Collapsed thinking shows its latest line. Calmer
  spacing and typography, notices with a level mark, and Send always on the
  right of the input.

## 1.21.17 (development patch) - 2026-11-19

- Added: attachments in the bridge chat. The 📎 button picks the editor
  selection, the active file, open editors, workspace files or any file on
  disk; Shift+drag files from the Explorer onto the input works too, and the
  editor and Explorer context menus get "Add Selection to Chat" and "Add File
  to Chat". Attachments show as chips above the input and under the sent
  message; clicking one opens the file at the attached lines. Files are read
  when the message is sent (unsaved editor content included), capped at
  60,000 characters each and 150,000 per message; binary and very large files
  are named but not included. Editing a message keeps its attachments exactly
  as first sent.

## 1.21.16 (development patch) - 2026-11-19

- Added: bridge chats keep working in the background. Opening another chat
  or starting a new one no longer stops the running turn, and several chats
  can run at the same time. A badge in the chat header counts the chats that
  are running, waiting for an approval or finished unseen; the chat list marks
  them too. When a background chat needs an approval, a notification offers to
  open it. Stop only stops the chat you are looking at.
- Changed: Keep/Undo stays per chat while chats run in parallel. When another
  chat worked at the same time, a chat lists only the files its own edit tools
  wrote and says how many other changed files it left out, so Undo in one chat
  cannot revert another chat's work.

## 1.21.15 (development patch) - 2026-11-19

- Added: a chat history in the bridge chat. Click the chat title, or the
  history button in the view title, to search earlier chats grouped by day,
  switch to one, start a new chat or delete a chat after a confirmation. The
  arrow keys, Enter and Delete work in the list. A chat keeps its model when
  you return to it. Files the agent changed stay as they are when their chat
  is deleted.
- Changed: leaving a chat that never got a message removes it, so New Chat no
  longer fills the history with empty chats. Switching chats stops a running
  turn and tells the provider the old chat was left.

## 1.21.14 (development patch) - 2026-11-19

- Added: a thinking picker in the bridge chat composer for models that offer
  reasoning levels (Codex, Claude, DeepSeek and others). The choice is saved
  and sent with every turn.
- Added: a limits chip in the composer. It shows the most used Codex or Claude
  window, or the DeepSeek balance, for the selected provider. Click it to see
  every provider's windows with reset times. It refreshes when opened and
  after each turn.
- Changed: the composer controls wrap onto a second line in a narrow chat
  instead of squeezing the model name, and pickers stay inside the window.

## 1.21.13 (development patch) - 2026-11-19

- Fixed: after a tool was renamed or removed, DeepSeek and other API models
  could keep seeing the old tool in a chat that had already used it, as long
  as the number of tools stayed the same. In the bridge chat the model kept
  calling `run_subagent` with its old schema after the tool became
  `subagent`. The stored tool list is now rebuilt when a tool in it no longer
  exists. Only tools of MCP servers, which often swap tools between restarts,
  may still linger to keep the prompt cache.

## 1.21.12 (development patch) - 2026-11-19

- Fixed: subagent calls from the bridge chat still failed with "$.model is
  not one of the allowed values" after 1.21.11. Two causes:
  - To keep the prompt cache warm, DeepSeek and other API models kept sending
    a stored copy of the tool list while the number of tools stayed the same.
    That copy still had the old `run_subagent` schema with its fixed model
    list, and tool calls were checked against it. A tool whose schema changed
    now replaces the stored copy once; a changed description alone still
    keeps the cache.
  - The bridge treated a tool named `run_subagent` as Copilot's `runSubagent`.
    It attached Copilot's model rules to it and, for Codex, Claude, Coco and
    Cursor, a fixed list of `… (llamacpp)` names. The chat tool is now called
    `subagent`.
- When a provider rejects a tool call and the turn stops, the chat says which
  tool call was rejected instead of showing only the validator message.

## 1.21.11 (development patch) - 2026-11-19

- Fixed: a `run_subagent` call could end the whole chat turn with
  "$.model is not one of the allowed values". DeepSeek and other API models
  have their tool calls checked against the tool's schema, and a model name
  that differed slightly from the listed one failed that check. When another
  tool call had already been sent in the same reply, the request could not be
  retried. The tool now accepts a name without the provider suffix or with
  different spelling, such as `deepseek-flash` or `DeepSeek Flash`. An
  unknown name returns the list of valid models, so the model can correct
  the call and continue.

## 1.21.10 (development patch) - 2026-11-19

- The bridge chat has subagents. The model can hand a bounded subtask to
  another model with the new `run_subagent` tool: the subagent works with the
  same tools but without the conversation, and the chat model receives only
  its final report. The model list comes from the bridge's subagent catalog,
  cheapest first; Codex Sol and subscriptions at their limit are left out.
- A subagent appears as a card with its model, task and live status
  ("Working… 4 steps · 16 s"). The card lists the tool calls it made and
  shows the report. Its file changes join the same Keep/Undo panel, and its
  dangerous commands wait for approval like any other.
- Subagents can be turned off in the tool picker under **Subagents**.

## 1.21.9 (development patch) - 2026-11-18

- When Codex or Claude hits a usage limit, or a DeepSeek or other API balance
  is empty, the bridge chat shows a card with the provider, the reason and,
  when known, the reset time ("Resets at 22:52 (in 2 h 5 min)"). **Choose
  another model** opens the model picker. Providers now report limits in a
  machine-readable form next to the usual notice; Copilot Chat still gets
  only the notice text.
- **New chat** in the bridge chat now releases a Codex or Claude turn that was
  stopped while it waited for a tool result. Before, a stopped Claude turn kept
  its session open, and a Codex turn waited up to 30 minutes. Codex keeps the
  thread, so going back to that chat later continues it.

## 1.21.8 (development patch) - 2026-11-18

- The bridge chat now sends a system prompt like Copilot Chat does: how to
  use the tools, the operating system and shell, the workspace folders, and
  the project's `AGENTS.md`, `CLAUDE.md` and `.github/copilot-instructions.md`.
  Each message also carries the date and the open file with its selection.
  That context is stored with the message, so every later request repeats it
  unchanged and the provider caches stay valid.
- When another model takes over a chat that is larger than
  `llamacpp.providerSwitchContextTokens` (250k by default), the chat first
  summarizes the older turns down to about 110k tokens. DeepSeek writes the
  summary when a DeepSeek key is set; otherwise a summary is extracted from
  the messages. The status line shows "Compacting context…" meanwhile.
- The summary appears as a card in the chat with the number of summarized
  messages and the size before and after; the full history stays visible and
  a divider marks where the model's view starts. Editing a message from before
  the summary removes it again.
- The chat title updates as soon as the first message is sent.

## 1.21.7 (development patch) - 2026-11-18

- The bridge chat collects the files the agent changes. A panel above the
  input shows how many files changed, with added and removed lines; it lists
  each file with a diff against its earlier content, and **Keep** or **Undo**
  works for all files or one file. Changes add up across turns until you keep
  or undo them, and they survive a window reload.
- **Undo** restores the exact earlier bytes, deletes files the agent created
  and brings back files it deleted. A file you edited by hand after the agent
  is left as is, and the panel says so.
- Editing an earlier message offers to undo the file changes made since that
  message (checked by default). Changes you already kept stay.
- The chat records changes with a separate git repository in the extension's
  storage, never the project's own `.git`. It reuses the project's git objects,
  honours `.gitignore`, skips `node_modules` and similar folders, and keeps
  line endings exactly. A snapshot is taken only before the first tool in a
  turn that may write, so turns that only read files cost nothing. Without
  git the panel explains that change tracking is off.

## 1.21.6 (development patch) - 2026-11-18

- The bridge chat no longer asks before every command. VS Code shows its own
  confirmation dialog whenever a tool is called outside Copilot Chat, so the
  chat now runs its own tools and the bridge's tools directly. Every call runs
  at once, except commands that match the new
  `llamacpp.chat.dangerousCommands` list: those wait for **Allow** or **Deny**
  in the chat, and **Stop** counts as Deny. The default list covers force
  pushes, `git reset --hard`, discarding changes, branch and tag deletion,
  recursive deletes, disk formatting, shutdown, piping a download into a
  shell, publishing and similar commands. Files created or edited outside the
  open workspace folders also ask first.
- The chat has its own tools: `read_file`, `list_dir`, `file_search`,
  `grep_search` (the ripgrep that ships with VS Code), `create_file`,
  `replace_string_in_file`, `get_errors`, and `run_in_terminal`,
  `read_terminal`, `send_to_terminal` and `kill_terminal` in visible **Chat**
  terminals.
- A **Tools** picker in the chat input turns tools on and off by group, with
  search. The chat's tools and the bridge's tools start on. Tools from other
  extensions, MCP servers and Copilot start off because VS Code may ask
  before each of them runs.
- An earlier message can be edited: **Edit** on a sent message replaces it,
  drops the replies after it and sends the new text. Changed files are not
  rolled back yet.
- The model picker has a search field: words match the provider, the model
  name and the id, and the arrow keys and Enter pick a model.
- The input box no longer shows a scroll bar for a single line.

## 1.21.5 (development patch) - 2026-11-18

- First preview of the bridge's own chat, which works without GitHub Copilot
  Chat. A **Chat** view sits at the top of the AI Agent Bridge sidebar and can be
  moved like any view; **AI Agent Bridge: Open Chat in Editor** opens the same
  chat in an editor tab. It talks to the bridge's models directly: Codex,
  Claude, Coco, Cursor, DeepSeek and local models appear in a model picker
  grouped by provider, so identical model names from two providers stay apart.
- The agent loop runs tool calls until the model finishes and sends the whole
  history with a stable conversation id on every request, so native Codex,
  Claude and Coco sessions continue as they do in Copilot Chat. **Stop** ends
  the turn; a tool that was asked for but never ran is reported to the model as
  not executed. This preview offers the bridge's own `llamacpp_*` tools only;
  the full VS Code tool set, the tool picker and confirmation of dangerous
  commands come next.
- Chats are saved per workspace as append-only files and reopen after a window
  reload. A large tool result shows its first 4,000 characters; the rest loads
  on request.
- The message list renders only the visible messages. In a 5,000-message test
  chat about 20 messages are in the page, a streamed text update takes about
  1 ms, and typing stays responsive while the answer streams.

## 1.21.4 (development patch) - 2026-11-15

- Fewer Snowflake sign-ins. With Snowflake 1.44.0 every Cortex CLI process
  opened a browser OAuth flow (Edge completes it on its own, so a tab flashes):
  38 flows in three days, each about ten seconds after a CLI start. The cause
  is in the CLI: every start moves its token cache into Windows Credential
  Manager and deletes the file, a later token exceeds the 2,560-character
  limit, the CLI falls back to the file and no longer reads the moved tokens.
  The bridge cannot change that, but it no longer starts extra processes: the
  background status check now runs at most every six hours while connected
  (five minutes after a failure), a ready native session counts as a check, and
  context-limit changes no longer reset it. Manual **Connection Status** and
  **Refresh Models** still check at once.
- A built-in `read` of a file the bridge did not save is refused with the
  CLI's one-time `reject_once` option instead of stopping the turn. Coco is
  told the read was denied and continues; before, every such read stopped the
  turn and the next request replayed the whole history (about 256k tokens) in
  a new session. The policy points Coco to `view_image` for other images.
- A Coco CLI that exited (for example after a sign-in timeout) is no longer
  kept as a live session: the next turn starts a new process and reloads the
  saved native session instead of failing with "Coco session closed" until a
  window reload.

## 1.21.3 (development patch) - 2026-11-14

- Coco now sees a tool image in the same turn, like the other providers. The
  bridge saves PNG, JPEG, GIF or WebP images from a tool result (up to 4 MB) in
  its Coco archive and names the file in the result. Coco opens it with the
  Cortex built-in `read`, the only CLI path that puts an image inside a tool
  result. The bridge permits that read only for files it saved during the
  current turn and answers with the one-time `allow_once` option; every other
  internal action stays blocked. The follow-up image prompt from 1.21.2 remains
  the fallback and skips images Coco already read.
- Verified live against Cortex CLI 1.42.3: client tool, built-in read,
  permission and the description of the image in one native turn.

## 1.21.2 (development patch) - 2026-11-14

- Coco still missed tool images in 1.21.1: they are attached only after its
  native turn ends, but Coco kept calling tools in the same turn and concluded
  that it could not see them. The tool result and the policy now tell Coco to
  end its turn at once so the image follows in the next message. Up to eight
  rounds per turn; when several image tools ran first, the newest four images
  (8 MB together) are sent.

## 1.21.1 (development patch) - 2026-11-14

- Coco now receives images a tool returns (`view_image`, subagent screenshots,
  any `image/*` tool result). The Cortex CLI turns every client-tool result into
  text, so the image is attached to a follow-up prompt in the same native
  session right after the turn: up to four images, 4 MB each and 8 MB together,
  deduplicated, at most twice per turn. The tool result names the image and the
  policy tells Coco to wait for it; a binary part that is neither text nor an
  image keeps a text note.
- Validated with the full extension suite (966 passing) and new Coco vision
  tests for the collection bounds and the follow-up prompt.

## 1.21.0 (stable release) - 2026-11-10

Consolidates the 1.20.13–1.20.23 development patches below.

- Several ChatGPT subscriptions side by side, each with its own Codex home,
  app-server, login and usage windows, managed from Quick Access.
- Codex: a prompt sent while a native tool runs reaches the model, stale tool
  results deep in the history no longer reject new prompts, a reset ChatGPT
  window no longer keeps answering "limit reached", and failed or cancelled
  turns record their tokens.
- The Subscriptions tab keeps only windows tracked from start to end and
  assigns every request to the provider window it ran in.
- Patch safety: atomic writes, shared locks and in-place restore for the
  Copilot, workbench terminal and agent-host patches; CLI paths are
  machine-scoped.
- Subagents on bridge models work again, links in answers open, Coco reuses
  its terminal, and long chats keep only the newest 100 images.

## 1.20.23 (dev patch) - 2026-11-10

Subscription diagnostics: only complete windows are recorded.

- Every request now counts in the provider window it ran in, a window spanning
  `resetsAt` minus 5 hours or 7 days. Requests after a reset no longer land in
  the old window, and the empty "after 100%" stretch is no longer saved as a
  window of its own.
- Codex starts a new weekly window right after the old one hits 100%. That
  window was noticed only at 10% and lost its start to the old one, which split
  one week into two rows. It now takes back every request since its real start.
  An idle 0% sample no longer hides the reset until the 10% band.
- Finished windows and the capacity median keep only windows tracked from
  start to end. A window first seen already in use, or one that kept rising
  without requests from this extension (more than 5 points), stays visible
  while it runs, marked partial, and is never saved. A window whose reset time
  passed moves to history without waiting for a new event.
- Codex now records the tokens of a turn that failed or was cancelled. The turn
  that runs into the usage limit always fails, so before this every exhausted
  window was missing its last request (in the ledger, 10 to 90% of the window).

## 1.20.22 (dev patch) - 2026-11-10

Codex: prompts sent while the agent is working.

- A prompt sent while a native VS Code tool was running reached Codex without
  the prompt: VS Code delivers it together with the finished tool's result,
  and Codex resumed the old turn with only that result. Such a request now
  interrupts the waiting turn and continues the same thread with the tool
  result and the prompt as one new user turn.
- An interrupted turn's tool result left anywhere in the chat history could
  reject every later request with "This native VS Code tool result belongs to
  an interrupted Codex turn", including a newly typed prompt, until the window
  was reloaded. Only the current round's results are checked now, and never
  when the request ends with a user prompt or comes from a newer Copilot turn.
- After an interrupt the reused thread receives the pending tool results along
  with the new prompt instead of the prompt alone.
- "no active turn to interrupt" (the turn had already finished) is no longer
  logged as an error, and a steered turn in that state reuses its thread
  instead of starting a new one. A reused interrupted thread waits for the
  previous turn's interrupt before starting.
- Codex error notifications log their real message. Errors Codex retries
  itself (`willRetry`, e.g. reconnecting) are logged as warnings
  (`codex.chat.notification_retry`) instead of errors.

## 1.20.21 (dev patch) - 2026-11-10

Quick Access cleanup.

- Claude subscription limits use the Codex layout: each window is its own row
  with the used percentage, and the reset moment sits on an expanded
  "Next Reset" row, so the time is no longer cut off at the sidebar edge. The
  "Subscription Limits" group that repeated the same numbers is gone.
- Rows that repeated another row or ran the same action are merged: the Codex
  status opens from ChatGPT Accounts, Claude's source and sign-in sit under
  Account, Local LLM and DeepSeek show their endpoint on one row, and the
  Diagnostics "Throughput" and "Subscription Tokens" rows (the group row and
  the Live Report already show them) are removed. Codex "Sign In" (every
  account has its own) and the static "VS Code Tools Only" row are gone; the
  group is now "Settings".
- Diagnostics groups the log actions under Logs and the two status-bar
  toggles under Status Bar. The thinking-picker patch row shows On/Off.

## 1.20.20 (dev patch) - 2026-11-09

Patch safety hardening from the 1.20.19 audit.

- The Copilot chat-history patch and the workbench terminal patch edit the
  same `workbench.desktop.main.js` but kept separate whole-file backups, so
  restoring one could drop the other. The terminal patch now reverts only its
  own method in place, and a Copilot restore keeps the terminal patch exactly
  as it currently is. A workbench backup that differs from the installed file
  only by the terminal patch no longer blocks the Copilot patch with "Backup
  already exists".
- Every patch writes its bundle, backup and metadata through a temporary file
  and a rename, so an interrupted write can no longer leave a truncated bundle.
  A read-only file stays protected, and ownership and mode are kept.
- The workbench terminal and agent-host patches take the same cross-window
  lock as the Copilot patch (which now also locks the shared workbench), and
  the terminal patch is syntax-checked before it is written. The syntax check
  sets `ELECTRON_RUN_AS_NODE` itself instead of relying on the inherited
  environment.
- Restore no longer copies an outdated backup over a newer file: a file that
  carries no patch is left alone and its leftover backup removed, and a patched
  bundle whose backup belongs to another Copilot Chat version or VS Code build
  is refused instead of downgraded. Apply replaces such leftovers (for example
  after a Linux package update) instead of refusing.
- `codexCliPath`, `claudeCliPath`, `cocoCliPath` and `codexAccounts` are
  machine-scoped, so a workspace's settings cannot choose the executable or
  Codex home the extension starts.

## 1.20.19 (dev patch) - 2026-11-09

Code audit fixes.

- Subagents on bridge models work again. VS Code resolves `runSubagent.model`
  by its qualified name `Name (vendor)` and accepts a bare name only for
  Copilot's own models, so every advertised label was rejected with "model not
  found". The schema enum and the routing guidance now list
  `Name (llamacpp)`; the local-model advice appears only when a local model
  exists.
- `package.json` no longer carries garbled settings text: the arrows and dash
  added after 1.20.12 were re-read as ANSI on every PowerShell version bump and
  had grown to 10,000 characters. `npm run check:metadata` now fails on such
  text, and versions are bumped with `npm version`.
- Coco terminal: the bridge only runs `cd` into an existing directory without
  control or shell-expansion characters (a newline in a model-supplied `cwd`
  was a second command in cmd), a trailing `\` no longer leaves bash waiting
  for a closing quote, the confirmation shows the directory, and a parallel run
  cannot grab a replacement terminal while it starts.
- Copilot patch: when every found bundle failed, the result was reported as
  "patches are already active"; it is now reported as a failure. The Copilot
  bundle is written before the workbench, as documented, and "Show Log" in the
  "Copilot Chat was not found" warning opens the log.
- Turning the thinking-picker or workbench terminal patch off now persists:
  the toggle updates its setting, so the next window start no longer re-applies
  the patch.

## 1.20.18 (dev patch) - 2026-11-06

- A chat no longer opens one Coco terminal per command. Models pass `cwd` on
  most calls, and a terminal sitting in another directory used to force a new
  tab every time. The run tool now reuses the last idle terminal and enters the
  requested directory in it (`cd "…"`); a new terminal is created only when none
  is idle, the shell cannot change directory, or `newTerminal` is true.
- Terminal selection is logged (`coco.terminal.run` with the reuse reason,
  `coco.terminal.change_directory`) so a future report can be traced.
- The reported directory now also falls back to the last shell execution and the
  terminal's creation directory, so a terminal is recognised before shell
  integration publishes its own `cwd`.

## 1.20.17 (dev patch) - 2026-11-05

- The shared chat transcript keeps only the newest 100 images
  (`llamacpp.journalImageRetention`, 0–2000, 0 keeps none). In a long chat every
  screenshot was stored and loaded again on the first request after a reload:
  one chat already carried hundreds of them, which is why opening it took
  seconds. Older images are replaced with `[earlier image removed to keep the
  chat fast]` before any file is read, so a reload touches only the retained
  ones.
- The cap applies while loading, after every merged request and before each
  save, so the file on disk stops referencing dropped images; the existing
  unreferenced-asset cleanup then deletes their files.
- Quick Access → Diagnostics → **Chat Images Kept** shows the current limit and
  opens the setting.

## 1.20.16 (dev patch) - 2026-11-05

- Links in answers open again. Chat prompts carry attachments as
  `http://_vscodecontentref_/N` placeholders; a model that quotes one back (Codex
  does this for files it worked on) produced a link the chat view could not
  resolve, and clicking it opened nothing — for example
  `file:///d%3A/%5BR2_PERFORMANCE_RECOVERY.md%5D%28http%3A/_vscodecontentref_/1%29`.
  Every text part now passes through a link normalizer before the chat sees it:
  a placeholder or Windows/relative destination that names an existing file
  becomes a `file:` URI of that file, so the link opens; when no such file
  exists the link becomes a plain code span instead of a dead link. Remote
  links, anchors and data URIs are untouched. Text is streamed unchanged apart
  from a short hold while a link is incomplete, so partial links are fixed even
  when a delta splits them.
- The same normalization is applied to escaped errors (limit and balance
  notices) and to every provider, not only Codex.

## 1.20.15 (dev patch) - 2026-11-04

- A reset ChatGPT window no longer keeps answering with "limit reached". The
  fail-fast gate was armed from an old error message and held the chat until the
  next occurrence of the clock time in that text (up to a day later), even though
  the panel reported 0% used. The gate now follows Codex's own windows only: a
  window at 100% blocks the chat, every window below it clears the block.
  `rateLimitReachedType` is ignored while window numbers exist, because it keeps
  its old value after a reset.
- A limit read from provider text is provisional: it is clamped to the length of
  its window (five hours plus slack for a 5-hour window, a week for a weekly one)
  and verified against the provider's own report before the next request is
  refused. Codex reads `account/rateLimits/read`, Claude reuses its latest usage
  snapshot; a below-100% answer lets the message through.
- "Limit reached" is no longer sticky: it was computed as
  `window >= 100 || rateLimitReachedType || previouslyReached`, so the previous
  value kept it true forever and Codex models stayed marked unavailable after a
  reset. The current window numbers now decide it.

## 1.20.14 (dev patch) - 2026-11-03

- A second ChatGPT subscription can be added without touching settings: Quick
  Access → Codex → **ChatGPT Accounts** → **Add Account…** asks for an id and a
  name, stores it, makes it the active account and offers to reload. After the
  reload the sign-in page opens by itself; a failed deferred sign-in now shows
  an error that points back to the same group.
- The accounts group is always visible, including with a single account, so
  per-account **Sign In** and **Sign Out** are discoverable from the start.
- **Remove Account** deletes a named account from the list (its folder and
  login stay on disk) and moves the picker back to the built-in account when
  the removed one was active.

## 1.20.13 (dev patch) - 2026-11-03

- Two ChatGPT subscriptions can run side by side. `llamacpp.codexAccounts`
  lists extra accounts; each gets its own `CODEX_HOME` (default
  `~/.codex-<id>`), its own Codex app-server process and its own file-based
  credential store, so the logins, native threads, last used model and usage
  windows never mix. The built-in account keeps `~/.codex` and the historical
  `codex::<model>` ids, so existing chats are unaffected.
- Quick Access → Codex → ChatGPT Accounts shows every account with its own
  **Sign In** and **Sign Out** and switches the active account in one click.
  Switching re-announces the model catalogs, so the picker immediately shows
  the new account's models; a chat already using the other account's model
  keeps working. `llamacpp.codexShowAllAccounts` lists every account at once
  with the account name in the model label.
- Each account reports its own subscription windows to the Subscriptions tab
  (`codex` plus `codex:<id>`), so two plans are compared instead of merged.
- New commands: **Switch Codex Account**, **Sign In to a Codex Account**,
  **Sign Out of a Codex Account**.
- Codex sign-in no longer needs the official VS Code extension: the bridge
  already drives the app-server `account/login/start` ChatGPT flow, and any
  Codex CLI can be used through `llamacpp.codexCliPath`.

## 1.20.12 (dev patch) - 2026-11-02

- An empty provider balance no longer produces a failed request and repeated
  attempts. HTTP 402 Payment Required and balance/quota wording from a provider
  body become one English line, for example `DeepSeek balance is empty
  (Insufficient Balance). Top up the account, then send the message again. No
  retry was made.` The notice completes the request, so the host does not retry
  it, and context-length or rate-limit errors are not mistaken for a balance.
- The Subscriptions tab no longer fills with empty windows. An idle provider
  reports 0% with a reset time that moves every minute, and every change used
  to start a new one-minute window. Such samples are ignored now, and a window
  without tracked tokens is never saved: the finished list and the capacity
  estimate only use windows that were counted from their own usage.
- Reset timestamps that differ by sub-seconds between polls no longer split a
  window. A provider timestamp that appears and disappears is ignored as a
  boundary; only a real reset or a deep utilization drop ends a tracked window.
- Windows are tracked only for the periods a provider actually reports, so
  Codex or Claude without a weekly window no longer shows a phantom weekly row,
  and a window created right after a 100% hit starts without a copied peak.

## 1.20.11 (dev patch) - 2026-11-02

- Diagnostics panels (Live Report, Providers Manager, Shared Memory) open as a
  tab in the current editor group instead of forcing a new group to the side.
  Revealing an already open panel also reuses the active group.

## 1.20.10 (dev patch) - 2026-11-01

- The Live Report has a Subscriptions tab: Codex and Claude token use per
  5-hour and weekly limit window, with input, cache misses, cache reads, cache
  writes, output, request counts, cache hit percentage and per-model totals.
- A window that reaches 100% is saved as a finished window and the next one
  starts from zero, so a period never mixes usage from two windows. Providers
  that omit reset timestamps are detected by a deep utilization drop.
- The ledger lives in extension global storage (`subscription-usage`), so every
  VS Code window of the profile adds to one history and the totals answer how
  many tokens a plan window really provides. Totals are marked partial when
  tracking started after the window had already begun.
- A Claude or Codex usage limit no longer prints the provider's long error and
  no longer starts repeated attempts. The provider answers with one English
  line, for example `Claude 5-hour limit reached. It resets at 16:00 EET (in
  2 h 15 min). Wait for the reset, then send the message again. No retry was
  made.` The reset is parsed from the provider text (clock with its zone, ISO
  time, or "try again at ..."), the window is remembered per provider, and
  every request until the reset returns the same line without calling the
  provider, opening a thread or running a fallback. Context and payload limits
  are not treated as subscription limits.

## 1.20.9 (dev patch) - 2026-11-01

- Codex can use tools that appear after its thread started. Codex fixes a
  thread's dynamic tools at `thread/start`, and a reused thread only kept the
  tools it already had, so tools behind Copilot's `activate_*` groups (for
  example Meshy MCP tools) were enabled in VS Code but never callable. When
  the model activates new tools mid-turn, the turn continues in a new thread
  that receives the shared context; with Copilot grouping disabled
  (`github.copilot.chat.virtualTools.threshold` 0) a new turn also starts a
  new thread after tools were enabled. Schema-only changes and collapsed groups
  keep the warm thread.
- `scripts/repair-chat-sessions.cjs` replaces removed screenshots, `$base64`
  buffers and oversized data URLs with a valid 1×1 PNG instead of a text
  marker. VS Code decodes these fields while loading, and one invalid value
  made the whole repaired session open empty.

## 1.20.8 (dev patch) - 2026-11-01

- The shared chat transcript is append-only JSON Lines. Each step writes only
  the new messages instead of serializing the whole chat twice per tool round:
  on a real 29 000-message (51 MB) chat a round costs about 40 ms instead of
  more than half a second. An edited request, a torn final line or accumulated
  superseded system prompts trigger one full rewrite. Version 1 transcripts
  load unchanged and are converted on the next step.
- The transcript limit rises from 64 MiB to 512 MiB, so long chats no longer
  stop with "The saved Chat transcript exceeds 64 MiB".
- Images in `chat-history/assets` that no saved chat references are deleted
  two minutes after activation (only files older than a day).
- `scripts/repair-chat-sessions.cjs` also removes screenshots that tool
  outputs keep as base64 in `resultDetails.output[].value`; the earlier repair
  only removed payloads stored in `data`.

## 1.20.7 (dev patch) - 2026-10-31

- A model that takes over a chat from another model receives only the newest
  turns that fit `llamacpp.providerSwitchContextTokens` (default 250 000
  estimated tokens, tool schemas included). Codex, Claude, Coco and Cursor
  apply the same budget, so a switch no longer replays the whole chat: Claude
  was sending up to `claudeResumeFallbackMaxInputTokens` (500 000 in the user
  settings), which cost about half a million uncached tokens in one request.
  Older turns stay in the shared transcript, whose path is passed to the
  model. Claude keeps its short digest of earlier user requests, so a switch
  does not lose the subject of the chat. The budget has a slider in Provider
  Context (Providers → Context on Model Switch) and is shown in Quick Access.

## 1.20.6 (dev patch) - 2026-10-30

- Codex accepts VS Code MCP tools whose names start with its reserved `mcp__`
  prefix. They use safe names inside `vscode_mcp` and route back to the original
  VS Code tool. Eager and deferred tools keep their schemas and availability.
- HTTP providers can continue chats containing interrupted tool rounds.
  Calls without matching results and detached results become quoted historical
  context before request validation. Complete rounds, steering text and image
  results are preserved; the shared transcript is unchanged.

## 1.20.5 (dev patch) - 2026-10-29

- After a switch to another model, the first turn of the new model is always
  cold. The shared chat journal records which model last produced output.
  When a request goes to a different model, Claude, Codex, Coco and Cursor
  start a new native session from the shared transcript. They no longer
  resume their own earlier session or send it only the newest messages:
  that session lacks the other model's turns and compactions. A request that
  fails before any output, such as an exhausted limit, does not count as
  taking the chat over.
- Claude answers the current request after taking over a chat from another
  provider. When its own session cannot be resumed, Claude starts from the
  chat transcript. That start kept only the first message and the last 24
  messages, which after a long Codex turn were only Codex tool rounds, and it
  attached every image ever pasted into the chat after the transcript. Claude
  took a days-old screenshot for a new attachment and went back to that task
  on "continue". Now:
  - the recent part of the transcript fills the replay budget instead of
    24 messages;
  - a list of the omitted user requests is kept;
  - only images from the current request are attached;
  - the start stays within `llamacpp.claudeResumeFallbackMaxInputTokens`
    instead of falling back to the latest message alone.

## 1.20.4 (dev patch) - 2026-10-28

- Coco no longer signs commits, pull requests or files with "Generated with
  [Snowflake CoCo](…)" and "Co-authored-by: Snowflake CoCo
  <noreply@snowflake.com>", which Cortex's own system prompt asks for. The
  bridge policy forbids it, and the bridge removes that attribution from every
  Coco tool call before Chat runs it: whole `-m`/`--message`/`--trailer`
  arguments and lines holding only the attribution. Text an edit must match is
  kept, and text that only mentions Snowflake CoCo is left alone.

## 1.20.3 (patch release) - 2026-10-28

- Follow Codex applies right away. Before, with the toggle on, the shared
  context stayed at the slider value until a Codex request in this workspace,
  although Codex had already catalogued 475K for gpt-6.1-sol, and the panel
  showed the 258.4K fallback setting as the Codex window. Before the first
  request the shared context now follows Codex's default model, or the largest
  known window while the model list is not loaded yet.
- The last used Codex model is stored globally, like the shared context; the
  1.20.2 workspace value is migrated.
- Provider Context names why a model is followed (last used, Codex default,
  largest known) and updates the followed window while open without dropping
  unsaved edits.

## 1.20.2 (patch release) - 2026-10-28

- Patch releases are published on GitHub like stable ones, and the updater
  offers them. Old releases are deleted automatically after each publication:
  x.y.0 of the three newest lines (1.20, 1.19, 1.18) and the two newest patches
  of the newest line stay. `npm run prune:local` applies the same rule to local
  VSIX files and tags; the release script runs it after the push.
- Update checks: the automatic check runs at most every 5 hours (was 6) and
  retries after 30 minutes when GitHub could not be reached. Before, a check
  right after the computer woke up failed with `fetch failed` and Last Check
  showed "failed" for 6 hours. The error now names the network cause. A manual
  check asks GitHub at most once every 5 minutes; within that time it shows the
  last result and when the next check is possible.

- The Codex window is known before the first turn. Codex models differ:
  475K for gpt-6.1-sol and gpt-6.1-terra, 258.4K for the others. The window
  now comes from Codex's own model catalog (`models_cache.json`,
  context_window × effective percent), and a value Codex reports during a turn
  still replaces it. Before, a reload advertised the 258.4K fallback until the
  first turn, so Copilot compacted to the smaller budget.
- New `llamacpp.sharedContextFollowCodex`, off by default, toggled in Provider
  Context. With it on, the shared context is the window of the last used Codex
  model: it grows for every provider when that window is larger and shrinks
  after switching back to a smaller model. The slider value is kept for when
  the toggle is off. Changing the window rewrites the Claude and Coco prompt
  caches once, the same as moving the slider.
- Provider Context lists each Codex model with its window and source and shows
  the largest Codex window.

## 1.20.1 (development patch) - 2026-10-27

- Copilot patch v28: screenshots no longer make a chat fail with
  `Invalid string length`. Copilot saved each `view_image` result in the turn
  metadata with its full bytes, and VS Code sends all of it with every request;
  one chat reached 632 MB, about 500 MB of it screenshots. The saved copy now
  replaces image and binary tool data above 64 KB with a short text note. The
  running request still sees the image, and later turns already showed old
  images to the model only as text.
- A Copilot bundle carrying any older patch version is upgraded from its
  backup. The hand-kept list of old markers lacked v27, so v28 failed with
  "Backup already exists" and the bundle kept v27.

## 1.20.0 (stable release) - 2026-10-26

Consolidates the 1.19.1–1.19.4 development patches below.

- Updates from GitHub releases (`llamacpp.autoUpdate`: notify, install, off),
  verified by SHA-256, with an **AI Agent Bridge** group in Quick Access: the
  current version, the last check, Check for Updates, Install Update and the
  automatic update mode.
- Claude sends the newest chat turn again instead of the first request.
- A long autonomous request (Codex, Coco, Cursor) compacts its older tool
  rounds instead of failing the shared context budget.
- Screenshots are stored once in `assets/` instead of inline in the shared
  transcript, which no longer hits its 64 MiB limit.

## 1.19.4 (local development patch) - 2026-10-26

- Updates from GitHub releases. The extension checks the latest stable release
  of MrLordCat/ai-agent-bridge one minute after startup and then every 6 hours.
  The new `llamacpp.autoUpdate` setting is `notify` (default), `install` or
  `off`. Only a version newer than the installed one is offered. The VSIX for
  the current platform is downloaded from this repository only and installed
  only when its size and SHA-256 digest match the release. A reload is offered
  afterwards. Several windows show one notification per version, and only one
  window installs at a time.
- Quick Access has an **AI Agent Bridge** group: Current Version, Last Check
  (time and latest release, or the failure reason), Check for Updates, Install
  Update or Reload Window, and Automatic Updates. The same actions are
  available as commands.

## 1.19.3 (local development patch) - 2026-10-26

- Shared transcript: screenshots no longer fill the 64 MiB transcript limit.
  Images inside tool results were stored inline as base64 in addition to their
  `assets/` file. Eleven screenshots (one 9.9 MB PNG three times) took 46 MB of
  a 62 MB transcript, and the next round failed with "Cannot save the incoming
  Chat transcript". The transcript now references each image by its asset
  name and restores the bytes on reload. Older transcripts are read as before
  and rewritten in the new form on their next save. The save error now names
  its cause.

## 1.19.2 (local development patch) - 2026-10-26

- Codex, Coco, Cursor: a long autonomous request no longer fails with "The
  current request and required instructions exceed the shared context budget".
  The shared handoff treated every tool round since the last user message as
  the untouchable current request, so a turn with 160 tool rounds could never
  start a new thread again, for example on a retry after an error. Only the
  request message is pinned now. The newest steps that fit are kept verbatim
  and the older steps of the same request become an "Earlier steps of the
  current request" summary.

## 1.19.1 (local development patch) - 2026-10-25

- Claude: a new chat message is sent to Claude again. Copilot now adds about
  16K characters of `<customizationsUpdate>` context (skills, instructions,
  agents) to every follow-up request. The provider skipped user messages above
  6,000 characters, a rule meant for Agents Window transcripts that carry no
  question, so every warm turn re-sent the first, shorter request. Claude then
  answered that the same message had arrived again. A message with
  `<userRequest>` is a real chat turn and is now always used.

## 1.19.0 (stable release) - 2026-10-25

Consolidates the development work since 1.18.0: the 1.18.1/1.18.2 patch
releases and the 1.18.1–1.18.25 development patches below.

- Long chats stay fast. Copilot patch v27 renders only a short history tail for
  a chat backed by the shared transcript, and every provider still receives the
  full history from it. The transcript merge no longer loses saved turns when
  Copilot drops middle turns. Subagent alternation no longer makes VS Code
  re-read every provider catalog (patch v26). Catalog loads, Quick Access and
  Copilot patch status no longer block the extension host.
- One working context for Codex, Claude, Coco and Cursor
  (`sharedContextLength`), passed to each backend's own auto-compaction, with
  one handoff planner and a shared workspace journal restored before routing.
- Codex: no full-context `wait` polls around VS Code tools, rollout metrics read
  only the finished turn, and usage-limit failures are final.
- Claude: Opus 5.5 through the official Claude Code runtime. Cache keep-alive
  works while idle, stops after an idle limit and stays inside the 1-hour TTL.
- Cursor: indexed native store (a long chat started in seconds instead of
  minutes), persistent bindings, and continuation after failed or interrupted
  runs without re-executing completed tools.
- Coco: native ACP sessions for long-running callbacks, bounded tool names,
  `tool_search` allowed, recovery from reasoning-only turns, and large handoffs
  prepared locally with complete archives.
- Copilot patches: stored tool results bounded (v23), MCP tuple schemas accepted
  (v24), subagents isolated from the parent's native session (v25), and
  backups protected against contamination.

## 1.18.25 (local development patch) - 2026-10-25

- Claude cache keep-alive now actually runs while you are idle. It needs a
  usage snapshot no older than 10 minutes, but the background CLI usage probe
  stops 10 minutes after the last Claude request, so every attempt (first due
  after about 36 idle minutes) was paused as "usage stale". A due keep-alive
  now refreshes usage from the live Claude session itself, a control request
  that costs no model tokens and starts no extra process. Before it is due, a
  stale snapshot no longer matters.
- Claude cache keep-alive stops after `llamacpp.claudeCacheKeepAliveMaxIdleMs`
  (2 hours by default) without a real Claude turn and lets the cache expire.
  Keep-alive turns no longer count as use, so an enabled keep-alive cannot keep
  re-reading the prefix of a chat you have left. Quick Access shows the interval
  and the idle limit.
- `llamacpp.claudeCacheKeepAliveMs` is clamped to 55 minutes. At 60 minutes,
  every keep-alive after the first arrived after the 1-hour cache had expired,
  because the timer only checks every 5 minutes.

## 1.18.24 (local development patch) - 2026-10-24

- Long chats: Copilot no longer re-renders the whole history on every tool
  round. Copilot patch v27 renders only the newest 12 rounds and 8 previous
  turns for a chat that already has a saved transcript
  (`llamacpp.journalRenderRounds`, `llamacpp.journalRenderTurns`). The
  extension restores the full history from the transcript, so every provider
  still receives all turns. In a chat with 16 user turns and about 2 400 tool
  rounds, the gap between tool rounds fell from 35 s or more of host CPU to
  0.7–1.6 s. Subagents and chats without a transcript keep
  `agentHistoryRounds`/`agentHistoryTurns`.
- Transcript merge: a render that drops middle turns no longer cuts the saved
  history. Incoming requests are matched as an ordered subsequence of the stored
  ones, so only a request missing from that order counts as an edit. Before
  this, a turn cap combined with a new request could drop hundreds of saved
  messages.

## 1.18.23 (local development patch) - 2026-10-24

- Codex: VS Code tools no longer trigger repeated full-context `wait` polls.
  Codex calls our tools from code-mode `exec`, which used to yield after 30 s.
  The model then polled with `wait` (often every 1 s), and each poll re-sent
  the whole ~240K-token context. In real rollouts these polls were 34–46% of
  model calls and input tokens. Threads now set
  `features.code_mode.default_exec_yield_time_ms` to 10 minutes, so `exec`
  returns when the tool does. The developer instructions also ask for one long
  `wait` instead of short polls. Measured with
  `scripts/codex-code-mode-smoke.mjs` on CLI 0.162 and 0.164: one `exec`, no
  `wait`. If a CLI rejects the table, the request is retried once without it.
- Codex: per-turn rollout metrics read only the finished turn, found by
  scanning backwards from the end of the file, instead of parsing the whole
  rollout (tens of MB in long threads) before the response finishes. On a 77 MB
  rollout this took 5 ms instead of over 200 ms. The rollout path is cached per
  thread, so the `thread/read` call is not repeated on every turn.
- Codex: "usage limit" and "model at capacity" failures are final; the provider
  no longer sends a recovery turn that fails the same way.
- Codex: after an app-server restart, `thread/resume` runs only for the stored
  thread that matches the conversation, not for every compatible candidate.
- Codex: JSONL output from the app-server is split without rescanning the whole
  buffer for every chunk of a large message.
- Codex: `codex.chat.request_arrived` logs how many token counts VS Code
  requested during the gap (`tokenCountCalls`, `tokenCountComputeMs`,
  `tokenCountSpanMs`). This shows how much of the 6–60 s gap between tool
  rounds in large chats comes from token counting.

## 1.18.22 (local development patch) - 2026-10-24

- Claude: Opus 5.5 is selectable. The subscription catalog advertised only
  `claude-opus-5`, while the installed Claude Code CLI (2.1.310) accepts
  `claude-opus-5-5` and its `[1m]` variant. Both generations are now offered,
  with Opus 5.5 first.
- Claude: prefer the official Claude Code runtime over the SDK-bundled CLI.
  The bundled 2.1.240 cannot run Opus 5.5; the API requires 2.1.280 or newer.
  API errors now retain the server's explanation instead of only `unknown`.
- Claude: recovery warnings distinguish the full-history token estimate from
  the latest-message estimate and explain the actual replay guard.

## 1.18.21 (local development patch) - 2026-10-23

- Cursor: a chat whose run failed during tool work (for example "Connection
  stalled") continues again. 1.18.20 assumed VS Code drops the failed request
  from history, but VS Code keeps it with all its tool rounds. The real cause
  was the boundary: it was located by user-message hashes, and those had
  changed since the checkpoint was saved. The delta then started at the failed
  request. The completed tool result that the checkpoint lacked fell outside
  the replay window, so the request stopped with "Cursor recovery is missing a
  completed tool result".
- A failed run's checkpoint is now located by that run's own VS Code tool call
  IDs: the delta starts after its last tool result, and only the results the
  checkpoint lacks are quoted (not re-executed). The 1.18.20 rule that dropped
  the last saved user message is removed. Checkpoints saved by older builds
  are recognised from the failure record written with them.
- A request rejected before inference no longer overwrites the saved
  continuation boundary (it had shortened it from 15 to 12 user anchors).

## 1.18.20 (local development patch) - 2026-10-23

- Cursor: a chat whose last run failed (for example "Connection stalled") could
  not continue after the failure. Every later message was rejected with "Cursor
  could not match this request to its completed native history". On a failure
  the provider saves the failed run's checkpoint, and that checkpoint already
  contains the failed user message. VS Code leaves the errored request out of
  later history, so the saved boundary never matched again. Such checkpoints
  are now marked. For them, the history may continue without that one message,
  on the same native agent, with no replay and no new agent. Checkpoints saved
  by older builds are recognised from the failure record written with them.
  Edited branches are still rejected.

## 1.18.19 (local development patch) - 2026-10-23

- Cursor: a long chat no longer waits minutes before the model starts. The
  SDK's `JsonlLocalAgentStore` re-reads and re-parses a whole file for every
  record. At run start the SDK loads the agent checkpoint blob by blob, so
  3,478 blobs in a 100 MB `checkpoints.ndjson` took about 17 minutes, measured
  between `RUNNING` and the first event. Every streamed run event also rewrote
  the 45 MB `run_events.ndjson` (about 0.5 s each).
- The provider now uses its own indexed store over the same files: each file is
  indexed once, records are read by byte offset, and new checkpoints and run
  events are appended. On a copy of that store, loading the checkpoint takes
  0.3 s and an event append takes about 1 ms.
- The native session, checkpoints and context stay as they are: no data is
  pruned or migrated. Results and file contents match the SDK store for the
  same operations, and the stock SDK store still opens the directory.
- An interrupted final record is ignored, as the SDK does, and cut off before the
  next write. Changes made by another writer are detected and re-indexed.

## 1.18.18 (local development patch) - 2026-10-21

- Coco: `tool_search` no longer stops the request. With many Chat tools the
  Coco CLI defers their schemas and loads them through this built-in catalog
  lookup, which has no side effects; other built-in actions are still stopped.
- Coco: a native turn that ends after reasoning alone (in the reported case,
  5 minutes and 620 KB of reasoning with no text or tool call) no longer returns
  an empty response. Copilot treated it as a failed request and retried it three
  times with tool results of a finished turn, which failed with `The Coco tool
  session is no longer active`. The provider now asks the same native session to
  continue (at most twice) and otherwise reports the empty turn with its stop
  reason.
- Coco: `no longer active` now says whether the turn was cancelled or had
  already finished, and the case is recorded as `coco.request.stale_results`.
- CI: accept both restore and save failures when testing a blocked common
  transcript directory; Linux detects the invalid path before Windows does.

## 1.18.17 (local development patch) - 2026-10-20

Runtime efficiency while agents work (plan:
[docs/AGENT_RUNTIME_PERFORMANCE_PLAN.md](docs/AGENT_RUNTIME_PERFORMANCE_PLAN.md)).

- Copilot patch v26: a subagent request no longer replaces Copilot's main-agent
  model. Each parent/subagent alternation used to re-announce the model list,
  and VS Code re-read every provider catalog (431 reads in 20 minutes of one
  Cursor subagent, 77 s of extension-host work).
- One catalog load now answers a burst of model selections (shared for 3 s,
  dropped by any provider change). An unreachable Local/API server is asked
  again after 15 s, doubling up to 60 s, instead of on every poll; an empty
  `/slots` answer is reused for 30 s. Refresh Models retries at once.
- Quick Access no longer reads and hashes the 19 MB Copilot and workbench
  bundles on every rebuild (about 110 ms of blocked extension host each time).
  It rebuilds at most every 200 ms; subscription status ticks refresh the
  provider directory only when state or summary changes; the live session
  report is written at most every 2 s and its panel updated at most twice a
  second.
- Copilot patch backups: a backup is written only from a bundle without
  patch markers, a lock file serialises patching across windows, and a
  contaminated backup is reported and refused with an explicit message.
  A clean installed bundle replaces a contaminated backup automatically.
  Quick Access shows `controls outdated` for an older installed patch. On this
  machine two windows had saved an already patched bundle as the original, so
  v23-v25 never applied.
- Codex: the keep-alive timer no longer repeats the account and rate-limit
  requests of the extension's usage timer when keep-alive is off, and it is
  cleared on dispose.
- The shared conversation journal hashes each message once instead of on every
  step. Coco shared-context archives not rewritten for 14 days are deleted.
- Removed unused code: `compactCodexMessages`, `hasPersistedClaudeSession`,
  `SUBSCRIPTION_PROVIDER_SOURCES` and seven unused members.

## 1.18.16 (local development patch) - 2026-10-20

- Fix `The Coco tool session is no longer active` after a subagent: Copilot
  sends a subagent request with the parent chat's conversation id, so a
  subagent on another provider was treated as a model switch and closed the
  Coco prompt waiting for `runSubagent`. Copilot patch v25 forwards the
  subagent invocation id, and a subagent run no longer carries the parent's
  conversation id. It cannot cancel the parent's pending tool turn (Coco,
  Codex, Cursor), take over its native session or overwrite its shared journal.
  Reload the window after the patch is applied.

## 1.18.15 (local development patch) - 2026-10-20

- One working context for Codex, Claude, Coco and Cursor:
  `sharedContextLength` now drives every native agent, so a switch after a rate
  limit keeps the same history budget. Each provider advertises
  min(limit, real model window), so Chat's context indicator matches.
  `claudeContextLength` is deprecated and no longer read.
- Pass the limit to each backend's own auto-compaction: Codex
  `model_auto_compact_token_limit` (only below 90% of the real window), Claude
  Code `CLAUDE_CODE_AUTO_COMPACT_WINDOW` (258.4K-967K), and the Coco CLI
  threshold fraction (0.20-0.99; the server caps it at 75% for 1M windows).
  Idle Coco processes started with another threshold are released and reload
  their native session; active turns are not interrupted.
- Provider Context panel: one shared slider replaces the Claude and Codex
  sliders and shows each provider's effective value. Quick Access adds
  Providers > Shared Context and working-context rows for Coco and Cursor;
  the Providers Manager shows the shared value for Cursor instead of its slider.
- Cursor status: a model catalog loaded with the API key in the last 15 minutes
  keeps the profile online when the availability probe fails, and the probe now
  uses the catalog's 15 s timeout instead of 5 s. The Offline reason is shown in
  the profile tooltip.
- Refresh every provider's model list when the limit changes, without aborting
  active Cursor requests.
- The `Set Shared Working Context` command (formerly `Set Claude Working
  Context`, same command ID) now writes `sharedContextLength` instead of the
  ignored `claudeContextLength`. `codexCompactKeepLastTurns` is marked
  deprecated because the shared planner no longer reads it.

## 1.18.14 (local development patch) - 2026-10-20

- Restore the same workspace conversation journal before routing to every
  provider. Recover retained windows using shared user anchors and replace
  current system snapshots instead of accumulating duplicate policy messages.
- Use one token-budget handoff planner for native Codex, Coco and Cursor:
  deterministic Codex-style summary, typed recent messages, complete current
  request and exact image files. Remove the separate 64k Cursor / 1M Coco
  character cutoffs. `sharedContextLength` sets the common working target;
  zero inherits `codexWorkingContextTarget`, subject to smaller native windows.
- Migrate Coco user fingerprints without discarding compatible native sessions.
  Never expire pending Chat tools because of elapsed time. Preserve the original
  native/network error for late results and log terminal failures explicitly.
- Bound summary text before path regexes to prevent quadratic work on giant
  unbroken lines. Add cross-provider/reload, image, budget, cancellation,
  legacy-session migration and network-failure regressions.

## 1.18.13 (local development patch) - 2026-10-20

- Route Coco callback tools through native ACP sessions. The bundled CLI SDK
  expires MCP callbacks after 30 seconds, including approval/execution time;
  ACP handles long waits. Rebind completed SDK sessions by their native ID
  when tools become available, without replaying the conversation.
- Add an opt-in live latency reproducer and a real VS Code provider test:
  a 35-second inert callback loses its result on SDK and succeeds on ACP.
- Compact oversized structured Cursor cold handoffs within the configured
  character limit. Preserve the latest request and its images, archive the
  complete original, and report the handoff. Oversized current requests and
  unknown prompt formats still stop before inference.
- Record Coco session/history preparation times and callback durations without
  prompt contents or tool arguments. Add opt-in performance measurements and
  a report covering journals, history merges, streaming metrics and Live Report.

## 1.18.12 (local development patch) - 2026-10-19

- Fix the reproduced Coco backend error: tool names must fit 64 characters
  including the `mcp__vscode_chat__` namespace. Twenty of 72 names in the failing
  catalog exceeded the limit (maximum 93). Bound aliases while preserving their
  hash suffix and native Chat routing; validate names/uniqueness before inference.
- Log request correlation, transport, catalog size and maximum wire-name length,
  prompt size, image count and sanitized failures without recording prompt text.
- Add an opt-in request reproducer. The original recorded names fail even with
  a short prompt; fixed names pass with a short prompt, the recorded 1,015,904-
  character input, and resume of a failed diagnostic session. These probes use
  inert schemas because original tool schemas were not recorded; action callbacks
  are disabled. See docs/COCO_TOOL_NAME_INCIDENT.md for evidence and limits.

## 1.18.11 (local development patch) - 2026-10-19

- Prepare large Coco handoffs locally before the first native prompt. Preserve
  the complete latest request, prefer user requirements and recent context,
  and archive the exact original text and image bytes. Show the reduction and
  archive path in Chat. The working target is conservative, not an exact token
  count; the finite backend window still applies. No hidden ACK requests.
- Quote historical @ references so CLI attachment expansion does not reload
  screenshots/logos from old messages. Keep current explicit attachments intact.
- Reject Cortex ACP's explicit internal-error frame even when the runtime
  reports end_turn. Do not checkpoint that failure as a successful answer;
  recover legacy checkpoints whose saved answer was the known error frame.
- Reject malformed SDK protocol events and clear stale rollback state between
  requests. Review and audit the pinned SDK and accumulated native-session work.
- Verify an isolated live handoff using the reported 3,045,868-character archive:
  both control facts survived the prepared first prompt and native process restart.
  The diagnostic allowed no project actions. This checks continuation, not
  preservation of every historical detail in the model's active context.

## 1.18.10 (local development patch) - 2026-10-19

- Make manual Coco connection checks bypass cached startup failures. Selecting
  the existing Snowflake connection now retries it without rewriting settings;
  cancelling the picker leaves the connection and runtime untouched.
- Open Snowflake's secondary-sidebar Coco view on current VS Code versions,
  retaining the classic view for older Snowflake manifests/layouts. The previous
  hardcoded `cortexChat.focus` targeted a hidden view on current VS Code.
- Show cancellable progress while activating Snowflake and opening Coco. Join
  repeated clicks, report activation failures/timeouts, and prevent a cancelled
  or timed-out attempt from opening the panel later. No raw connection errors
  or credentials are included in the notification.

## 1.18.9 (local development patch) - 2026-10-19

- Stop rejecting Coco handoffs using a character-to-token guess. The 1.18.8
  preflight could reject a 3,045,543-character Chat before Coco received it;
  no exact model tokenizer is exposed by the SDK. Send the complete history
  in one native prompt and let Coco enforce its window and manage compaction.
- Keep a separate 64 MiB encoded-payload guard for transport/memory, including
  UTF-8, JSON escaping and image data. Archive oversized payloads before
  inference and identify the guard as a transport limit rather than token usage.
- Cover large cold handoffs, all 14 historical images, and SDK reload with only
  the next turn sent. No ACK requests, automatic replay or middle excerpts.

## 1.18.8 (local development patch) - 2026-10-19

- Use Snowflake's pinned `/code` SDK for native Coco sessions on Node 22.22+;
  retain ACP for older hosts and explicit selection. Discovery still uses ACP.
- Send a fitting Codex/other-provider handoff in one prompt. Remove automatic
  ACK imports and the fixed 500,000-character execution cap. Archive and reject
  histories exceeding the selected window before inference.
- Persist session bindings atomically on disk as well as in workspace state.
  Preserve bindings through preflight/load errors, resume the same native ID
  after reload, and keep confirmed continuations independent of the handoff journal.
- Map native callback identities into Chat tool IDs and reuse completed visible
  results on repeated IDs instead of executing tools twice. Interrupted turns
  continue on a new explicit user message without replaying the old request.
- Preserve images through ACP on the same native session: SDK 0.0.2's stdio user
  input ignores images. Hide replay notifications and return to SDK after the
  image turn without reconstructing history.
- Verify native callback, warm and restored turns, image recognition and a
  subsequent SDK turn on Cortex Code 0.26.1019 / Opus 5.5. Normalize the SDK's
  cumulative process counters into per-request usage without counting cache twice.

## 1.18.7 (local development patch) - 2026-10-19

- Merge the incoming stored-tool-result bounds and MCP tuple-schema fixes
  (Copilot patch v24) with the Cursor continuity and interrupted-run recovery
  work from local builds 1.18.1 through 1.18.6.
- Preserve both independently numbered 1.18.1/1.18.2 histories below; incoming
  patch releases and earlier local Cursor builds used the same version numbers.
- Stream oversized chat-session repairs and apply every snapshot, assignment
  and array delta before bounding the output. Refuse unsafe paths, unsupported
  input names and existing outputs; enforce the budget in UTF-8 bytes.
- Cover chat repair with offline regression tests and use a patched streaming
  JSON parser. Original session files remain untouched.

## 1.18.6 (local development patch) - 2026-10-19

- Recover a Cursor stream interrupted after a VS Code callback finished but
  before its result reached the native checkpoint. Match checkpointed calls,
  SDK stream events and completed visible calls before retaining that snapshot.
- Supply only the results absent from the snapshot as quoted history on the
  next explicit user turn; never re-execute those callbacks or automatically
  restart the model. Retain recovery IDs across reload and preflight errors,
  and clear them after successful continuation.
- Explain Premature close errors, including old saved failure receipts. Reject
  missing results, conflicting event arguments and ambiguous callback matches.
- Validate the affected 37+1 callback case and native resume offline on a copy
  of its store, without network/model requests or changes to original data.

## 1.18.5 (local development patch) - 2026-10-19

- Accept the host's native _conversationId before provider routing, journaling
  and foreign-session cancellation. Preserve valid legacy IDs and existing
  durable keys so Cursor resumes its saved agent after a host update.
- Explain when a large cold replay was blocked because no conversation ID was
  supplied. Keep the 64,000-character automatic replay guard unchanged.
- Verify large-history resume, tool continuation and a second reload through
  the native ID. Offline validation on a copy of the affected store retained
  the same agent and exact checkpoint bytes without any network/model request.
- Select an actually unpatched source for the local Copilot apply/restore test
  when an existing backup already contains the patch.

## 1.18.4 (local development patch) - 2026-10-16

- Report Cursor cache usage as a native-run aggregate; do not classify restored
  sessions as the cause of a miss or assert that native compaction did not occur.
  Leave unavailable model-call breakdown and cold-rewrite counters unreported.
- Record the sent continuation size, native run ID, time since the previous
  completed response, and changes to effective callback schemas across reload
  and tool continuations. Persist only timestamps and catalog hashes.
- Document the observed 70.04% case, checkpoint continuity, large cache writes
  after pauses, and the limits of the SDK's aggregate usage telemetry.

## 1.18.3 (local development patch) - 2026-10-15

- Preserve the original Cursor backend error when Copilot retries a completed
  tool-result batch. Retain bounded error receipts across reload, scoped to the
  same conversation/profile/model identity; retries start no additional model run.
- Keep an error-run native checkpoint only when all its native tool calls have
  terminal results. The next explicit user message resumes that agent with new
  entries instead of replaying the interrupted request's completed actions.
- Repair existing 1.18.2 inflight bindings when the failed run starts from the
  saved checkpoint and every native callback matches the visible completed calls,
  including duplicates and reordered parallel batches. Reject incomplete matches.
- Diagnose the reported failure as Cursor's `[resource_exhausted] Error`, which
  retries previously masked with `tool session is no longer active`. The server
  did not specify the exhausted resource; this patch does not increase its limits.
- Verify repeated result delivery, reload, cross-chat isolation and continuation.
  Local inspection matched all 84 completed callbacks in the affected run;
  real SDK resume on a temporary copy retained its exact native checkpoint
  with networking blocked and zero model prompts.

## 1.18.2 (local development patch) - 2026-10-15

- Persist Cursor conversation bindings atomically beside the SDK store as well
  as in workspaceState. Save the exact completed native checkpoint and user
  anchors; restore that same agent and send only new conversation entries.
- Preserve the last completed checkpoint while a later request is active,
  cancelled or interrupted by reload. Repair missing SDK agent checkpoint
  pointers from native run records and retain new snapshots during status updates.
- Recover lost 1.18.0 bindings only when this chat's original archive, ordered
  user inputs, unique completed reply, model, workspace and run timing agree.
  Reject ambiguous, failed and import-only agents. Keep native bytes unchanged.
- Stop on native resume failure while retaining the checkpoint. Never silently
  turn a failed resume into a costly full-history replay. Preserve the 1.18.1
  cold-prefill guard and disabled multi-prompt imports.
- Verify disk-only recovery, repeated reload of a 1.4M-character chat, reload
  during tool execution, and real SDK JSONL behavior. Two real Agent.resume
  calls on a temporary copy of the affected chat retained the same agent and
  exact checkpoint bytes with networking blocked and zero model prompts.
  Server cache retention remains controlled by Cursor.

## 1.18.1 (local development patch) - 2026-10-15

- Stop automatic multi-prompt Cursor history imports and remove the arbitrary
  500,000-character split. A user request uses one SDK run; native model/tool
  iterations can still occur within that run.
- Reuse compatible Cursor sessions across host-context repacking, retained-tail
  histories, model-catalog refreshes, callback-catalog changes and working-input
  budget changes. Migrate completed 1.18.0 checkpoints without replaying history.
- Reject unmatched history branches before inference while preserving the
  completed session. New-session history above 64,000 characters stops before
  inference and is archived in full. `cursorMaxColdHistoryChars` explicitly
  controls that cold-prefill budget; warm/restored deltas are unaffected.
  `cursorMaxHistoryImportParts` is deprecated and cannot enable paid imports.
- Count native Cursor input once: observed SDK 1.0.37 input already includes
  cache reads/writes, while its total can add them again. Distinguish first cold
  starts from failed session reuse and include the actual continuation reason.
  Existing aggregated usage is retained; server cache hits are not guaranteed.
## 1.18.2 (patch release) - 2026-10-18

- **MCP tools with tuple schemas no longer break the chat.** A JSON Schema
  tuple is written as `prefixItems` without `items`; Copilot's validator
  rejected that shape and failed the whole request with
  `Failed to validate tool <name>: tool parameters array type must have
  items`. Patch v24 fills in an empty `items` schema, so tools such as
  `inspect_analysis_view` from the REA MCP server remain usable.
- Patch v24 upgrades from v23 in place; the preserved original bundle
  backup stays valid.

## 1.18.1 (patch release) - 2026-10-18

- **Saved chat sessions no longer grow past the V8 string limit.** Copilot
  stores every tool result twice: a bounded copy for the prompt and a
  verbatim copy in the saved session. A session with several `view_image`
  calls reached 544 MB, after which VS Code failed every request with
  `RangeError: Invalid string length` while serializing the agent
  arguments. Patch v23 bounds the stored copy as well: binary payloads
  above 200 KB become a compact marker and text above 12 KB is truncated.
  The live tool card keeps its full result.
- **Patch v23 upgrades from v22 in place.** The v22 marker is now a legacy
  marker, so the preserved original bundle backup stays valid and is used
  as the source for the new patch.
- `scripts/repair-chat-sessions.cjs` repairs an already oversized session:
  binary payloads are replaced, huge text is trimmed, the newest requests
  are kept, and a new `*.repaired.jsonl` is written next to the original.
  The original file is never modified.

- Tests: 702 extension-host tests.

## 1.18.0 (stable release) - 2026-10-15

Consolidates the development work since 1.17.3, including the final behavior
of the 1.17.4–1.17.17 patches below.

- Add Cursor SDK models through existing API profiles, with native VS Code
  Tools, Vision, catalog-backed reasoning choices and discovered context limits.
  Preserve profile IDs/keys and restrict actions to Copilot callback tools.
- Keep Cursor and Coco sessions warm, restore completed sessions after reload,
  and retain available cross-provider Chat history in a workspace journal.
  Import oversized history in guarded requests with tools disabled; archive
  complete transcripts, images and large tool outputs instead of silently
  removing early messages or the middle of results.
- Expose native Cursor/Coco input, output and cache read/write counters in
  Quick Access, usage history and session diagnostics. Keep billed tokens
  separate from context occupancy and leave missing counters unreported.
  Use the verified 1M baseline for Coco's exact Opus 5.5 model ID.
- Improve Codex live reasoning/context updates and keep the native question
  tool immediately available. Add provider-first model selection and automatic
  API context discovery with a separate working-context slider.
- Unify provider registration, metadata, snapshots, resource caches, source
  routing and delegated tool state. Simplify Quick Access dependencies and
  load supported balances in the background without blocking the tree.
- Remove Cursor Admin billing/budget controls and requests. Cursor chat keys
  and native token/cache metrics work independently of Admin permissions.
- Share CI/release checks across Windows/Linux and VS Code 1.131/1.141, validate
  release metadata before publication, and publish platform-specific VSIXs.
  Add continuity, cache, UI, lifecycle and native SDK create/resume coverage.

Finite model windows and server compaction still apply. Cross-provider context
transfer does not transfer server caches. Paid Cursor generation remains an
opt-in check; see docs/RELEASE_NOTES.md for verification scope and installation.

## 1.17.17 (local development patch) - 2026-10-15

- Keep Cursor SDK agents warm per workspace, saved profile, credentials, model
  configuration and conversation; restore completed native checkpoints after
  reload, or replay the full visible history when restore fails.
- Extend the workspace Chat journal to Cursor handoffs and foreign-provider
  continuation. Import large histories with bounded requests and disabled
  callbacks; archive large tool outputs instead of losing their middle.
- Remove silent history dropping in Cursor's Cloud fallback. Oversized requests
  now stop explicitly. Keep stale tool results and cancelled branches isolated.
- Record native SDK input/output and cache read/write usage in API profile
  metrics, API usage history and session diagnostics. Separate these counts
  from context occupancy; render missing cache counters as unreported.
- Show native Cursor/Coco session details and separate fresh input from cache
  writes in the diagnostics dashboard. Add continuity, archive, native SDK
  create/resume and opt-in real-inference checks.

## 1.17.16 (local development patch) - 2026-10-15

- Keep Coco sessions per workspace, conversation, model and connection, append
  new entries on warm turns, and restore compatible sessions after reload.
  A workspace-local visible Chat journal supports Codex → Coco handoffs and
  returning to Coco after another provider has continued the conversation.
- Import large histories in bounded requests with tools disabled during import;
  preserve full transcripts, image bytes and oversized tool outputs locally.
  Guard automatic import counts instead of silently discarding older messages.
- Record ACP prompt input/output and cache read/write tokens in Coco's own
  usage history, Quick Access and session diagnostics. Keep context occupancy
  separate from billed tokens and leave missing cache counters unreported.
- Use a verified 1M initial window for the exact Opus 5.5 model ID, with
  per-model overrides and live runtime telemetry taking precedence.
- Verify cold/warm/restored Opus 5.5 requests and an actual provider handoff
  with facts retained from the beginning and middle of the conversation.

## 1.17.15 (local development patch) - 2026-10-15

- Remove Cursor balance cards, budget-access settings, the Cursor Budget command
  and Admin API requests. Keep chat credentials and model configuration intact;
  deleting a profile still cleans up its legacy budget credentials.
- Preserve background balance loading and cache-invalidation checks for
  OpenRouter. Document verified Coco long-chat limits, fresh-session behavior,
  and information lost by history/tool-result shortening, including Opus 5.5.
  This patch does not change Coco's context management.

## 1.17.14 (local development patch) - 2026-10-15

- Share CI and release verification across Windows/Linux and VS Code
  1.131.0/1.141.0. Gate packaging on all tests and publication on matching
  manifest, lockfile, tag and release-notes metadata.
- Refresh architecture and maintenance documentation and record a Quick Access
  audit. Extract common tree items and metric rows with consistent live/last
  labels, precision hints and optional throughput.
- Capture provider snapshots once per tree render, show API token history,
  display the actual DeepSeek endpoint and remove empty expansion arrows.
- Load account balances in the background so slow budget requests cannot block
  the control tree; avoid repeated requests on unsupported balance endpoints.
  Keep other sections usable when profile metadata cannot be read.

## 1.17.13 (local development patch) - 2026-10-15

- Register transport ownership, source labels and subscription status through
  shared provider definitions. Preserve saved model IDs and profile credentials.
- Build model metadata through a common descriptor and token-limit projection;
  use provider snapshots and named Quick Access dependencies. Attribute custom
  API metrics to their source instead of Local or DeepSeek model-family guesses.
- Share TTL, concurrent request joining and generation invalidation across
  balances and catalogs. Cancelling one reader leaves other readers active.
- Move Cursor/HTTP source selection behind an API transport router covering
  discovery, responses, token counting and resource disposal.
- Share delegated tool response boundaries and bounded buffers for Cursor/Coco
  and pending result delivery across Cursor, Coco, Claude and Codex. Preserve
  protocol-specific result codecs, cancellation and session recovery.
- Add provider, descriptor, cache, transport and tool-controller contract tests.

## 1.17.12 (local development patch) - 2026-10-14

- Show Cursor's remaining team spending budget, current-cycle on-demand
  charges and enforced per-user limit in Quick Access. Report total usage
  including subscription credits separately; refresh the budget every minute.
- Add budget access and manual refresh actions to the existing Cursor profile.
  Save an optional Admin API key separately from the chat key and allow selecting
  the team member's email. Budget changes do not interrupt active SDK chats.
- Match the exact team member and report missing limits or access errors without
  inventing a balance. Cover currency conversion, access, caching, stale requests
  and Quick Access rendering with regression tests.

## 1.17.11 (local development patch) - 2026-10-14

- Fix Cursor runs failing with `unknown option '--system-prompt'`. Send the
  VS Code bridge instructions in the prompt instead of the unsupported SDK
  systemPrompt override; retain callback-only tools and settings isolation.
- Surface the original SDK run error message and code, redacting saved API keys
  and authentication tokens instead of replacing diagnostics with status error.
- Verify compatibility with a runtime rejecting systemPrompt, preservation of
  model reasoning parameters and images, and safe diagnostic reporting.

## 1.17.10 (local development patch) - 2026-10-14

- Expose Cursor reasoning parameters as the native Thinking Effort navigation
  picker next to the chat model. Preserve catalog labels and defaults and show
  only values advertised in model parameters or variants.
- Map VS Code's reasoningEffort selection to the original Cursor parameter ID
  when calling the SDK/API. Keep legacy raw parameter options supported and
  reject unsupported values before starting a run.
- Verify picker metadata, parameter aliases, variant-only catalogs and delivery
  of the selected effort to the SDK across native tool-call continuations.

## 1.17.9 (local development patch) - 2026-10-14

- Make Cursor models available in Agent mode with real VS Code Tools support
  through the official local Cursor SDK. Continue using the saved API profile
  and key; inference stays on Cursor's servers.
- Restrict the SDK to supplied callback tools. Emit native Copilot tool calls,
  wait for their results, and resume the same run. Handle parallel calls,
  cancellation, changed credentials, revoked tools and historical results.
- Load the SDK lazily and use its JSONL store without requiring node:sqlite.
  Keep chat-only Cloud Agents fallback when the host cannot run the local SDK.
- Verify initialization of the installed SDK in the VS Code extension host,
  native callback handoffs, image results, profile isolation and picker mode.

## 1.17.8 (local development patch) - 2026-10-14

- Add Models by Provider to the chat and Quick Access title bars and command
  palette. Choose a provider first, then only its models, with back navigation.
- Keep API profiles distinct by ID, show unavailable enabled profiles, and
  retain existing native model IDs and labels. Selection updates the current
  chat without sending a prompt; chat-only models switch to Ask mode.
- Preserve the native model picker for model configuration. Add regression
  coverage for grouping, duplicate names, selection, navigation and cancellation.

## 1.17.7 (local development patch) - 2026-10-14

- Integrate Cursor Cloud Agents through saved Providers Manager profiles, with
  a Cursor preset and API format. Existing Cursor profile IDs and keys survive
  automatic detection; disabling a profile removes its models.
- Discover model names, supported parameters and reported context windows.
  Route chat to the official agent/run API, handle streaming and remote
  cancellation, and isolate conversations, profiles and changed credentials.
- Remove the standalone Cursor provider, global enableCursor setting and
  artificial Unsupported API badge. Cloud actions are identified in the UI.
- Add regression coverage for profile routing, credentials, SSE, continuation,
  cancellation, authentication failures and failed runs.

## 1.17.6 (local development patch) - 2026-10-14

- Discover API model context limits automatically. The add/edit form no longer
  requests a context maximum; each provider card has a working-context slider
  and an automatic reset. Keep reported maxima separate from smaller user caps,
  retain existing caps on edits, and support reported windows above 1M.
- Read model catalogs wrapped in `items` as well as `data`, `models` and `result`.
  Explain that api.cursor.com serves Cursor Cloud Agents instead of displaying
  it as a ready OpenAI-compatible provider with no usable models.
- Shorten large Coco histories while preserving the latest request, current
  images and recent results. Reserve space for tools and agent instructions.
  Count oversized historical messages without throwing a prompt-size error.
- Verify automatic/working context, UI controls, API compatibility and bounded
  Coco prompts, including preserved image bytes and the ends of large logs.

## 1.17.5 (local development patch) - 2026-10-12

- Keep the native VS Code question tool in Codex's immediately visible catalog.
  Clarification questions no longer require discovering a deferred tool first.
- Instruct Codex to use the native question card for clarifications and choices.
  Namespace a contributed `request_user_input` tool to avoid confusing it with
  Codex's built-in tool, whose availability depends on collaboration mode.
- Verify question visibility and namespace routing on VS Code 1.141.

## 1.17.4 (local development patch) - 2026-10-12

- Stream Codex raw reasoning deltas alongside readable reasoning summaries.
  Show a brief activity status when a reasoning item starts, including when
  the runtime supplies no readable thoughts.
- Update native Chat context usage as Codex reports measured token counts,
  rather than waiting until the entire agent task ends. Restore the latest
  snapshot on native tool continuations and retain known context between turns.
- Verify live reasoning, late usage updates during tool execution, context
  reductions after compaction and separation from cumulative billing totals.

## 1.17.3 (patch release) - 2026-10-10

- Replace the withdrawn 1.17.0 release with the verified Windows/Linux packages,
  retaining Coco integration, vision, thinking, context usage and native tools.
- Offer a user-owned VS Code copy or administrator authorization for Linux
  system installations. Detect sudo or su, preserve selected user paths,
  validate syntax in a private temporary directory and retain restore backups
  when system files cannot be written.

- Fix Quick Access Apply Patch after failed sudo/su authorization: reopen the
  retained terminal and offer a retry or a fresh workflow instead of leaving
  the global authorization guard active.
- Wait for shell integration before sending the administrator command, track
  its execution directly, and retain a failed runner until retry or closure.
  Prevent duplicate commands while the password prompt is active.
- Check failed-command recovery, integration readiness and cleanup, including
  retry in a real Linux bash terminal.

## 1.17.2 (local development patch) - 2026-10-10

- Administrator patching detects sudo or su instead of assuming sudo exists.
  On Debian without sudo, the visible terminal passes the quoted patch command
  through su - root -c and lets the user enter root's password directly.
- Keep the patch runner after a failed terminal attempt and offer a retry.
  Remove it after success or when the terminal is closed.
- Document the GUI fixture's locked root account and manual password setup.
  Verify su command parsing, literal paths and patch/restore on real Linux files.

## 1.17.1 (local development patch) - 2026-10-10

- Offer a user-owned VS Code copy or explicit administrator authorization when
  Linux patching fails or only applies part of the patches. Individual terminal
  and Agents patch commands offer the same recovery choices.
- Use asynchronous graphical authorization, with an optional visible sudo
  terminal. Preserve the user's selected paths and ordinary compatibility and
  backup checks instead of rediscovering extensions under root.
- Validate patch syntax in a private temporary directory; keep original backups
  when restoring a read-only workbench fails.
- Update the main README: explain the patches, document current Linux choices,
  include Coco consistently, and remove obsolete installer environment flags.

## 1.17.0 (withdrawn; replaced by 1.17.3) - 2026-10-10

- Add Snowflake Cortex Code (Coco) to native Chat and Quick Access: discover
  models through ACP, reuse the configured Azure OAuth connection, expose
  reasoning choices, stream thinking and forward image input when supported.
- Delegate actions to native Chat tools and approvals. Coco command tools use
  interactive VS Code terminals, reuse idle shells, preserve state and allow
  user input, cancellation and closing the actual process.
- Bound and cancel connection checks; keep context usage and runtime window
  sizes across tool continuations. Validate ACP messages, accept string request
  IDs and contain handler failures.
- Apply compatible patches on extension startup. On Linux, prepare a writable
  desktop copy under the user's home without modifying system files or needing
  root. Native capabilities and read-only files remain visible in patch status.
- Ship separate Windows x64 and Linux x64 VSIX packages, each built and tested
  on its platform. Remove external installers and the repository patch wrapper;
  install the VSIX normally and use the extension's patch commands.
- Update vulnerable dependencies and the VSIX packager. Full dependency audit
  reports zero known vulnerabilities as of this release.

## 1.16.16 (local development patch) - 2026-10-10

- Add **Prepare User VS Code (Linux, no root)** to create a writable copy of
  the current desktop build and a launcher in the user's home directory. The
  copy applies patches on normal extension startup while leaving system files
  untouched. Existing extensions are shared through the CLI; a separate user
  profile prevents forwarding into an already-running system VS Code.
- Offer this route after Linux patch permission failures. Repeated preparation
  preserves existing patches; cancellation removes incomplete copies, and
  application symlinks are copied into independent writable files.
- Apply the agent-host thinking and response compatibility patch on normal
  startup too; previously this part required the installer or a manual command.
  Skip it when VS Code provides those capabilities natively. It can be disabled
  with `llamacpp.agentHostThinkingPatchEnabled`.
- Extend Debian verification to migrate a root-owned installation as UID 1000,
  install through the generated launcher, and check automatic patches on the
  resulting desktop application.

## 1.16.15 (local development patch) - 2026-10-10

- Forward Coco ACP `usage_update` snapshots to the native Chat context usage
  channel. Use the runtime's current `used` count and update the model's total
  context window from `size`, instead of the fallback 128k window.
- Keep the latest snapshot across Chat tool-result continuations and accept
  reduced usage after compaction. Clear observed windows when changing the CLI
  or Snowflake connection. Cumulative billing totals and unreported output/cache
  counts are not used as measured context.

## 1.16.14 (local development patch) - 2026-10-10

- Advertise Coco image input when the active ACP runtime reports
  `promptCapabilities.image`. Preserve the negotiated capability while refreshing
  the same source and clear it when the Snowflake connection or CLI changes.
- Send image attachments as ACP image blocks with their original bytes and MIME
  types, preserving their position in the conversation. Include image attachments
  in context estimates and reject unsupported runtimes instead of dropping images.
- Verify real image recognition through the bundled Cortex CLI and cover vision
  discovery, multimodal requests and attachment handling with regression tests.

## 1.16.13 (local development patch) - 2026-10-10

- Bound the complete Coco connection check to 45 seconds, including startup and
  session creation. Timeout, cancellation, launch failure and source changes
  settle the caller without relying on the CLI to answer or reject its RPC.
- Make the progress notification cancellable and show its current stage. Share
  repeated status/model refresh clicks, reuse fresh status, and keep the known
  catalog and thinking controls while checking the same connection.
- Discard late replies, allow explicit retry, and accept a live Chat session's
  catalog as proof of connection. Preserve status after stale probes finish.
- Match Snowflake's CLI launch environment by removing VS Code's Node hooks and
  adding the CLI directory to PATH. On Windows, stop the owned CLI process tree
  on disposal so helper processes are also closed.
- Cover stuck initialization, late replies, cancellation, concurrent refreshes,
  launch errors and progress notifications. Verify live ACP discovery without
  running model inference.

## 1.16.12 (local development patch) - 2026-10-10

- Automatically reuse the last idle Coco terminal when a command omits
  `terminalId`, preserving the shell process, directory and variables. A failed
  command no longer causes a new terminal for the next command.
- Reserve the selected terminal before asynchronous initialization. Skip running,
  closed and user-occupied terminals; honor the requested directory and expose
  `newTerminal` for commands that explicitly need a separate shell.
- Cover default reuse, explicit selection, concurrent commands and closure.
  Verify preserved variables and the same process in a live PowerShell terminal.

## 1.16.11 (local development patch) - 2026-10-09

- Give Coco registered Chat tools for commands in ordinary interactive VS Code
  terminals. Users can type, interrupt with Ctrl+C, or close the terminal tab.
  Commands retain native Chat approval; terminal output and status return to Coco.
- Exclude Agents Window background `powershell`/`bash` tools from Coco's ACP
  catalog. Preserve the caller's registered tool names and reference aliases.
- Capture bounded output through shell integration, reuse idle terminals, and
  resolve waits when a terminal closes. Do not interrupt commands started by the
  user or rerun commands on timeout or output failure.
- Verify input and actual shell process termination in a live PowerShell 7
  terminal, alongside routing, cancellation, isolation and output bounds.

## 1.16.10 (local development patch) - 2026-10-09

- Delegate Coco tool calls through native Chat tool-call and tool-result parts,
  including private Copilot tools. Chat now applies its permission mode and
  displays command execution and results in the current conversation.
- Keep the ACP prompt alive across tool steps, route results by call ID, and
  close cancelled, expired or invalid continuations. Preserve historical tool
  output when starting a new user turn.
- Stop built-in Cortex actions that bypass Chat. Remove the separate ACP
  permission picker instead of auto-approving an independent agent flow.
- Verify the native provider loop against a live Azure-authorized ACP session
  and cover delegation, parallel conversations, cancellation and invalid results.

## 1.16.9 (local development patch) - 2026-10-09

- Add Coco to Quick Access with ACP connection status, discovered model count,
  source toggle, Snowflake connection selection, catalog refresh, and links to
  thinking controls, settings, and the Snowflake Coco panel.
- Check Coco status without model inference. Keep its recovery controls visible
  while offline, deduplicate concurrent checks, and discard outdated results
  after changing connections. Disabled sources refuse new chat requests.
- Integrate Coco with the provider status directory and refresh its status
  when its configuration changes.

## 1.16.8 (local development patch) - 2026-10-09

- Expose Coco's ACP thinking levels in the native model configuration picker.
  Send the selected effort through `session/set_config_option` before the
  prompt, using the active runtime's `thought_level` option and supported values.
- Stream `agent_thought_chunk` events into native VS Code thinking parts,
  separate from answer text. Preserve consecutive thought deltas in one block
  and stop emitting them when the request is cancelled.
- Add regression coverage for thinking schemas, unsupported levels, and
  reasoning/answer stream separation.

## 1.16.7 (local development patch) - 2026-10-09

- Add Snowflake Cortex Code (Coco) as a native VS Code Chat model source via
  the ACP server bundled with the Snowflake extension. The picker starts with
  Auto and adds the models available to the active Snowflake role after ACP
  discovery. Model responses stream into Chat.
- Reuse the configured Snowflake CLI connection and its Azure OAuth flow.
  No Snowflake credentials are copied into AI Agent Bridge. Coco receives the
  registered VS Code tools offered for the turn and asks for approval before built-in
  actions that require it.
- Give the real-bundle Copilot patch regression test enough time on slower
  hosts. The build remains a local VSIX until a release is requested.

## 1.16.6 (patch release) - 2026-10-06

- **Patches no longer require administrator rights, and no longer fail when
  they are unavailable.** Copilot Chat is now searched the way it is actually
  installed instead of only inside the application root: a remote extension
  host finds the Linux server copy (which has no
  `out/vs/workbench/workbench.desktop.main.js`), a Code - OSS installation
  finds the user extension in `~/.vscode-oss/extensions`, and a WSL session
  finds the Windows installation under
  `/mnt/c/Users/<you>/AppData/Local/Programs/Microsoft VS Code/<commit>` by
  matching the commit of the running server. Every copy is patched, and each
  one borrows the workbench of the window.
- **The Copilot bundle and the VS Code workbench are applied independently.**
  A read-only or missing workbench is reported as a `Notice:` in the status
  output instead of aborting the whole patch, so `Could not locate the bundled
  Copilot Chat extension` cannot happen when the Copilot bundle is found.
- **A failed write reports what was searched.** The `AI Agent Bridge Copilot
  Patch` output channel lists every application root and extension directory
  that was checked.
- **Elevation is offered when it is actually needed.** On a system-wide Linux
  installation, `AI Agent Bridge: Apply Copilot Chat Patch` offers **Retry with
  administrator rights**, which runs the patch through `pkexec` (policy-kit
  dialog) or passwordless `sudo`, and prints the exact `sudo` command when
  neither is available. A WSL extension host explains that it cannot elevate
  into Windows and points at the User Installer instead.

## 1.16.5 (patch release) - 2026-09-29

- **API keys stay with their intended endpoint.** The primary key is no longer
  sent to DeepSeek unless the primary server is the official HTTPS DeepSeek
  API. A workspace setting cannot redirect a key stored for the global primary
  URL to another host. DeepSeek host detection now requires the exact official
  hostname instead of accepting lookalike domains.
- **HTTP error bodies no longer reach logs or user-facing errors.** The small
  part needed for retry and compatibility detection is read with an 8 KiB cap
  and a three-second deadline;
  the rest of the stream is cancelled. This also prevents a provider from
  exhausting memory or disk with a large error response.
- **The Linux/macOS installer no longer elevates or changes ownership of VS Code
  files.** It runs as the current user and reports when a system-wide VS Code
  installation needs a user-owned installation for patching.
- **Copilot Chat patch handles the current VS Code workbench serializer.**
  Regression tests cover both the older and current bundle shapes; user-owned
  VS Code installations can apply the patch without administrator rights.
- **Dependency lockfile updated.** `npm audit` reports zero vulnerabilities in
  the full dependency tree as of this release.

## 1.16.3 (patch release) - 2026-09-25

- **Quick Access: subscription limit rows no longer truncate the reset moment.**
  The Codex `Session Limit (5h)` and `Weekly Limit` rows packed the percent used
  and the reset time into a single line, so `resets 9/23/2026, 3:11:00 PM` was cut
  off exactly where the reset time begins. Each row now keeps the short
  `0% used` summary on the parent row and shows `Next Reset` on an indented
  child row that starts at the left edge of the tree, so the timestamp is fully
  visible. The rows render expanded by default, and the fallback `Usage Limit`
  row uses the same layout.

- **Both installers pick the newest VSIX by version.** The Windows script no
  longer holds a hardcoded `PRIMARY_VSIX` from the release it shipped with, and
  the name-based fallback is gone as well: it sorted names, so `1.16.9` beat
  `1.16.10` and the older file was installed. The choice is now made with a
  version comparison (`PRIMARY_VSIX` still forces one file, `LLAMACPP_VSIX`
  still overrides both scripts). Verified in an isolated fixture with a stub
  CLI and a stub VS Code tree — newest-version selection, temp copy, patch
  phase, `SKIP_PATCHES=1`, `DRY_RUN=1` and the missing-VSIX error path — and
  end-to-end on Windows, where the script selected 1.16.3 out of four VSIX
  files and installed it.
- **The README matches the project again.** It claimed Windows was the only
  supported platform and called the Linux installer "VSIX installation only",
  while that installer applies the VS Code / Copilot Chat patches in the same
  run. The install section now documents both platforms, the real installer
  behaviour and every environment override, and its examples use the current
  version; the development block names 1.16.2 as stable and 499 tests.

- **Releases are published from a tag.** Pushing `v*` runs the Release
  workflow (lint, tests, `npm run package`), which attaches the VSIX and
  `install-ai-agent-bridge.sh` to the GitHub Release and uses
  `docs/RELEASE_NOTES.md` as its description — so the notes and the changelog
  have to be updated before tagging. `AGENTS.md` now says so next to the
  versioning rules.

## 1.16.2 (stable) - 2026-09-18

- **The reasoning level now actually reaches the server.** Only
  `enable_thinking` and `thinking_budget_tokens` were sent, and the `thinking`
  level selected in the model picker changed nothing but that unused budget:
  the Qwen3 chat template shipped with llama.cpp reads its effort from
  `chat_template_kwargs.reasoning_effort` and never looks at
  `thinking_budget_tokens`, so every conversation ran at the template default
  regardless of the pick. The level is now forwarded as `reasoning_effort`
  using the canonical names the template validates — `low` for Light, `medium`
  for Balanced and `high` for Deep — while `auto` is omitted so the server
  default applies. This matters because the template maps `high` onto `xhigh`,
  validates the value and raises a template exception for anything else, so
  forwarding our internal level names (`deep`, `balanced`, `light`) verbatim
  would have failed every request with a 400. Measured against a live llama.cpp
  b9506 server: `low` produced 108 reasoning characters, `xhigh` produced 625,
  confirming the field changes model behaviour and not just the request body.
- **`thinking_budget_tokens` still applies where a server honours it**, so
  older llama.cpp builds that consume the budget keep working unchanged.

## 1.16.1 (dev, shipped in 1.16.2) - 2026-09-18

- **Model reasoning now reaches a llama.cpp server that sits behind an
  OpenAI-compatible gateway.** Reasoning was only ever switched on for the
  `llamacpp` API format, so a provider configured as OpenAI-compatible never
  received `chat_template_kwargs.enable_thinking` — and a Qwen3 chat template
  with thinking disabled emits no reasoning at all. The same model therefore
  showed its thoughts when called directly and appeared silent through the
  gateway, and the thinking level picked in the model picker had no effect.
  Custom API providers gained a **llama.cpp server behind this endpoint**
  option (Providers Manager → provider → Edit). When enabled, the provider
  sends `cache_prompt`, `chat_template_kwargs.enable_thinking` and
  `thinking_budget_tokens` on top of the OpenAI-compatible shape, keeping the
  gateway format but restoring native thinking. It stays off by default because
  a strict OpenAI endpoint rejects unknown request arguments, and the
  DeepSeek-native format keeps its own fields regardless.
- **The installer finds the newest VSIX by itself.** It previously preferred a
  hardcoded file name for the release it shipped with, so once two `.vsix`
  files sat in the download folder the older one could win. It now parses the
  version out of `llama-vscode-chat-<version>.vsix` and
  `llama-vscode-chat-v<version>.vsix` and always picks the highest, and
  `LLAMACPP_VSIX=<path>` overrides the choice.
- **Log no longer claims a bogus `chat_template_kwargs` field was sent.**
  `cloneForLog(undefined)` fell through `JSON.stringify`, which returns
  `undefined`, then threw in `JSON.parse` and reported the literal string
  `"undefined"`. Every non-llama.cpp request logged
  `"chat_template_kwargs":"undefined"`, which made it look like a malformed
  field was going to the server. The value was never part of the real request;
  it now logs as `undefined`.

## 1.16.0 (stable) - 2026-09-17

Stable release consolidating the 1.15.x development patches.

- **One-step install** (1.15.18): the installer applies the VS Code / Copilot
  Chat patches itself with the extension's own compiled patch code, so
  installing and patching are a single script run. It never blocks on a terminal
  password prompt, requests elevation only after a real permission error, and
  uses the polkit system dialog; written files are handed back to the user.
- **VS Code 1.136.1 / Copilot Chat 0.64.1 support** (1.15.16-18): the Copilot
  patch follows the renamed minified bindings and the new `modelCapabilities` /
  `conversationId` signature, the agent-host patch is capability-detected
  instead of failing on newer builds, and builds such as 1.131 are still patched
  exactly as before.
- **Agent tool `llamacpp_wait_for_terminal`** (1.15.11-15): wait for a real
  terminal command instead of sleeping, and built-in tools are injected into the
  catalog even when the host does not propagate them without a restart.
- **Claude reliability** (1.15.2, 1.15.7-10): cross-provider context recovery
  with a 256K replay budget, sign-out clearing durable sessions, recovery
  without a usage snapshot, a warning when recovery is bounded, and usage no
  longer erased by background probes.
- **Accurate subscription and billing state** (1.15.4-6, 1.15.17): Codex shows
  both rate-limit windows and no longer duplicates the «Usage Limit» row,
  DeepSeek peak hours are weekday-aware, and DeepSeek vision models are
  advertised as image-capable.
- **Long conversations stay usable** (1.15.2, 1.15.14): compaction trims
  reasoning content instead of dropping the tail, keeping turns and their tool
  results in context.
- **Memory hygiene** (1.15.3): store guardrails, a search output budget, pinned
  entries always injected, and a Memory Health report.
- **Tests**: 492 extension-host tests.

## 1.15.18 (dev) - 2026-09-17

- **Installer applies the VS Code patches itself, in one run.** Installing the
  extension and patching VS Code are now a single script invocation instead of
  requiring a window reload plus a manual Command Palette step.
  - The patch step reuses the extension's own compiled patch code, so the
    installer and the runtime can never disagree, and the runner is generated at
    `~/.local/share/llama-vscode-chat/apply-patches.sh` so it can be re-run after
    a VS Code update.
  - It never blocks on a terminal password prompt. Elevation is requested only
    after an unelevated pass actually hits a permission error, and then in this
    order: passwordless `sudo`, the **polkit system dialog** (`pkexec
    --disable-internal-agent`, i.e. the desktop password window), a graphical
    `SUDO_ASKPASS` helper, or — if none is available — it applies what it can and
    prints the single `sudo bash …` command to finish the rest.
  - The reason for the privilege request is printed explicitly: each unwritable
    bundle is listed together with the feature it unlocks, and the text states
    that nothing is downloaded, no package is changed, originals are backed up
    next to the file, and `AI Agent Bridge: Restore Copilot Patch` reverts them.
  - Files written under elevation are handed back to the invoking user, so the
    extension's own auto-patch and restore keep working afterwards.
- **Agent-host patch is now capability-detected instead of failing on newer
  VS Code builds, while older builds keep the patch.** VS Code 1.136.1
  implements all three agent-host behaviours itself (verified 2026-09-17 in the
  shipped `agentHostMain.js`): the BYOK thinking-level picker is derived from the
  provider's `configurationSchema.properties.reasoningEffort`
  (`_createThinkingLevelConfigSchemaProperty`), the proxy answers non-streaming
  requests with JSON instead of always using SSE, and the request builder
  forwards `reasoningEffort`. Previously the resulting pattern mismatch was
  reported as «VS Code version mismatch?» and the installer asked for root over
  a file that needed no patching. `inspectAgentHostPatchSupport` now classifies
  each capability as `applied` / `patchable` / `native` / `unsupported`, so:
  - a build that provides them natively is reported as such, mutates nothing and
    creates no backup;
  - builds such as 1.131, which contain none of these signatures, are still
    patched exactly as before;
  - only a genuinely unknown bundle shape raises an error, and it names the
    capabilities it could not satisfy.
  The thinking-level picker itself already works on 1.136.1 without any patch,
  because `createReasoningConfigurationSchema` supplies
  `properties.reasoningEffort` and VS Code maps it to
  `supportedReasoningEfforts` / `defaultReasoningEffort`.

## 1.15.17 (dev) - 2026-09-14

- **Providers Manager UI de-duplicated.** Each model source now appears once,
  with its live reachability folded into the card instead of being listed both
  as a "card" and in a separate "Provider availability" row:
  - built-in cards (Local / DeepSeek / Codex / Claude) show a live reason line
    (e.g. `Reachable at …` or the probe error);
  - custom provider cards show the real live state (`Online`/`Offline`/…) and
    reason via the directory's `api-<id>` probe, so a bad API key is visible on
    the card itself;
  - the redundant "Provider availability" section is removed and the custom
    list gains a "Custom API providers" heading;
  - the toolbar counter now reports overall reachability
    (`N of K sources online`) instead of only counting custom profiles.
- **Real-bundle Copilot patch test is now version-aware.** The test asserted the
  0.64.1 `modelCapabilities:d` / `conversationId:p` bindings unconditionally, so
  it failed whenever the located bundle was older — for example the Copilot Chat
  0.59.0 shipped with VS Code 1.131, whose `makeChatRequest2` has neither. The
  test now detects the upstream shape and asserts the matching wiring: preserved
  upstream bindings for 0.64.x, injected `__llamaModelCapabilities` slot for
  legacy bundles. The patch itself was already correct for both shapes.
- **Codex «Usage Limit» no longer duplicates the session limit.** The row is
  documented as an endpoint-unavailable fallback, but Quick Access rendered it
  unconditionally, so a live Plus plan showed «Usage Limit 5h · 100% used ·
  resets …» directly under the identical «Session Limit (5h) 100% used · resets
  …». It now renders only when `codexUsageLimitSummaries` returns no window data.

## 1.15.16 (dev) - 2026-09-06

- **Copilot Chat patch now supports VS Code 1.136.1 / Copilot Chat 0.64.1.**
  Upstream renamed minified bindings and added `modelCapabilities` and
  `conversationId` to the `makeChatRequest2` signature, which broke every
  `replaceOnce` anchor and made the patch fail with «Copilot request signature
  already contains modelCapabilities without this patch marker». All anchors
  now capture the minified names with regex groups:
  - request signature / `modelOptions` use the upstream `modelCapabilities`
    binding and inject `reasoningEffort` from it (older bundles keep the
    injected `__llamaModelCapabilities` slot);
  - `conversationId` is read directly from the signature (fallback: telemetry
    payload) and sent to llama.cpp as `_copilotConversationId`;
  - agent history render now captures the first parameter (`n` in 0.64.1,
    `t` before), `getAvailableTools` captures its argument, the git
    repositories guard matches `()=>n.repositories??[]`, and
    `patchVsCodeWorkbenchBundle` follows the new `return{text:i.replace(...)`
    shape and `case"text":` location;
  - the git repositories guard counts occurrences with `RegExp.exec` instead
    of `String.split` (the capture group skewed the count) and still requires
    the pattern to be unique.
  Tests: new 0.64.1 fixture shapes for the agent history cap and the git
  guard; the real-bundle test asserts the 0.64.1 signature is kept intact.

## 1.15.15 (dev) - 2026-08-27

- **`llamacpp_wait_for_terminal`: unambiguous mechanics and result.** The
  tool description now states explicitly that it resolves on the FIRST
  terminal-command-completion notification anywhere (any terminal, any
  command) and does NOT track a specific command or terminal. The result now
  reports the finished command line, terminal name, working directory, exit
  code and duration, plus a note that the finished command may not be the one
  the caller started (then: check `get_terminal_output` and wait again).
  Low-confidence command lines are flagged.

## 1.15.14 (dev) - 2026-08-26

- **Compaction no longer collapses the tail to a tiny fragment when
  `compactMaxReasoningChars` is exceeded.** Previously the reasoning cap in
  `compactMessagesDetailed` was a *turn* budget: the tail was dropped until
  surviving `reasoning_content` fit the cap, so with `thinkingMode: deep`
  (2-4K reasoning chars per turn) a 24K cap kept only ~6 turns while most of
  the 50% target stayed unused (factory log: 254 749 → 43 385 tokens at a
  target of 127 374, `targetFillPercent: 34.1`). Now the cap trims the
  reasoning **content** of the oldest retained blocks (`trimReasoningContent`),
  keeping turns (with their tool results) in context; assistant tool-call
  messages always keep the `reasoning_content` field, just shorter.

## 1.15.13 (dev) - 2026-08-26

- **Built-in agent tools are injected into the tool catalog, and catalog
  stabilization no longer hides tool-set changes.** Some VS Code hosts do not
  propagate newly registered tools into request options until a full restart,
  so `llamacpp_wait_for_terminal` never reached the model. The provider now
  appends missing built-in tools itself (`ensureBuiltInTools`, deduped by
  name) before conversion, and `stabilizeToolCatalog` compares the *set of
  stable tool names* instead of only the count — a same-count swap (new tool
  in, old tool out) now rebuilds the catalog and produces the expected cache
  miss instead of silently keeping the old list. Diagnostics: `builtInInjected`
  and `builtInTools` in `chat.tools.catalog_converted`.

## 1.15.12 (dev) - 2026-08-26

- **`llamacpp_wait_for_terminal` simplified**: the agent calls the tool,
  waits for the FIRST terminal command notification (`onDidEndTerminalShellExecution`)
  and continues immediately. Removed command matching, output buffering and
  tail parameters; the only input is an optional safety-net `timeoutMs`
  (default 10 min). The tool returns the command line, exit code and duration.

## 1.15.11 (dev) - 2026-08-26

- **New agent tool `llamacpp_wait_for_terminal`**: an agent can wait until a
  terminal command actually finishes instead of sleeping for a guessed
  duration. It listens to VS Code shell integration events
  (`onDidStart/onDidEndTerminalShellExecution`), matches a `command` substring
  (case-insensitive; omit to wait for the next command), and returns exit
  code, duration, cwd and the last output chars. `timeoutMs` is only a safety
  net (default 15 min). New files: `src/tools/wait-terminal.ts`,
  `src/test/wait-terminal.test.ts`; registered in
  `package.json → contributes.languageModelTools` and `extension.ts`.
  Shell integration must be enabled (`terminal.integrated.shellIntegration.enabled`),
  and the start event must be observed for output capture (otherwise the
  result still carries exit code/duration).

## 1.15.10 (dev) - 2026-08-26

- **Claude usage no longer erased by background probes**: Claude only
  populates `rate_limits` after the first real model request in a session,
  so every fresh background probe (5-min cycle) returned `rate_limits: null`
  and overwrote the real limits captured by a live turn — Quick Access
  stayed on «No data yet». `recordUsageSnapshot` now retains previous valid
  limits when a probe reports none (`hasClaudeRateLimits`), and logs
  `claude.usage_snapshot` (with `retainedPrevious`) plus
  `claude.runtime_snapshot.attempted` for diagnostics.

## 1.15.9 (dev) - 2026-08-26

- **Claude bounded recovery warns the user**: when the full replay is capped
  by `claudeResumeFallbackMaxInputTokens` and only the latest message is sent,
  a one-time warning explains that context was not fully restored and how to
  raise the cap (or continue in a new chat). No behavior change otherwise.

## 1.15.8 (dev) - 2026-08-26

- **Claude recovery unblocked when usage snapshot is missing**: the Claude
  usage endpoint may report `rate_limits: null` even on an active Pro plan
  (verified live), which made every recovery fail with
  `usage_unknown` — "Claude durable session is quarantined". The bounded
  latest-message recovery (one user message, already capped by
  `resumeFallbackMaxInputTokens`) is now allowed without a fresh usage
  snapshot; a *known* exhausted 5-hour limit still blocks it, and the full
  cold-replay guard is unchanged.

## 1.15.7 (dev) - 2026-08-26

- **Claude: sign-out/sign-in now clears durable sessions**: a cached durable
  session (and any quarantined entry) references the previous OAuth
  account/org; after a subscription expiry + renewal the resumed session
  failed with `oauth_org_not_allowed` and was quarantined in memory, making
  every further request in that chat fail with "Claude durable session is
  quarantined". Sign-out (and sign-in) now drop durable sessions + pending
  rollover from memory and workspace state, so the next turn starts a fresh
  SDK session.

## 1.15.6 (dev) - 2026-08-25

- **DeepSeek vision-exp images enabled**: `deepseek-v4-flash-vision-exp` is
  now advertised as image-capable (OpenAI `image_url` blocks, base64 or URL)
  — verified against the official Vision guide 2026-08-25
  (https://api-docs.deepseek.com/guides/vision). Other DeepSeek models remain
  text-only.
- **Quick Access dedup**: the Codex «Subscription Window» item is removed —
  the two explicit limit items («Session Limit (5h)» / «Weekly Limit») already
  show the same data; «Usage Limit» stays as endpoint-unavailable fallback.

## 1.15.5 (dev) - 2026-08-25

- **Codex shows both subscription windows**: Quick Access renders the primary
  (5-hour) and secondary (weekly) limits as separate items — «Session Limit
  (5h)» and «Weekly Limit» — with percent used and reset time each, from the
  official codex rate-limits endpoint (`summarizeCodexRateLimits`). The
  fallback «Usage Limit» item remains when the endpoint has no data.

## 1.15.4 (dev) - 2026-08-25

- **Codex 5-hour limit is shown again**: Quick Access now labels the Codex
  subscription item «Session Limit» and renders the real rate-limit window
  from the official endpoint (`5h · 42% used · resets …`, `7d`, …) via
  `codexUsageLimitWindowLabel` — the window duration is no longer dropped from
  the description.
- **DeepSeek peak hours verified 2026-08-25** (official pricing page): peak
  windows are `01:00–04:00` and `06:00–10:00 UTC, Monday–Friday`; weekends
  are off-peak. Quick Access/Providers Manager now show weekday-aware peak
  labels and roll the next peak over the weekend to Monday (`Mon 04:00`),
  including Friday evenings.

## 1.15.3 (dev) - 2026-08-25

Memory quality guardrails — agents write cleaner entries, less noise reaches the model:

- **Store guardrails**: new memory entries are rejected above 4096 chars
  (one thought per entry; existing longer entries remain). The store tool now
  answers with the saved size (~token estimate) and warns when the entry is
  close to an existing one — update that id instead of duplicating.
- **Search output budget**: `llamacpp_search_memory` clips long entries to
  head+tail with an omitted-chars marker (pass `full: true` for exact text)
  and reports `N entries, N chars (~N tokens)`; a single hit can no longer
  pull ~24K chars into agent context.
- **Pinned always visible**: pinned entries are injected into the prompt even
  when the current query shares no terms (capped at half the memory budget so
  relevant entries still win the rest).
- **Memory Health**: `llamacpp.memoryHealth` command + Quick Access entry —
  reports entry count, pinned/expired, total tokens, average/entry, the five
  longest entries and duplicate candidates (similarity ≥ 80%), then opens the
  memory panel.
- **Agent instructions** (AGENT-INSTRUCTIONS.md + copilot-instructions.md +
  customSystemPrompt): entry format (1–3 lines, <750 chars typical), write
  budget (max 2–3 entries per task), respect tool feedback, run Memory Health
  before long sessions.

## 1.15.2 (dev) - 2026-08-23

Claude cross-provider context recovery:

- **Full replay after a stale durable Claude session**: an invalid
  `resumeSessionAt` previously forced `latest-user` recovery immediately, so
  switching from Codex/ChatGPT could leave Claude with only the current
  request. Recovery now attempts the current VS Code transcript first when the
  conservative estimate and fresh usage guard allow it; latest-only remains
  the bounded fallback for oversized or unsafe replays.
- **Replay budget**: the safe estimated-input default is raised from 64K to
  256K tokens, which covers the reported ~117K context while retaining the
  existing 2x safety estimate and usage checks.
- **Bounded reasoning tail in compaction**: DeepSeek requires
  `reasoning_content` of every intermediate assistant message to be passed
  back while tools are enabled, so stale chain-of-thought accumulated across
  agent turns (measured: ~135K chars ≈ 34K tokens surviving a single
  compaction). Compaction now folds extra reasoning-heavy turns into the
  summary beyond `llamacpp.compactMaxReasoningChars` (default 24K chars,
  0 disables); retained turns keep their reasoning verbatim, so the API
  requirement still holds. `chat.messages.auto_compact` logs
  `reasoningCharsAfter` / `reasoningMsgCountAfter`.
- **Quick Access fix**: `llamacpp.toggleDeepSeekCompactionSummary` was shown in
  the DeepSeek group and in the API provider page but never registered; the
  toggle now updates `llamacpp.deepSeekCompactionSummary` from both places.

## 1.15.0 (stable) - 2026-08-19

Stable release consolidating the 1.14.x development patches:

- **Context ceiling enforcement** (1.14.39): selectContextCompaction now
  force-compacts when the message context exceeds 90% of the configured
  context window, independent of llamacpp.autoCompact. Previously, with
  autoCompact=false (the default and the Configure DeepSeek preset) and a
  ~1M-context model that never rejects oversized prompts, the context
  grew past llamacpp.deepSeekContextLength. The decision now carries a
  reason ("auto" / "force" / "overflow" / "manual"), logged as
  "force-compact" ("Conversation summary (context limit reached)").
- **Cloudflare cache diagnostics** (1.14.36-38): x-session-affinity
  restores prompt-cache hits; partial-miss wording corrected (Cloudflare
  responses carry no CloudFront route telemetry); provider-kind labels
  for sessions; README caveat about per-instance prefix caching.
- **Provider management + Quick Access** (README): provider add/edit/
  remove, balance and turn counts, model catalog, Agents Window BYOK.
- **Tests**: 459 extension-host tests, VS Code 1.131 pinned.

## 1.14.39 (dev) - 2026-08-19

Enforced context ceiling at 90% of the configured limit:

- **Problem**: with llamacpp.autoCompact=false (the default and the
  Configure DeepSeek preset), the context grew past the configured
  llamacpp.deepSeekContextLength because proactive compaction was off and
  the server (a ~1M-context model) never rejected the oversized prompt,
  so the overflow-retry path also never fired.
- **Fix**: selectContextCompaction now force-compacts whenever the
  message context exceeds 90% of the model context window
  (FORCE_COMPACTION_CONTEXT_RATIO), independent of autoCompact. The
  decision carries a reason ("auto" / "force" / "overflow" / "manual")
  and the force case is logged/compacted as "force-compact" with the
  label "Conversation summary (context limit reached)".
- **Tests**: force-trigger and 90%-threshold budget coverage
  (459 extension-host tests total).

## 1.14.38 (dev) - 2026-08-19

Diagnostic wording fix for Cloudflare:

- The Cloudflare partial-miss detail no longer claims a CloudFront route
  was involved: Cloudflare responses carry no via/x-amz-cf-pop telemetry
  (the old text was a DeepSeek-specific fallback that fired when both
  route values were absent). The text now states the miss occurred
  inside Cloudflare's model-serving tier.

## 1.14.37 (dev) - 2026-08-19

Cloudflare cache alternation: diagnostics + providerKind labels:

- Log analysis of the reported misses shows the x-session-affinity header
  is present and byte-stable on every request (hit and miss turns alike),
  with stable tools/system/messages — the alternation (hit → 100% miss →
  hit) is Cloudflare-side: prefix caching is per model instance and the
  affinity pin is best-effort, so requests land on different instances.
  The partial-miss note now explains this instead of implying a client
  bug.
- providerKind in turn reports is now "cloudflare" / "openrouter"
  (previously every non-DeepSeek HTTP source was labeled "local").
- **Tests**: updated cloudflare diagnostic assertions (458
  extension-host tests total).

## 1.14.36 (dev) - 2026-08-19

Cloudflare prompt cache: x-session-affinity + diagnostics:

- **Problem**: chats through a Cloudflare Workers AI profile (e.g.
  @cf/deepseek-ai/deepseek-v4-pro-0813) showed ~100% upstream cache
  misses every turn even with a byte-stable prefix and seconds-long
  gaps.
- **Cause** (verified against the official docs): Workers AI prefix
  caching only works when the request routes to the same model instance
  that computed the prefix, and it is enabled per model. Requests
  without pinning can land on different instances, losing the cached
  tensors.
- **Fix**: chat requests to api.cloudflare.com now send
  x-session-affinity: llama-vscode-chat-{conversationId} (per
  conversation, stable across turns). Diagnostics classify Cloudflare
  sources as provider "cloudflare" and the partial-miss detail explains
  the instance-pinning and per-model support requirements.
- **Tests**: affinity value, cloudflare diagnostic note (458
  extension-host tests total).

## 1.14.35 (dev) - 2026-08-19

API providers in Quick Access + balance:

- Enabled API providers now appear as their own Quick Access roots
  (Cloud, OpenRouter, ...) with Source, Balance, Maximum Context and a
  shortcut to the Providers Manager. Disabled providers stay hidden.
- **Balance**: OpenRouter reads GET /api/v1/credits (fallback
  /api/v1/auth/key) and shows remaining credits / usage, cached 60s and
  invalidated on key change. Cloudflare Workers AI has no public balance
  API, so it honestly shows "n/a" with a dashboard pointer instead of a
  fake number. Other hosts get no balance row.
- Wiring: ApiProviderService.quickAccessApiProviders() feeds the tree;
  balance cache lives in the service (src/api-providers/balance.ts).
- **Tests**: balance parsing (credits/free tier/fallback/cloudflare) and
  Quick Access root building (456 extension-host tests total).

## 1.14.34 (dev) - 2026-08-19

Cloudflare model names + delete feedback:

- **Model ids**: Cloudflare models/search items carry a uuid in id and the
  canonical model name in name (@cf/...). The catalog now prefers the
  canonical name (pickModelCatalogId), so the model picker shows readable
  ids that actually work in chat requests.
- **Delete**: dismissing the delete confirmation now reports "Deletion
  cancelled." instead of silently doing nothing; E2E coverage for deleting
  one of two profiles.
- **Tests**: catalog id selection + two-profile delete (449
  extension-host tests total).

## 1.14.33 (dev) - 2026-08-19

Cloudflare 401 hint: paste the full token:

- The 401 hint now mentions that the FULL token value must be pasted
  including its prefix (e.g. cfut_...) — Cloudflare rejects the bare
  secret part with code 10000 even though the token itself is valid and
  active (verified against the live API).

## 1.14.32 (dev) - 2026-08-19

Cloudflare 401 diagnostics:

- When a Cloudflare Workers AI probe is rejected with HTTP 401/403 the
  provider status now appends an actionable hint (use a Cloudflare API
  token with Account > Workers AI > Read for the same account; make sure
  it is not expired), so the cause is visible right in the manager
  instead of a bare "Authentication error".
- **Tests**: 401 hint regression case (448 extension-host tests total).

## 1.14.31 (dev) - 2026-08-19

Cloudflare account id field fix + delete regression coverage:

- **Bug**: selecting the Cloudflare preset filled the base URL but never
  revealed the Account ID field — the syncAccountField() call was lost
  from the preset change handler during earlier edits.
- **Fix**: the preset handler now toggles the account field after filling
  the URL; the field also appears when editing a profile whose URL
  contains {account_id}.
- **Delete regression coverage**: the panel test suite now drives the real
  message handler with a fake webview (createOrShow + ApiProviderService
  + ProviderDirectory): add a profile, render, delete it, and assert the
  storage is empty and the card is gone (447 extension-host tests total).

## 1.14.30 (dev) - 2026-08-19

Providers Manager webview script fix:

- **Bug**: 1.14.29 broke the generated webview script (unbalanced braces in
  the save handler after the validation changes) — a SyntaxError disabled
  every panel button (Add/Delete/Edit/Toggle did nothing).
- **Fix**: the save handler is rebuilt with balanced braces and the
  account/validation code now runs only when the form is present.
- **Regression guard**: new test suite renders the panel HTML (list view,
  new-provider form, edit form) and syntax-checks the embedded script
  (445 extension-host tests total).

## 1.14.29 (dev) - 2026-08-19

Cloudflare auth probe fix + provider form UX:

- **Probe never carried the API key**: the availability probe read
  llamacpp.apiProvider.{id} while the profile key is stored as
  llamacpp.apiProvider.{id}.apiKey — probes of custom profiles went out
  without Authorization, so Cloudflare answered 400 "Missing
  X-Auth-Key/X-Auth-Email/Authorization headers" even though the key was
  saved (chat requests were unaffected — they already used the right key).
  ProviderDirectory now resolves profile keys through the new
  getApiProfileKey option (wired to ApiProviderService.getApiKey), with a
  fallback to the correct secret key format.
- **Cloudflare Account ID field**: the Cloudflare preset URL keeps an
  {account_id} placeholder; the form shows a dedicated Account ID input
  whenever the URL contains it and substitutes the value on save.
- **Required-field validation**: Save now highlights empty/invalid fields
  (name, base URL, account id) in red and blocks the request instead of
  failing silently.
- **Stale list fix**: Delete/Toggle render the panel even while a form is
  open, so a deleted provider card never stays visible.
- **Tests**: profile probe key regression (441 extension-host tests).

## 1.14.28 (dev) - 2026-08-19

Cloudflare Workers AI works; provider presets added:

- **Cloudflare 405 fix**: the Workers AI REST API has no OpenAI-style
  GET /models route (it answers HTTP 405 "GET not supported for requested
  URI" even with a valid token — verified against the live API). The model
  catalog endpoint /ai/models/search is used instead for both the
  availability probe and the model list; the catalog response envelope
  (result key) is now parsed by fetchModels. Saved profiles are probed
  immediately (previously they waited for the 5-minute timer, showing
  "Checking").
- **Presets**: Providers Manager form starts from ready-made presets —
  OpenRouter, Cloudflare Workers AI, DeepSeek, OpenAI — filling base URL,
  API format, family, context length and showing key/notes hints per
  provider (src/api-providers/presets.ts).
- **Tests**: preset suites (440 extension-host tests total).

## 1.14.27 (dev) - 2026-08-19

Providers Manager form stability (all re-render paths closed):

- 1.14.26 guarded only the panel's internal subscriptions; the static
  refreshIfOpen() call sites in extension.ts (Claude/Codex status
  changes, directory probes) still rebuilt the whole webview and wiped
  typed form values.
- Now every external render path goes through renderUnlessEditing():
  static refreshIfOpen(), createOrShow() reveal, the handleMessage tail
  render (refreshModels/recheck/runCommand keep the form open), and the
  internal service/directory subscriptions. Opening a form (new/edit)
  renders explicitly; save/cancel render after clearing the form state.

## 1.14.26 (dev) - 2026-08-19

Cloudflare AI Gateway provider + Providers Manager form stability:

- Cloudflare AI Gateway exposes OpenAI-compatible chat under
  /v1/{account_id}/{gateway_slug}/openai/chat/completions. getOpenAiApiRoot
  now treats a trailing /openai as a complete root, so entering
  https://gateway.ai.cloudflare.com/v1/{account}/{gateway}/openai (or the
  full .../openai/chat/completions URL, which the save handler strips)
  produces the correct /chat/completions and /models endpoints. The
  Workers AI REST base https://api.cloudflare.com/client/v4/accounts/{id}/ai/v1
  already worked (verified against the official docs).
- Providers Manager no longer rebuilds the whole webview while a provider
  form is open: external status/model events (probe cycles, Claude/Codex
  status changes) were discarding typed form values. The panel now skips
  re-rendering while editing; save/cancel still render.
- Tests: Cloudflare endpoint resolution cases (436 extension-host tests).

## 1.14.25 (dev) - 2026-08-19

OpenRouter (and other gateways) provider setup fix:

- **Bug**: adding a gateway provider with the full chat endpoint
  (https://openrouter.ai/api/v1/chat/completions) produced
  ".../chat/completions/v1/models: HTTP 404" — the probe appends
  /v1/models to the stored base URL, and the stored URL already ended
  with /chat/completions.
- **Fix**: normalizeProviderBaseUrl() strips a trailing /chat/completions
  (and trailing slashes) when a provider is saved in the Providers
  Manager, so both probing and chat requests start from a clean base URL.
  The Base URL form now also explains that only the base is expected.
- **Tests**: normalizeProviderBaseUrl cases (435 extension-host tests).

## 1.14.24 (dev) - 2026-08-18

VS Code 1.133 / Copilot Chat 0.61.0 compatibility:

- **Bug**: on VS Code 1.133 the Copilot patch failed with "extension
  endpoint background compaction was not found" and the workbench terminal
  reuse patch found no initTerminal pattern, so no patch was applied and
  partial prompt-cache misses appeared.
- **Fix**: the minified variable names changed in Copilot 0.61.0
  (_/w/E -> x/k/P, truncateAt:v -> truncateAt:E) and the
  RunInTerminalTool._initTerminal tool-session parameter was renamed
  (o -> i). All affected patterns now capture the minified names instead
  of hardcoding them, so both 0.60.x and 0.61.0 bundles patch cleanly.
  Verified against the exact build a5b5009513 (VS Code 1.133.0, Copilot
  Chat 0.61.0): full copilot patch, git-repositories guard, workbench
  history bounds and terminal reuse all apply and pass syntax checks.
- **Refactor**: patchAgentHistoryCap extracted from patchCopilotBundle for
  focused shape tests.
- **Tests**: 0.61.0 and 1.133 shape regression cases (434 extension-host
  tests total).

## 1.14.23 (dev) - 2026-08-18

DeepSeek balance fix on fresh installs:

- **Bug**: after entering a DeepSeek API key on a machine without a
  configured serverUrl, the balance never appeared. The balance probe used
  the raw serverUrl setting (default http://localhost:8000) instead of the
  official DeepSeek API, so /user/balance was queried against localhost.
- **Fix**: the probe now uses api.deepseek.com unless the configured
  serverUrl is itself a DeepSeek endpoint. A primary API key is only sent
  to the balance endpoint when the primary endpoint is DeepSeek (a local
  server key is never leaked to api.deepseek.com).
- **Tests**: fresh-install URL selection and key-guard regression cases
  (431 extension-host tests total).

## 1.14.22 (dev) - 2026-08-18

Claude sign-in detection on fresh machines:

- **Bug**: the Claude provider reported "Connected" whenever a claude
  executable was found. Our extension bundles the Claude Agent SDK
  executable, so the check always succeeded — even on a machine where the
  user never signed into a Claude account.
- **Fix**: hasClaudeAccountEvidence() verifies real login evidence on disk
  (~/.claude/.credentials.json or an oauthAccount.accountUuid in
  ~/.claude.json) before the provider reports "connected". Without it the
  status is now signedOut with the "Not signed in" summary, so the UI asks
  the user to sign in instead of showing a false "Connected".
- **Tests**: temp-home regression cases (429 extension-host tests total).

## 1.14.21 (dev) - 2026-08-16

"e is not iterable" startup error fixed (foreign Copilot crash):

- **Symptom**: at VS Code startup a dialog "AI Agent Bridge hit an
  unexpected error: e is not iterable" appeared, and the error re-fired
  every ~30s in some windows.
- **Root cause**: the crash is in Copilot's own git branch service
  (Kk.init -> D8e.setItems, "for..of" over the Git extension repositories
  value, which is occasionally not an array). Our global uncaughtException
  handler runs in the same extension-host process and was reporting the
  foreign crash as our own error.
- **Fixes**: (1) a new Copilot bundle patch guards the reactive chain with
  Array.isArray (marker llama-vscode-chat:copilot-git-repositories-guard:v1,
  applied on top of the v22 patch; original backup stays valid); (2) the
  uncaughtException handler now logs foreign crashes as
  extension.uncaught_exception_foreign without showing a dialog — only our
  own stack traces produce a notice.
- **Tests**: guard patch regression tests (428 extension-host tests total).

## 1.14.20 (dev) - 2026-08-16

Cursor position report noise filter for terminal tool output:

- **Problem**: git-bash terminals periodically print stray CPR sequences
  ("[22;3R", "3R[21;5R[21;11R") when bash/readline re-queries the cursor
  position and the reply leaks into the terminal buffer. Verified that no
  VS Code bundle sends ESC[6n — the query comes from the shell itself, so
  the VS Code side cannot be patched; the noise confused agents parsing
  command output.
- **Fix**: stripTerminalControlNoise() in src/utils.ts removes CPR lines
  (with and without ESC, including chains and prompt-glued variants) from
  tool results in both the llama/DeepSeek sanitizer and the Claude tool
  result converter. Legitimate text is untouched.
- **Tests**: 8 regression cases (427 extension-host tests total).

## 1.14.19 (dev) - 2026-08-16

Idle background terminal reuse (workbench bundle patch):

- **Problem**: VS Code 1.131's RunInTerminalTool caches one foreground
  terminal per chat session, but once that terminal moves to the background
  (sync timeout or interruption) every following sync call spawns a NEW
  terminal — panels kept accumulating even with only sync calls.
- **Fix**: patch the installed workbench bundle
  (out/vs/workbench/workbench.desktop.main.js) so _initTerminal flips an
  idle background terminal (shell alive, no executing command per the rich
  CommandDetection capability) back to foreground and reuses it instead of
  creating a new one. Original behavior preserved for busy/dead terminals.
- **Controls**: llamacpp.workbenchTerminalPatchEnabled (default true,
  auto-applied on activation, test mode excluded) and the
  llamacpp.toggleWorkbenchTerminalPatch command; a backup is kept at
  workbench.desktop.main.js.llama-vscode-chat.bak.
- **Implementation**: src/byok/workbench-terminal-patch.ts + regression
  tests (426 extension-host tests total).

## 1.14.18 (dev) - 2026-08-16

Terminal reuse for DeepSeek and local models:

- **Problem**: models kept calling run_in_terminal with mode=async (or legacy
  isBackground=true) even for one-shot commands, and the VS Code host creates
  a NEW persistent terminal for every async invocation — terminal panels
  multiplied despite the tool guidance.
- **Fix**: the tool-call reliability guard now rewrites ephemeral async
  terminal calls to sync, so the host reuses the session terminal (one
  terminal per chat). Genuinely long-running processes (servers, watchers,
  daemons, tail -f, npm run dev/serve/start, docker up, etc.) keep their own
  persistent terminal.
- **Implementation**: shouldKeepTerminalAsync() + repairEphemeralAsyncTerminal()
  in src/tools/tool-call-reliability.ts; regression tests (421 extension-host
  tests total).

## 1.14.17 (dev) - 2026-08-15

- **Default raised**: llamacpp.claudeMaxCumulativeInputTokens 2,000,000 →
  10,000,000. The 2M default tripped on long normal agent flows (118 model
  segments in one outer turn): the circuit breaker killed the turn mid-work,
  VS Code restored the session, and the model burned quota re-discovering
  context. 10M matches long multi-tool sessions while still capping runaway
  turns (validation max is 50M).

## 1.14.16 (dev) - 2026-08-15

Memory section in Quick Access is now workspace-aware:

- **Before**: the Memory section showed the total entry count and context
  tokens across all projects (e.g. 51 entries), even though only global plus
  the current workspace's entries participate in that workspace's prompt
  context.
- **After**: the count and token estimate now include only the entries
  visible in the current workspace (global + workspace entries whose scopeId
  matches the open folders). When other projects' entries are hidden, the
  description shows the total, e.g. "14 entries (of 51)".
- **Implementation**: new filterEntriesVisibleInWorkspace() in
  src/memory/scope.ts; Quick Access gained a getTotalMemoryCount callback;
  "Clear All Entries" stays available while hidden entries exist.
- **Tests**: workspace-filter regression tests + a Quick Access description
  test (419 extension-host tests total).

## 1.14.15 (dev) - 2026-08-15

Claude recovery fix (production failure on 2026-08-15):

- **Bug**: after a durable session was quarantined (invalid_resume_boundary),
  the bounded latest-message recovery was rejected with "Estimated replay
  178720 tokens exceeds safe limit 64000" and the turn failed. In the Agents
  Window the last user message can carry the whole transcript, so the
  latest-only input could be larger than the replay guard.
- **Fix**: the latest-only recovery now truncates oversized user content to
  the configured resume-fallback token budget, keeping the fresh tail of the
  message (the actual question) and dropping the stale head. The fallback
  decision then uses the truncated estimate, so the turn proceeds instead of
  failing. Logs report truncatedChars.
- **Tests**: two new regression tests for truncateLatestUserContent (417
  extension-host tests total).

## 1.14.14 (dev) - 2026-08-15

Production-readiness hardening (no Marketplace publishing planned):

- **Engines**: `engines.vscode` raised to `^1.131.0` and `engines.node`
  to `>=20` — the agent-host and Copilot Chat patches are validated only
  against 1.131, and the extension is Windows-only. README states both facts
  in the Install section.
- **CI/CD**: GitHub Actions now runs on `windows-latest` (lint + full test
  suite + VSIX build); the release workflow matches.
- **Security**: `npm audit fix` cleared 4 transitive vulnerabilities
  (hono/fast-uri/ip-address via the MCP SDK) — 0 known issues. Header
  redaction extended to api-key/x-api-key/proxy-authorization/cookie.
  `SECURITY.md` added.
- **Crash visibility**: `uncaughtException`/`unhandledRejection` handlers
  log to the extension journal and surface a one-time warning instead of
  failing silently.
- **Community**: CONTRIBUTING.md, CODE_OF_CONDUCT.md, Dependabot (npm +
  actions, weekly), issue and PR templates.
- **Package size**: .vscodeignore now strips dependency docs, tests, d.mts,
  and the repo docs/ folder from the VSIX.
- **Stricter TS**: noImplicitReturns, noFallthroughCasesInSwitch,
  noUnusedParameters enabled (one dead parameter removed).
- **Repo hygiene**: removed qwen_promt_reslut.md and
  docs/TEMP_CLAUDE_CACHE_PRIORITY_PLAN.md.

## 1.14.13 (dev) - 2026-08-15

- **Removed the Agents Bridge HTTP proxy.** The local OpenAI-compatible
  endpoint (127.0.0.1 server, API key in SecretStorage, custom-endpoint
  flow) proved unnecessary: models registered by the extension's own
  language-model provider reach the Agents Window directly via
  `chat.agentHost.byokModels.enabled`. Deleted
  `src/byok/agents-bridge-server.ts`,
  `src/byok/agents-bridge-file-fill.ts`,
  `src/byok/openai-message-converter.ts`,
  `src/byok/agents-bridge-agent-host.ts` and their tests; removed the
  commands `llamacpp.toggleAgentsBridge`/`copyAgentsBridgeKey`/
  `regenerateAgentsBridgeKey`/`checkAgentsPicker`, the
  `llamacpp.agentsBridgeEnabled`/`agentsBridgePort` settings, the Quick
  Access group, and the Providers Manager card.
- The BYOK flag is now enabled unconditionally at activation (it never
  overwrites a user-provided value) — except in the test runner, where the
  chat.* write would restart the test instance's agent host mid-run — and the
  agent-host thinking patch is toggled from Quick Access → Copilot Patches →
  "Thinking picker (Agents)".

## 1.14.12 (dev) - 2026-08-15

- **Fix: Agents chat crashed after picking a thinking level** ("non-streaming
  response body was not valid JSON"). VS Code 1.131's BYOK loopback proxy
  (\`ByokLmProxyService\`, 127.0.0.1 loopback in the agent host) always answers
  with \`text/event-stream\`, even when the native Copilot SDK sends a
  non-streaming request — the SDK then fails JSON parsing and retries 5 times
  (visible in extension logs as repeated turns with identical prompts). The
  agent-host patch now answers non-streaming requests with a JSON
  \`chat.completion\` (content + tool_calls + usage) and keeps SSE for
  streaming requests.
- The BYOK proxy also drops \`reasoning_effort\` from the SDK body; the patch
  forwards it as \`modelOptions.reasoningEffort\` so the thinking-level picker
  actually reaches the model (previously the model always used the
  \`llamacpp.thinkingMode\` default).
- Agent-host patch now applies three patterns idempotently (thinking-level
  schema, non-streaming JSON, reasoning-effort forwarding) with one backup and
  one restore path.

## 1.14.11 (dev) - 2026-08-15

- **Thinking-level picker for BYOK models in the Agents Window.** VS Code
  1.131 omits the `configSchema` from BYOK snapshot models, so the model
  picker has no reasoning-effort switch. New agent-host patch
  (`llamacpp.toggleAgentHostThinkingPatch` / Quick Access → Agents Bridge →
  "Thinking picker (patch)") adds a `thinkingLevel` schema
  (low/medium/high/extra-high) to the agent-host bundle with backup, syntax
  validation, status and restore — same lifecycle as the Copilot patch.
- The provider now reads `modelOptions.thinkingLevel` in addition to
  `reasoningEffort`, so the picker value reaches the model.
- DeepSeek reasoning mapping extended per official docs
  (api-docs.deepseek.com/guides/thinking_mode, 2026-08-15): "light" now maps
  to `reasoning_effort: "low"` (previously "high"); API levels are
  low/high/max with medium/xhigh as aliases of high.

## 1.14.10 (dev) - 2026-08-14

- **Request status in bridge logs.** Every request handled by the Agents
  Bridge is now logged with its HTTP status (`byok.bridge.request`), so
  "Invalid API key" (401) and model-not-found (404) failures from the Agents
  Window are diagnosable without guessing.

## 1.14.9 (dev) - 2026-08-14

- **Agent-host contract tests + picker diagnostic.** Tests now reproduce the
  "only Auto in the picker" bug at its real layer: VS Code 1.131 maps
  `chat.agentHost.byokModels.enabled` into the agent-host env
  `VSCODE_AGENT_HOST_BYOK_MODELS_ENABLED` only at spawn time, and window
  reloads never respawn the process. A flag enabled after the first spawn
  keeps the picker on Auto until the agent host is restarted.
- New Quick Access item `Agents Bridge → Check model picker`
  (`llamacpp.checkAgentsPicker`) diagnoses the flag/env contract and tells
  whether a restart of the agent-host process is required.

## 1.14.8 (dev) - 2026-08-14

- **"Add custom endpoint → paste key → done" now works.** VS Code 1.131's
  Add UI writes a blank template into `chatLanguageModels.json` and opens it
  for manual editing (it never asks for a URL, so discovery never runs). The
  extension now watches that file and fills the empty Custom Endpoint group
  with the bridge catalog automatically — just close the editor tab.
- Added file-fill tests (empty template, user-filled groups untouched, other
  vendors untouched, empty catalog, and a real file-watcher test).

## 1.14.7 (dev) - 2026-08-14

- **Agents Window chat fixed.** The model picker sends the qualified model
  identifier (`customendpoint/<group>/<modelId>`) in chat requests; the
  bridge rejected it with 404. The model lookup now accepts any path-shaped
  alias whose last segment matches a catalog model id.
- Added Agents Window integration tests: discovery via `GET /models` (the
  add-source step) and chat via both the picker identifier and the plain model
  id, covering the SSE contract (`data: [DONE]`).

## 1.14.6 (dev) - 2026-08-14

- **No more empty model count at startup.** The Agents Bridge now retries the
  model catalog fill until providers have registered their models (up to 6
  attempts, 1.5 s apart — the startup race where the bridge came up before
  `llamacpp` providers is gone). Quick Access and Providers Manager refresh
  automatically once the catalog is ready.
- Catalog changes in VS Code chat models trigger an immediate refetch
  (`refreshCatalogNow`), and the bridge logs `catalog_ready` /
  `catalog_empty` events for diagnostics.

## 1.14.5 (dev) - 2026-08-14

- **Agents Bridge out of the box.** The extension now enables the VS Code
  experimental flag `chat.agentHost.byokModels.enabled` automatically when
  the bridge is turned on (a user-provided value is never overwritten), so
  BYOK models appear in the Agents Window model picker without manual setup.
- **Live model count.** The bridge fills its model catalog right at startup
  instead of waiting for the first discovery request, so Quick Access and
  Providers Manager show the real model count as soon as the bridge starts.
  The catalog refreshes when VS Code chat models change.

## 1.14.4 (dev) - 2026-08-14

- **Agents Bridge — all models in the VS Code Agents Window.** The extension
  can now run a local OpenAI-compatible endpoint on 127.0.0.1 (default port
  17811) protected by a locally generated API key. Add it as a custom
  endpoint in the Agents Window (Copilot BYOK) and the whole catalog —
  Local, DeepSeek, Codex, Claude, and custom API profiles — becomes
  available there.
- **One converter for every source.** Requests from the Agents Window are
  translated into vscode.lm calls against our composite provider, so
  subscriptions (Codex/Claude), limits, reasoning, and tool calling behave
  exactly as they do in the regular chat.
- **Toggle-driven, key in Quick Access.** Enable via Quick Access
  ("Agents Bridge" group) or Providers Manager; while running, the group
  shows the endpoint URL and the API key (click to copy). Regenerate the
  key anytime. The bridge restores automatically after a window reload if
  it was left on.
- GET /models lists every advertised model with token limits and tool/vision
  capabilities; POST /chat/completions supports SSE streaming, tool calls,
  reasoning_content, and non-streaming responses.

## 1.14.3 (stable) - 2026-08-14

Centralized provider management: one Providers Manager for every source
(Local, DeepSeek, Codex, Claude, custom APIs), dynamic Quick Access that
hides offline providers, and per-provider availability reasons.

- **Providers Manager (Phase 2) — full control surface.** The webview now
  manages every source, not just custom API profiles. Built-in provider cards
  (Local LLM, DeepSeek, Codex, Claude) show live status from the provider
  directory plus controls for each source: enable/disable, endpoint, API key,
  context sliders, sign-in, and account status. DeepSeek cards include balance
  and peak-hours billing; Codex and Claude cards show subscription usage and
  limits.
- **Actions run through existing VS Code commands.** Every button posts a
  command id back to the panel, which executes the registered
  `llamacpp.*` command (non-`llamacpp.*` ids are rejected). Toggle/sign-in
  commands reuse the same handlers as Quick Access, so behavior stays
  identical.
- **Provider manager stays live.** It re-renders on directory and
  subscription-status changes and on the 60-second usage-limit timer, so
  balance, usage percent, and limits stay current while the panel is open.

## 1.14.2 (dev) - 2026-08-14

- **Providers Manager (Phase 1).** A new `ProviderDirectory` service holds one
  status model for every source: Local LLM, DeepSeek, Codex, Claude, and custom
  API profiles. HTTP sources are probed with a lightweight GET /models every
  5 minutes; subscription states come from the providers' own periodic refresh.
- **Quick Access is dynamic.** A provider that is enabled but unreachable
  disappears from Quick Access and reappears as soon as the probe reports it
  online again. Disabled and unconfigured sources stay visible as before.
- **Manage API Providers renamed to Providers Manager.** The webview now shows
  availability and the offline reason for every provider next to the custom
  API profiles, with a manual "Recheck availability" button.
- API profile changes now also update the Quick Access "Providers" group
  (configured/active counts were not wired into the tree before).

## 1.14.1 (stable) - 2026-08-14

Hotfix for the 1.14.0 storefront release: "Manage API Providers" was
advertised in the README and Quick Access, but the command was never
registered — the button did nothing.

- **Manage API Providers now works.** The `llamacpp.openApiProviders` command was
  declared in `package.json` and referenced by Quick Access, but never
  registered in the extension host — the button silently did nothing. The
  command now opens the API Provider Manager panel, and the provider service
  is wired into model discovery (`getApiModelSources`), so saved profiles
  appear in the model picker. Toggling, saving, or deleting a profile
  refreshes the model catalog automatically.

## 1.14.0 (stable) - 2026-08-14

Consolidates dev patches 1.13.1–1.13.3 and the repository storefront.

- **Claude follow-up messages reach the resumed session.** A new user message
  sent while a tool chain runs ("stop", "switch task") is now forwarded to the
  SDK right after the tool results; previously only tool results were sent and
  the model kept executing the old chain. `claude.chat.tool_resumed` logs
  `followUpTextPresent`/`followUpTextPreview` for observability.
- **Active-turn timeout raised to 300 s with a pending-tool guard.** The timer
  now extends while any delegated tool is in flight instead of failing during
  long tool executions; dead SDK streams still fail after 300 s.
- **DeepSeek peak hours in Quick Access (local time).** DeepSeek switches to
  peak/off-peak billing on Aug 16 2026, 16:00 UTC (peak = 01:00–04:00 and
  06:00–10:00 UTC, price ×2; off-peak = half). The DeepSeek group shows the
  current window and next transition in local time and turns orange during
  peak hours.
- **Storefront**: README showcase (logo, screenshots, architecture diagram,
  install, comparison, measured 99.3% DeepSeek cache hit), GitHub description
  and topics, social preview, restored activity-bar icon.

## 1.13.3 (dev) - 2026-08-13

- **DeepSeek peak hours in Quick Access (local time)**: from 16:00 UTC on
  Aug 16 2026 DeepSeek switches to peak/off-peak billing with off-peak at half
  the peak rate (official pricing page: peak = 01:00–04:00 and 06:00–10:00
  UTC). The DeepSeek group now shows a `Peak Hours` row with the current
  billing state and the next transition in local time; while peak is active
  the group icon and row turn orange (`charts.orange`) and the headline shows
  `PEAK 2×`, fading back automatically once the window ends (the Quick Access
  tree already refreshes every minute). Includes the effective date before
  Aug 16, both peak windows as local clock labels, and v4-pro peak rates in
  the tooltip. Pure logic lives in `src/deepseek-peak-hours.ts` with
  regression tests for window boundaries, the switchover instant, and the
  next-transition wrap-around.

## 1.13.2 (dev) - 2026-08-12

- **Claude now receives the user's brand-new messages during a running tool
  chain**. VS Code folds a follow-up message ("stop", "switch to the tower 3D
  task") into the same continuation request that carries tool results; the
  provider only forwarded the tool results, so the model kept executing the
  old chain for minutes without ever seeing the new instruction. The
  continuation now extracts the trailing user text and pushes it to the SDK
  as a fresh user message right after the tool results, and
  `claude.chat.tool_resumed` logs `followUpTextPresent`/`followUpTextPreview`
  so delivery is observable.

## 1.13.1 (dev) - 2026-08-12

- **Claude watchdog no longer mistakes a slow Opus xhigh turn for a hang**: the
  live report for chat `1f864b98` showed a warm restored session that executed
  four tools (4.2 minutes of tool time) and still died with "Claude produced no
  activity for 90 seconds". The model can legitimately stay silent for minutes
  while it reasons (`xhigh`, ~110s to first token was measured) and while VS
  Code runs delegated tools. The activity watchdog is raised from 90 to 300
  seconds and is now paused while any delegated tool is in flight
  (`pendingTools` guard), so long `run_in_terminal`/`view_image` steps cannot
  trip it. Hang detection still works: a truly dead SDK stream fails the turn
  after the same 300s window.

## 1.13.0 (stable) - 2026-08-12

Hotfix release on top of 1.12.0. Two integration breakages are fixed and
verified end-to-end:

- **Claude durable checkpoints now advance only after a successful logical
  turn**. The Agent SDK emits thinking, text, and tool-use fragments as
  separate assistant records; the previous implementation treated the next
  fragment as proof that the prior one was complete. This persisted malformed
  `stop_reason: tool_use` boundaries and made restored sessions initialize but
  produce no stream activity until the 90-second timeout.
- **Durable resume boundaries are validated from the SDK transcript before any
  model request**. Missing, non-assistant, and incomplete tool-use boundaries
  are quarantined immediately, preventing a known-bad session from consuming a
  second retry.
- **Failed resumes remain persistently quarantined until a successful recovery
  replaces them**. If a full replay exceeds the configured 64K safety limit,
  Claude starts a fresh session with only the latest user message, but only
  after a conservative 2x cost estimate (including 8K SDK overhead) and a
  fresh five-hour-usage check pass. If even that bounded recovery is unsafe,
  the request fails before contacting the model instead of silently spending
  the remaining allowance.
- **Codex vision inputs no longer accept silently truncated images**: the
  failing Luna request contained a base64 PNG that decoded successfully but
  was the first 1,080 bytes of a 1,100-byte file, missing the final `IEND`
  chunk. Codex replaced it with `image content omitted because it could not
  be processed`. Data URIs are now checked for format-specific end markers
  instead of mere base64 decodability.
- **Local screenshots use the native app-server `localImage` input** instead
  of being converted back into large data URIs. When an inline image is
  truncated, the provider can recover it from an exact byte-prefix match in
  `%TEMP%` and logs `codex.prompt_image.recovered`; unrelated files cannot
  match. Prompt image paths also resolve through git-bash aliases
  (`/tmp/x.png`, `C:/tmp/x.png`, `/d/GitHub/x.png`).
- No-activity timeouts are classified correctly as resume timeouts in live
  diagnostics. Regression coverage: 389 tests, including fragmented
  checkpoints, malformed boundaries, quarantine selection, conservative cost
  estimates, and the observed `no activity for 90 seconds` failure.

## 1.12.5 (dev) - 2026-08-12

- **Claude durable checkpoints now advance only after a successful logical
  turn**. The Agent SDK emits thinking, text, and tool-use fragments as
  separate assistant records; the previous implementation treated the next
  fragment as proof that the prior one was complete. This persisted malformed
  `stop_reason: tool_use` boundaries and made restored sessions initialize but
  produce no stream activity until the 90-second timeout.
- **Durable resume boundaries are validated from the SDK transcript before any
  model request**. Missing, non-assistant, and incomplete tool-use boundaries
  are quarantined immediately, preventing a known-bad session from consuming a
  second retry.
- **Failed resumes remain persistently quarantined until a successful recovery
  replaces them**. If a full replay exceeds the configured 64K safety limit,
  Claude starts a fresh session with only the latest user message, but only
  after a conservative 2x cost estimate (including 8K SDK overhead) and a
  fresh five-hour-usage check pass. If even that bounded recovery is unsafe,
  the request fails before contacting the model instead of silently spending
  the remaining allowance.
- **No-activity timeouts are classified correctly** as resume timeouts in live
  diagnostics. Regression tests cover fragmented checkpoints, malformed
  boundaries, quarantine selection, conservative cost estimates, and the
  observed `no activity for 90 seconds` failure.

## 1.12.4 (dev) - 2026-08-11

- **Codex vision inputs no longer accept silently truncated images**: the
  failing Luna request contained a base64 PNG that decoded successfully but
  was the first 1,080 bytes of a 1,100-byte file, missing the final `IEND`
  chunk. Codex therefore replaced it with `image content omitted because it
  could not be processed`. Data URIs are now checked for format-specific end
  markers instead of mere base64 decodability.
- **Local screenshots use the native app-server `localImage` input** instead
  of being converted back into large data URIs. When an inline image is
  truncated, the provider can recover it from an exact byte-prefix match in
  `%TEMP%` and logs `codex.prompt_image.recovered`; unrelated files cannot
  match. PNG/JPEG/GIF/WebP completeness and filesystem recovery have
  regression coverage.

## 1.12.3 (dev) - 2026-08-11

- **Prompt image paths resolve through git-bash aliases**: agents commonly
  write paths the way git-bash renders them (`/tmp/x.png`, `C:/tmp/x.png`,
  `/d/GitHub/x.png`) while the file lives in the OS temp directory or a
  drive root. The provider now tries the literal path first, then the
  msys-drive and temp-directory variants, and logs `codex.prompt_image.
  resolved` when an alias was used. Wrapped (multi-line) base64 data URIs
  are reassembled, and every data URI is validated (decodable, ≤20MB)
  before attachment.
- **Prompt diagnostics**: `codex.chat.start` now logs `promptPreview` (first
  240 chars of the latest user message) and `promptImageDataUriValidCount`
  so a vision subagent that still reports no images can be traced to the
  exact prompt text and image sources.

## 1.12.2 (dev) - 2026-08-11

- **Prompt image attachment is more robust and self-diagnosing**: recognized
  path formats now include backticked paths, `@path` mentions, Obsidian
  `![[path]]` embeds, trailing punctuation, and inline `data:image/...;
  base64` URIs (attached directly instead of being left as opaque text).
  `codex.chat.start` logs the exact `promptImagePaths`, every skip reason
  (`promptImageSkips`: missing/unreadable/too-large/unsupported), and
  `codex.prompt_image.skip` events for read failures — so a vision subagent
  that still reports no images can be traced to the exact path that did not
  resolve.

## 1.12.1 (dev) - 2026-08-11

- **Codex subagents can now see images referenced in their prompt**: VS Code
  does not deliver file attachments into subagent requests (the child gets
  only the parent agent's text), so a vision model could not look at
  rendered screenshots. The provider now scans the latest user message for
  image paths — markdown destinations, `file://` URLs, quoted and bare
  Windows/Unix paths — loads up to 8 existing files (≤20MB each, png/jpg/
  webp/gif) and attaches them as data-URL image blocks to the Codex turn.
  Missing or oversized files are skipped silently; `codex.chat.start` logs
  `promptImageCount`/`promptImageLoadedCount`.

## 1.12.0 (stable) - 2026-08-11

Stability release: Claude context safety that stops cold replays and
rate-limit burns, provider-owned compaction with semantic summaries,
centralized API profiles, and a lighter Live Report. 15 dev patches
(1.11.1-1.11.15) after stable 1.11.0.

### Key improvements

- **Claude context safety (no more rate-limit burns)**: the durable session
  restore now matches on the exact conversation id alone, so a mid-turn
  notification, retry, or rewritten transcript can no longer fall through to
  a full cold replay of the entire chat (563K fresh input tokens in one
  request was measured before the fix). New user text always lands as a
  distinct user message — never as an orphan tool result — and the persisted
  checkpoint advances through long tool chains, so stop/restart mid-turn
  resumes the fresh session instead of a days-old one.
- **Provider-owned Compact Conversation**: the native context-usage Compact
  button now routes to the extension for contributed models. Recovery runs
  below the automatic threshold with a configurable 25-90% retained target,
  cleans poisoned/looped context, persists a new snapshot immediately, and
  survives `Developer: Reload Window`.
- **Opt-in semantic summaries**: `deepseek-v4-flash` can merge the previous
  summary with newly dropped turns into a structured engineering handoff
  (objective, completed work, decisions, files, verification, failed
  approaches, constraints, open work) — disabled by default, controlled from
  Quick Access, with safe fallback to the deterministic summary.
- **Centralized API Provider Manager**: any number of OpenAI-compatible API
  profiles with per-profile model catalogs in the shared VS Code picker;
  credentials live only in SecretStorage and never return to the UI.
- **Long-running agent flows are uninterrupted**: the cross-request
  tool-density guard that forced "pause and summarize" was removed;
  real repeated-call loops are still stopped, and a streaming reasoning
  loop guard cuts multi-kilobyte thinking repetition before it burns the
  output budget.
- **Memory manager UI restored**: Shared Memory in Quick Access again shows
  its context-token footprint; the memory panel with global/workspace scopes
  is back and refreshes live.
- **Live Report is light**: the Performance sparkline is dynamic (bars
  stretch to fill the track, up to 80 pauses) and the webview now renders
  only the active tab, skips unchanged keep-alive payloads, and coalesces
  update bursts to at most one render per second.
- **Tests**: 380 passing, pinned to VS Code 1.131 (copilot-patch patterns
  are incompatible with 1.132+).

---

## 1.11.15 (dev) - 2026-08-11

- **Live Report webview renders much less often**: live updates now render
  only the active tab (the other three tabs are built lazily on switch), skip
  renders when the payload is unchanged (keep-alive pings), and coalesce
  bursts of updates to at most one render per second with the freshest data.
  Previously every turn event rebuilt all four tabs and the whole DOM from
  scratch.

## 1.11.14 (dev) - 2026-08-11

- **Memory UI restored in the quick access view and command palette**: the
  Shared Memory entry again shows the approximate context tokens the memory
  consumes, `llamacpp.openMemory` reopens the memory manager panel with
  global/workspace scopes, and the panel refreshes on memory changes.
- **Performance tab sparkline is dynamic**: the recent-gaps bars now stretch
  to fill the track (up to 80 pauses, each bar 2–26px) instead of leaving
  the right half of the row empty at fixed 10px bars.

## 1.11.13 (dev) - 2026-08-10

- **Claude durable restore no longer requires conversation progress**: a
  mid-turn notification, retry, or rewritten transcript resends the same
  copilot turn with a truncated message list, which failed the old
  "advancement" signature check and fell through to a full cold replay
  (563K fresh input tokens, ~503K cache writes — an instant 5h rate-limit
  burn). The persisted session is now restored on the exact conversation id
  alone; the model resumes warm from the SDK fork instead of re-sending the
  whole transcript.

## 1.11.12 (dev) - 2026-08-10

- **Claude follow-up context fix**: a stopped Claude turn could make the next
  request append an orphan tool result (a JSON blob) as the "latest user
  message" when the durable session was restored after an interruption, so
  the model answered the previous task instead of the new one. The latest
  user message now skips trailing tool-result-only messages and always
  carries the user's real text.
- **Claude durable checkpoints advance through tool chains**: the persisted
  resume point now follows long multi-round agent turns instead of staying
  at the last clean turn, so a stop/restart mid-chain restores the recent
  session (with the user's latest task) rather than a days-old checkpoint.

## 1.11.11 (dev) - 2026-08-09

- **Claude long turns restored**: the `claudeMaxAgentTurns` manifest default now matches the provider default of `0`, so the Agent SDK no longer receives an accidental `maxTurns=24` cap. The independent 2M cumulative-input circuit breaker remains enabled; users can still opt into a positive segment cap.
- **Claude diagnostic timestamps**: Session Quality now carries the Agent SDK logical-turn start time into the stored turn record, so safety-stop rows show their real time instead of `never`.
- **Regression coverage**: manifest tests pin the disabled-by-default segment cap, and diagnostics tests verify Claude ISO timestamps reach Session Quality as milliseconds.

## 1.11.10 (dev) - 2026-08-09

- **Target-faithful compaction**: automatic compaction can split an oversized user turn at complete assistant/tool transaction boundaries. A 50% retained target no longer collapses to a ~16% tail merely because one tool-heavy turn is too large to keep whole; assistant tool calls remain paired with every retained tool result.
- **Streaming reasoning loop guard**: exact multi-kilobyte repetition in private reasoning is stopped before it consumes the remaining output budget. Detection is conservative, reasoning-only, enabled by default, and configurable through `reasoningLoopProtection` and `reasoningLoopMinChars`.
- **Clean recovery retry**: after a reasoning loop, the provider cancels both processing and optional raw-log stream branches, removes historical reasoning through provider-owned recovery compaction, and retries once from a structured summary. A second loop returns a bounded stop message instead of running indefinitely.
- **Diagnostics**: Session Quality marks reasoning loops and retry counts separately from repeated tool-call loops; compaction and recovery snapshots retain only bounded summary/tail samples.
- **Regression coverage**: tests cover target fill inside one large tool turn, orphan-free tool transactions, exact/varied reasoning streams, raw SSE guard propagation, and end-to-end clean-summary retry.

## 1.11.9 (dev) - 2026-08-09

- **Reload-safe manual recovery**: AI Agent Bridge restores the most recent persisted HTTP conversation identity when the Extension Host starts. The Compact Conversation button can therefore trigger provider-owned cleanup immediately after `Developer: Reload Window`, before another request has refreshed the Copilot bridge state.

## 1.11.8 (dev) - 2026-08-09

- **Provider-owned Compact Conversation**: Copilot patch v22 routes the native context-usage Compact button to AI Agent Bridge when the active conversation uses a contributed `llamacpp` model. Other providers retain Copilot's original `/compact` behavior.
- **Immediate recovery snapshot**: manual compaction runs below the automatic threshold, uses the configured 25–90% target, invokes the optional DeepSeek semantic summary, persists the new snapshot, and returns a local confirmation without spending a main-model request.
- **Poisoned-context cleanup**: unlike automatic compaction, recovery mode keeps only its newest control turn verbatim. All prior turns cross the summary boundary, historical `reasoning_content` is removed, and long exact repetition tails serialized as assistant text are replaced with a bounded notice.
- **Safe routing**: the Copilot patch forwards the stable private conversation id to a one-shot, 60-second provider command. Unknown/stale conversations fall back to native Copilot compaction; raw conversation ids are not logged.
- **Regression coverage**: tests cover bundle routing/fallback, one-shot conversation binding, full provider flow without a main endpoint call, strict raw-tail replacement, and removal of repetitive historical reasoning.

## 1.11.7 (dev) - 2026-08-09

- **Central API Provider Manager**: Quick Access now opens a dedicated CRUD webview for any number of OpenAI-compatible API profiles. Each profile has its own name, base URL, request format, model family, context length, enabled state, and optional API key.
- **Secure centralized storage**: profile metadata is global across workspaces, while credentials are stored only in VS Code SecretStorage. Saved keys are never sent back to the webview; deleting a profile also deletes its secret.
- **Multi-account routing**: every enabled profile contributes its `/models` catalog to the shared VS Code picker. Source IDs and model/runtime caches are isolated per profile, including multiple accounts on the same gateway URL.
- **API compatibility profiles**: standard OpenAI requests omit llama.cpp-only thinking/cache fields, DeepSeek native and llama.cpp payloads remain available explicitly, and versioned base URLs such as `.../api/v1` no longer receive a duplicate `/v1` segment.
- **Compatibility**: the existing Local LLM and dedicated DeepSeek configuration remain unchanged and can be used alongside custom API profiles.

## 1.11.6 (dev) - 2026-08-09

- **AI Agent Bridge branding**: the extension display name, Activity Bar container, Settings title, Command Palette category, status bars, dialogs, output channels, and Codex client title now reflect the multi-provider product instead of the original local-only name. Compatibility identifiers (`llamacpp.*`, `mrlordcat.llama-vscode-chat`, patch markers, and VSIX basename) remain unchanged.
- **README audit**: the main documentation now identifies stable 1.11.0 and dev 1.11.6, current patch v21, 359 tests, all-provider diagnostics, semantic DeepSeek compaction, 25–90% retained targets, paid-summary boundaries, and bounded compaction diagnostic samples.
- **Repository metadata**: manifest repository, homepage, and issue URLs point to `MrLordCat/ai-agent-bridge`; user-facing command references throughout the documentation use the new `AI Agent Bridge:` prefix.

## 1.11.5 (dev) - 2026-08-09

- **Deeper context reduction**: `compactionTargetRatio` now supports 25–90% retained instead of 50–90%. Quick Access adds 25% (extreme) and 35% (very aggressive) presets; the existing 75% default is unchanged.
- **Failure-aware primary digest**: rejected hypotheses, corrected analysis mistakes, and approaches that did not solve the problem receive an independent evidence lane under input pressure. Runtime logs now expose total/selected/omitted turns, selection-reason counts, and rejected-approach coverage.
- **Less redundant, better-scoped summaries**: the Flash contract separates durable outcomes from verification evidence, forbids promoting partial checks into whole-chain proof, and requires rejected approaches to remain visible. Summary diagnostics report section sizes, empty sections, and exact duplicate lines.
- **Target-aware summary size**: semantic-summary space scales down for aggressive/small targets instead of always reserving 16K characters, while retaining a 4K handoff floor and 16K ceiling.

## 1.11.4 (dev) - 2026-08-09

- **Uninterrupted agent flow**: removed the cross-request tool-density guard that treated four tool-only turns in an eight-turn window as a stalled agent and injected `Pause, summarize...`. Productive DeepSeek/local tool workflows can now continue until the task is complete, the model reports a real blocker, or VS Code reaches its configured request limit.
- **No count-based forced reviews**: removed the fallback that disabled every tool after a fixed number of host-driven tool turns and forced a text recap. `toolLoopForceTextThreshold` remains registered only as a deprecated compatibility setting.
- **Actual-loop protection retained**: identical consecutive tool name + arguments still trigger the dedicated reliability guard. The intra-request tool-only recovery now asks for the next useful tool call and explicitly reserves final text for completion or a genuine blocker.
- **Regression coverage**: the continuation contract is tested to contain no pause, summary, review, recap, or planning trigger while preserving repeated-call protection.

## 1.11.3 (dev) - 2026-08-09

- **Higher-quality Flash compaction input**: the deterministic pre-summary now groups complete turns and reserves independent evidence lanes for the original objective, high-signal milestones, evenly spaced timeline coverage, and the recent working tail. Long conversations no longer collapse to only the first user message plus the newest events before they reach `deepseek-v4-flash`.
- **Cleaner engineering evidence**: tool calls are paired with their results and arguments, repeated narration is deduplicated, successful test/build outcomes are retained, and additional volatile VS Code blocks are omitted. English and Russian decisions, failures, verification, constraints, and requirement changes receive explicit priority.
- **Stricter semantic merge**: the Flash prompt distinguishes requested/planned work from completed and verified work, preserves unresolved failures, and applies later evidence only when it explicitly supersedes earlier status. Previous structured summaries retain every section under tight input budgets, and malformed out-of-order output falls back safely.
- **Regression coverage**: tests exercise pressured middle-history retention, Russian milestones, tool-result pairing, duplicate removal, structured-summary clipping, prompt status discipline, and section-order validation.

## 1.11.2 (dev) - 2026-08-09

- **Configurable compaction target**: `llamacpp.compactionTargetRatio` now controls how much of the current message context is retained by both proactive compaction and confirmed-overflow retries. The existing behavior remains the default at 75%; the setting is safely clamped to 50–90%.
- **Quick Access presets**: `Model Behavior → Compaction Target` offers 50%, 60%, 75%, and 85% retained. Selecting 50% compresses the current history to half its estimated token size, providing substantially more headroom at the cost of a more aggressive summary.
- **Regression coverage**: tests verify the 50% target for proactive and overflow paths, safe ratio bounds, and the Quick Access entry.

## 1.11.1 (dev) - 2026-08-09

- **Opt-in semantic compaction**: `deepseek-v4-flash` can now merge the previous summary with newly dropped turns into a structured engineering handoff (objective, completed work, decisions, files/symbols, verification, failed approaches, constraints, and open work). It uses a separate tool-free, thinking-disabled request and is disabled by default because every compaction is a paid DeepSeek API call.
- **Quick Access control**: `DeepSeek → AI Compaction Summaries` switches the paid summarizer on or off and clearly shows `On (paid)` / `Off`. API errors, missing keys, invalid output, cancellation, and timeouts automatically fall back to the deterministic local summary.
- **Compaction correctness**: repeated compaction preserves the previous summary; Shared Memory overlays, ephemeral guards, reasoning, and volatile VS Code metadata are excluded from summary input; the semantic-summary budget is reserved before the request; post-memory-injection correction keeps the final request within its target.
- **Regression coverage**: 352 passing tests, including request shape, response validation, metadata redaction, previous-summary retention, strict final budgets, and the Quick Access toggle. ESLint is clean.

## 1.11.0 (stable) - 2026-08-08

Stability release: stable context and 98%+ cache hit rate, memory management through a UI, and a full code audit. 97 dev patches (1.10.1–1.10.97) after stable 1.10.0.

### Key improvements

- **Stable context and cache (98%+ hit rate)**: snapshot-stabilized tail (the tail comes from the snapshot, new messages from the source), fixed history duplication when VS Code rewrites the transcript (`rewritten_history` detector), and reasoning-block deduplication by common prefix. Turn N+1 prompt = turn N prompt + only the new messages.
- **Unified compaction scheme**: a single soft scheme (target 0.75 × current size), truncation of heavy tool results in the tail (`compactMaxToolResultChars`), and protection against compaction between restarts.
- **Loop protection**: a working repeated-tool-call detector, cross-turn "pause and summarize" nudge, and a hard `maxModelTurnsPerRequest` limit.
- **Reasoning no longer leaks into visible text**: multi-marker thinking parser, fallback hidden when there is no ThinkingPart.
- **Shared Memory UI**: a webview memory manager instead of raw JSON — create/edit/delete entries, project filters (All/Global/This project/Other projects), per-entry context estimation, and correct workspace binding.
- **DeepSeek sliders**: Max Output and Maximum Context in quick access via the Provider Context panel.
- **Live Report**: expandable exploded view of the prompt/cache structure with stable requestId-based identity.
- **Code audit**: 8 utilities deduplicated (asRecord, clampInteger, truncate, bytesToBase64, normalizeCopilotTurnIndex, contentToText, nonNegativeInteger, formatTokenCount), dead code removed.
- **Subagent tool parity (Copilot patch)**: VS Code narrowed subagent requests to a single tool (`session_store_sql`); the Copilot bundle patch now caches the full advertised tool set from ordinary turns and restores it for subagent turns — subagents get the same tools as the calling agent (1 → 64 tools).
- **Tests**: 346 passing, pinned to VS Code 1.131 (copilot-patch patterns are incompatible with 1.132+).

---

## 1.10.1 - 1.10.97 (dev patches) - 2026-08-07

Dev fixes after stable 1.10.0 (patch-only increments).

### 1.10.97
- Shared Memory UI improved for comfortable editing of entries from different windows: cards show the human-readable project (workspace:d:/GitHub/llama.cpp-with-GUI) and an `other project` label for entries of foreign workspaces; filter chips All / Global / This project / Other projects added; editing a foreign entry shows a warning and keeps its original scopeId (the project is not rebind to the current window) — rebinding only happens on an explicit Scope change.
- Memory data: an entry with a broken scopeId `file:///d:/...` (without percent-encoding) was normalized to `file:///d%3A/...` — it is now visible in its own window.
- Removed the dead file `src/ui/health-check-panel.ts` (was not used anywhere).
- Tests: 3 new (project labels, other-project badge and filter chips, form warning). Full suite — 346 passing.

### 1.10.96
- Full code audit: deduplication and dead code. `src/utils.ts` now holds single implementations: `asRecord`, `clampInteger` (canonical argument order value/min/max/fallback), `truncate`, `bytesToBase64` (Buffer), `normalizeCopilotTurnIndex`, `contentToText`, `nonNegativeInteger`, `formatTokenCount`. Local copies removed from 12 files: app-server-client, codex-provider (truncate calls with explicit limit), rollout-metrics, turn-bridge (truncate(item.command, 240)), message-adapter, message-compaction, memory/prompt, output-budget, token-usage-history, usage-experiment, claude-provider (4 clampInteger calls rewritten — the old (value, fallback, min, max) order was a mine), ui/context-control (unified K/M token format).
- Dead code removed: the ternary with identical branches `/user/balance` in llama-provider; the unused constant `DEFAULT_CLAUDE_KEEPALIVE_MS`; the unused asRecord import in claude-provider; the duplicate btoa-based bytesToBase64 in utils; `llamacpp.autoCompact` default synchronized `true → false` (matches the code fallback and the "Disabled by default" description).
- Regression: 343 passing, eslint clean across the whole src.

### 1.10.95
- Shared Memory got a UI manager instead of raw JSON: `Local LLM: Open Shared Memory` (and the quick access item) opens a webview panel listing entries — title, kind/scope/pinned/expired badges, tags, content, token estimate and dates. Entries can be created, edited (title, content, tags, kind, scope, pinned, expiresAt) and deleted right in the panel; the `Open JSON file` button keeps access to the source file. Live refresh on memory change; delete uses the correct scope + workspace id; creating a workspace entry without an open project is blocked with an error.
- The quick access Memory section shows the estimated context footprint: `N entries / M expired · ~X tokens context` (new `getMemoryContextTokens` callback at the end of the provider constructor — positionally safe; estimate ~4 chars/token, expired excluded).
- Regression: 4 memory-manager tests (token estimate, list rendering, edit/new form, XSS escaping) + updated quick-access test. Full suite — 343 passing.

### 1.10.94
- DeepSeek got sliders in quick access: `DeepSeek → Max Output` and `DeepSeek → Maximum Context` open the Provider Context panel (`llamacpp.openContextControl`) with two new range sliders. Max output changes `deepSeekDefaultMaxOutputTokens` (1024–393216, default 70000), context — `deepSeekContextLength` (32K–1M, default 258.4K). Apply saves both values to Global; live values update while dragging.
- The `Maximum Context` quick access item now leads to the sliders instead of QuickPick presets; a `Max Output` item with the current value (`70.0K` by default) was added. `ContextControlState` extended with DeepSeek fields (target/min/max for context and max output); clamp bounds match package.json and the provider clamp.
- Regression tests: quick access expects `openContextControl` for both DeepSeek items and the `70.0K` format; `caps context control values` checks the clamp `2M → 1 048 576` and `500K → 393 216`. Full suite — 339 passing.

### 1.10.93
- Live Report got an expandable exploded view for the ordered prompt/cache structure. The `Expand block details` button shows each source segment as its own full-width row regardless of its share of the total prompt: ordinal number, category, message count, exact total/cached/miss tokens, hit%, plus its own cached/uncached scale with minimally visible narrow parts. Small Memory delta, Guard, Tool call and other blocks no longer disappear visually inside the combined bar.
- Fixed detail toggling switching to a new turn during live update. The detail row used to be named by its current newest-first position (`detail-0`, `detail-1`); after a new turn was inserted on top, the same ID belonged to a different record and restoreOpenRows expanded it. Identity is now built from the stable `requestId` (with a safe fallback), the exploded state is stored separately, and the viewport anchor compensates the inserted top row, keeping the selected turn at its previous screen position.
- UI regression verifies request-based detail identity, absence of the old positional ID, expanded segment controls/exact stats, expanded-state retention and the viewport anchor. Embedded JavaScript passes syntax validation; full suite — 339 passing.

### 1.10.92
- The public Shared Memory contract is split into two explicit scopes: `global` for durable preferences and workflows useful to all agents across projects, and `workspace` for paths, commands, architecture and decisions of the current project only. `scope` is now required on save and delete; the ambiguous default-global is gone. The agent tool no longer accepts an arbitrary `scopeId`: the current multi-root workspace id is computed by the extension, so an agent cannot write memory into a foreign project.
- Deletion is protected at the `SharedMemoryService.remove(id, context)` level: a known id alone is not enough — the stored scope and workspace must match the explicitly chosen ones. Updating a workspace entry of another project and changing legacy model-scoped entries through the public two-scope tool are also rejected. Searching without scope sees global + the current project; an explicit workspace search requires an open project.
- Legacy `model` entries remain readable for format compatibility, but new ones cannot be created through agent tools. The confirmation UI and tool results explicitly say "global" or "project". `chat.memory.context` gained `scopeCounts` so the JSONL shows the actual global/workspace entry counts in the prompt and cross-project leakage can be verified.
- Regression tests first reproduced the missing scoped-delete on 1.10.91 (TypeScript: `Expected 1 arguments, but got 2`), then verified the delete denial for another workspace, the required scope, the absent public scopeId and exactly two scopes across all three tools.

### 1.10.91
- Shared memory moved from a relocatable ephemeral block to an append-only ledger. 1.10.90 stabilized memory inside the tool loop, but on the next real user turn the same block was removed from its old position and inserted before the new user message, rewriting the whole cached assistant/tool tail even when the text was byte-identical. Now the first selection creates a provider overlay checkpoint persisted in the conversation snapshot at its original position; identical entry revisions add nothing, new and updated entries are added as a separate Memory delta before the new uncached user tail. Old checkpoints are never rewritten.
- SharedMemoryPromptContext passes individually rendered entries; the SHA-256 revision is compared by the stable entry id. An update with the same id appends a new revision explicitly superseding the old one. Overlay metadata is not sent to the API but is kept in session-state.json; snapshot alignment matches only the host projection and returns the full prefix together with the overlay. The first tool turn after a reload uses persisted-overlay-tool-turn without a new retrieval. On compaction the current checkpoint is restored inside the already intentionally rewritten region. Per-entry delta respects sharedMemoryMaxTokens.
- Live Report now has ordered promptSegments instead of the opaque Messages: System, Tool catalog, Shared memory/Memory delta, User + host context, User, Assistant, Reasoning, Tool calls, Tool results, Compaction summary, Guards/nudges and Unmeasured. Segments are mutually exclusive and sum to the local prompt estimate; server cached_tokens are projected onto them left to right. The legend aggregates categories and marks the split as estimated. The previous double-counting of System inside messageTokensAfterCompact is fixed; the turn JSON now also contains promptSegments.
- After moving memory from ephemeral to the durable overlay, the ephemeral_context_changed class no longer blames a trailing guard/nudge for losing the old prefix: guards are appended to the tail only and cannot causally explain the disappearance of previously cached tokens, so such an anomaly stays upstream_cache_partial with an explicit note.
- The user → tool → new user regression was red on 1.10.90: the third request replaced memory turn one with memory turn two. After the fix the first checkpoint stays, a new entry creates the second delta; separate tests cover unchanged/updated revisions, persistence across restart, a clean wire payload, the exclusive prompt-segment sum and Live Report. Total 337 passing.

### 1.10.90
- Fixed a locally caused DeepSeek cache miss on tool turns from changing shared memory. On live turn 34 (b81cc3ff, conversation b32eed1e) the durable history matched, but the retriever re-picked memory: 3 entries/1028 tokens became 2 entries/829 tokens and the ephemeral context changed 4368 → 3812 chars. Because the memory message sits before the last real user message, changing a few hundred characters rewrote the entire following assistant/tool tail: 16331 previously sent tokens stopped being read from cache.
- The shared-memory prompt is now selected once per real user turn and stored per conversation scope. All subsequent tool-result rounds reuse the same object and byte-identical text; the next real user turn refreshes the selection. A separate null-sentinel records the correct "memory not selected" result so a tool round does not re-run retrieval. After a reload the first encountered turn initializes the value once. The chat.memory.context event reports source=retrieved-user-turn or source=frozen-tool-turn.
- The integration regression runs three full provider requests user → tool result → new user. Before the fix the test failed with actual=memory selected for turn two instead of expected=memory selected for turn one; after the fix the tool round keeps the first block, the new user turn gets the second one, and retrieval is called exactly twice. Full suite: 335 passing.

### 1.10.89
- DeepSeek cache classification fully reworked after an audit of the original 30 and the accumulated 50 live turns of `b32eed1e`. `upstream_expired` is no longer used as an unproven catch-all for the direct DeepSeek/local API, and a CloudFront `Via`/`Cf-Pop` change is no longer claimed as the root cause: the statistics showed the same number of hit<95% with both changed and unchanged visible routes. The new neutral class `upstream_cache_partial` states only a proven fact: with a byte-stable durable prefix, a material part of the already-sent prompt stopped being read from cache. Metric: `lostPriorPrefix=max(0, previousPromptTokens-currentCachedTokens)`; material threshold — at least 2048 tokens and 4% of the previous prompt. A route change remains in the detail as a correlation, not proof of an origin/cache-shard switch.
- Separate explicit causes added: `history_rebuilt_after_restart` for the first request after the extension host starts and VS Code rebuilt the history differently from the persisted snapshot; `ephemeral_context_changed` when the durable history matched but the actually sent provider-only memory/guard messages changed; `upstream_cache_pending` for a materially unwarmed prefix right after compaction. `stabilizeMessagePrefix` now stores/compares `ephemeralHash` and `ephemeralChars` without adding ephemeral messages to the durable snapshot.
- An offline replay of the new classifier over 50 actual cache reports gave: 30 `healthy`, 12 `upstream_cache_partial`, 4 `history_summarized`, 3 `upstream_cache_pending`, 1 `history_rebuilt_after_restart`. Edge cases fixed: a normal 2–3% cache gap stays healthy; a large new tail with a small loss of the old prefix stays healthy; a 4.98% post-compaction gap no longer falls on the boundary. Six new regressions were red before the implementation; provider wiring for ephemeral telemetry is also covered. Total 334 passing.

### 1.10.88
- Fixed the classification of partial DeepSeek cache misses after an upstream route change. Turns 54 and 57 of chat `b32eed1e` were wrongly marked `healthy`: the sent prefix matched 100%, there was no compaction, yet after a CloudFront `Via`/`Cf-Pop` change 18.6K/25.9K cached tokens suddenly disappeared. The provider now stores the previous route and server `prompt_tokens` per conversation scope; the classifier separates the expected new tail from an unexplained uncached remainder and emits `upstream_route_changed` only when a route change is simultaneously proven. A POP change itself is not a problem: turn 56 with a route change and 489 uncached tokens stays `healthy`; an anomalous miss without a route change is `upstream_expired`; after compaction — `upstream_cache_pending`. Backend telemetry added to `chat.cache.report`, a badge in Live Report and three regression tests on the real numbers of turns 54/56/57; total 328 passing.

### 1.10.87
- Fixed the self-calibration of the heuristic token counter for DeepSeek that started auto-compaction too late. The formula smoothed the residual ratio `server/calibratedEstimate` as if it were the full multiplier and converged to the square root of the correct coefficient: in live turns the factor stuck at `1.295` with residual also `1.294`, while the actual raw→server multiplier was about `1.676`. The EMA now smooths `previousFactor × residualRatio`; a new `observedFactorTarget` field added to `chat.heuristic.calibrate`. The regression test converges to `1.68` and confirms the `auto` decision when crossing the soft target.
- Fixed the prefix flip-flop that caused `history_rewritten` and partial cache misses on turns 18–19 of chat `b32eed1e`. The old assistant message #255 was alternately sent with/without `reasoning_content`, because the cache-prefix snapshot stored the input host version before stabilization instead of what was actually sent. `stabilizedDurable` is now persisted in memory, on disk and in cache telemetry; `firstDivergence`, identical/shared prefix and reusable percent are also computed from the sent prompt. The regression test checks three consecutive turns without losing reasoning. Total 325 passing.

### 1.10.86
- Fixed a whole-turn crash with `ToolCallValidationError: arguments are not a valid JSON object` caught by the error tracker (`d697b601`, conversation `b32eed1e`). The turn had `toolCallRepairEnabled=true` and one repair attempt, but the model had already emitted 49 characters of text: the `roundOutputChars === 0` condition forbade the retry, so `flushToolCallBuffers` ended the turn with an error immediately. Partial text no longer blocks the bounded correction retry; the `roundToolCallParts === 0` guard is kept so an already-sent valid tool call is not executed twice.
- The correction prompt warns not to repeat the already shown text and asks to return only the fixed tool call. `chat.tools.validation_retry` events now include `roundOutputChars`/`roundToolCallParts`; cases that cannot be safely retried emit `chat.tools.validation_unrecoverable` with the reason and retry state. Regression test `retries a rejected tool call after partial text with a bounded correction prompt`: red before the fix, green after; total 323 passing.

### 1.10.85
- Fixed shared memory loss on consecutive tool turns. Memory used to be added before `findSnapshotAlignment`; since the block is inserted before the last regular user message, on a tool turn it could land before the pivot and miss `newMessages`. So `chat.memory.context` reported the same 13 entries (~3690 tokens), but the server prompt shrank `192253 → 188315`. Shared memory is now injected after building the durable context from source + conversation snapshot and is guaranteed present in every request.
- `stabilizeMessagePrefix` now aligns only durable messages and then restores the current ephemeral injections at their positions. Previously the filtered-snapshot indices were applied to the unfiltered array, so memory/guards could disappear or shift a neighboring message. `chat.messages.initial` gained `ephemeralMsgCount`, `ephemeralChars`, `sharedMemoryExpected`. Regression test `keeps live shared memory while restoring a durable snapshot prefix`; total 323 passing.

### 1.10.84
- Tail stabilization from snapshot versions (`stabilizeTailFromSnapshot`): when the host rewrites history between turns (truncates tool results, regenerates messages), the pivot rewinds and the tail used to come from the source in the REWRITTEN form — already-sent content changed, so server prompt tokens and uncached amounts "jumped" by several thousand between turns (diagnosed from logs: turn 4→5 the host deleted 4 messages user 122→118/toolResults 106→102; turn 6→7 chars −8787). Now messages recognized by call id as already sent (tool results and assistant with tool_calls) come back in their snapshot version; truly new ones (unknown call ids) stay as the host gave them. Turn N+1 content = turn N content + only new messages: the context weight is monotonic and the cache prefix does not jump. Regression test "keeps the tail stable when the host truncates messages it already sent" (322 passing).

### 1.10.83
- Reasoning weight stabilization between turns: the new `restoreReasoningFromSnapshot` (in `prepareMessagesForBudget`, before dedup) restores `reasoning_content` on assistant messages with tool calls that the host rewrote (transfer by call id from the conversation snapshot — it stores the version the message was already sent with). Previously, if the host changed the history and a call id "fell out" of the reasoning map, the thought was not restored and the context "floated" ±2–4K tokens between turns (sawtooth on long runs). Test "restores reasoning from the snapshot when the host rewrote the history" (321 passing).

### 1.10.82
- Reasoning-weight diagnostics: `chat.messages.initial` now contains `reasoningMsgCount` and `reasoningChars` (sum of `reasoning_content` chars in the sent messages). `reasoning_content` is restored by tool-call id and can "float" ±2–4K tokens between turns when the host rewrites history (call id changes/message comes from the source without thoughts) — now visible on every request. `chat.messages.snapshot_rewound` extended with `pivotIndex` and `rewoundCount` (how many messages were rewound) — you can see where the host trimmed its own tail.

### 1.10.81
- Reasoning dedup (1.10.80) moved into `prepareMessagesForBudget`: the cleanup now applies to ALL request messages, including those reused from the conversation snapshot. In 1.10.80 the strip only ran in `convertForMode` (fresh messages from VS Code), while old messages with duplicated thoughts (content=thoughts+answer) that survived a restart entered the request through `reusedSnapshot` bypassing the cleanup and were preserved in the snapshot forever (after restart: 49/53 reasoning messages still duplicated, ~130K chars ≈ 32K tokens out of 179K).

### 1.10.80
- Agent reasoning no longer duplicated in context: VS Code serializes a ThinkingPart into history as plain text (indistinguishable from a normal text part), so convertMessages put thoughts into `content` and `injectStoredReasoningContent` added the same thoughts to `reasoning_content` (a hard DeepSeek requirement on tool-call follow-ups, otherwise 400) — every turn carried reasoning twice, in long sessions up to ~38K extra tokens per request. The new `stripReasoningDuplicatesFromContent` (llama-provider.ts) cuts the prefix of `content` that matches `reasoning_content` (threshold: ≥100 chars or a full match for short ones), applied before budget counting and snapshotting. Test "strips reasoning the host already serialized into assistant content" (320 passing).

### 1.10.79
- Shared memory injection (`injectSharedMemoryContext`) is marked `ephemeral`: the memory block is live content (entries change between turns), it stays in every request but no longer enters the prefix/budget snapshots and cannot desync the cache prefix (previously, adding memory entries made the block position/text "float", causing misses).

### 1.10.78
- Force-text against host-driven loops: the VS Code host loop makes one request per tool call, so per-request limits (`maxModelTurnsPerRequest`) do not see it. The new setting `llamacpp.toolLoopForceTextThreshold` (default 12, 6-40): after N consecutive tool-call-only turns (no visible text) the next request is sent WITHOUT tools plus a stop message — the model is forced to answer with text and the loop is broken. The counter resets on a text turn. Log `chat.response.tool_force_text`. This is an escalation on top of the soft cross-turn nudge (4/8 turns).

### 1.10.77
- Window race over `session-state.json` fixed: persist now MERGES changes with the current file and writes only the scopes changed in this extension host (dirty tracking for prefix/conversation/toolCatalog snapshots). Previously any window overwrote the whole file with its own (possibly stale) copies of foreign scopes — a chat snapshot could "freeze" at an old turn, and after a reload the first turn aligned to the stale snapshot (turn 17a1cc78: snapshot 362 instead of 411 → +51 messages from source, ~46K uncached). Snapshot deletions also reach the file.

### 1.10.76
- `prefix.firstDivergence` diagnostics extended: on a prefix divergence the `chat.cache.report` log shows role, tool_call_id, callIds, reasoning presence and content length for both message versions (previous + currentMessage) — you immediately see how the host rewrote the message (text, call id or structure).

### 1.10.75
- Ephemeral injections (cross-turn nudge, loop guard, repair/continuation retry messages) no longer enter prefix and budget snapshots (`ephemeral` flag on `OpenAIChatMessage`): they exist in the sent request but are absent from host history, which used to make the snapshot tail unfindable in the source on the next turn → full cache miss (turn 50: 431K→483K, hit 2%). Snapshots filter ephemeral messages; the `snapshot_rebuilt` log now contains `reason` (alignment-not-found / rewritten-history-would-duplicate / migrated-from-prefix) and snapshot/source sizes.

### 1.10.74
- Snapshot pivot rewind (SNAPSHOT_PIVOT_MAX_REWIND=24): when the host drops its own tail (interrupted reply) on a new user message, the snapshot is no longer discarded entirely — a deeper common join point is found and the cache prefix survives. `findSnapshotAlignment` returns `{snapshotPrefix, newMessages}`; search uses precomputed `conversationMessageKey` keys with a position index (no O(n·m) normalizations). The `chat.messages.snapshot_rewound` log shows when it fired. Diagnostics: `prefix.firstDivergence {messageIndex, index, previous, current}` — the first diverging message (not only system).

### 1.10.73
- The system prompt is no longer truncated as a tool result: `truncateToolResultMessages` applies summarization only to real tool results (`role==="tool"` or user messages with the `[tool_result` marker). Previously the ~38K-char system prompt (instructions + skills + agents) collapsed into `[tool result summarized: original=38534 chars...]` → `system_prompt_changed` and a full miss on the first turn after restart.

### 1.10.72
- The false "duplicate detector" no longer discards a valid snapshot: duplication is determined by repeated `tool_call_id`s in the tail (`tailRepeatsSnapshotCalls`) instead of the length ratio. The host trims its own history window, so a snapshot longer than the source is normal, not a duplicate (previously: 405→404 messages, 0-3% hit on turns 10/11/13).

### 1.10.71
- First turn after restart: finding the snapshot/source join point now uses the common predicate `isSameConversationMessage` (tool_call_id / ids of all tool_calls / text with volatile blocks masked: `environment_info`, `workspace_info`, `context`, `attachments`, `reminderInstructions`). Previously the pivot gram required byte equality — after a restart the host re-rendered the history, the snapshot was discarded and the full history went out (387 msg instead of 316) → 1% miss.

### 1.10.70
- Prefix stabilization rewritten to positional alignment: a message is replaced by the previously sent version when bytes match OR tool_call_id / ids of all tool_calls match OR the text is equal after masking the host's volatile blocks. Previously the "bytes" strategy reused only N byte-matching messages (3 of 875 → 1.8% hit) and the "aggressive" branch could lose a fresh user turn. The last message is never replaced. New field `restoredCount` in `chat.cache.prefix_stabilized`.

### 1.10.69
- Fix for the "first turn after restart": history used to inflate (324 → 778 messages) with a cache miss from losing the pivot when VS Code rebuilt the history. Pivot search now uses a K-gram (3 consecutive snapshot tail messages, SNAPSHOT_PIVOT_GRAM=3) — resilient to 1-2 changed tail messages.
- DeepSeek max output: `deepSeekDefaultMaxOutputTokens` 131072 → 70000 (reasoning counts into output tokens; caps "endless thoughts" in one turn, lowers loop risk and cost).

### 1.10.68
- Fix for the Live Report context "chaos" (jumps 122K→178K→167K→141K→174K with autoCompacted:false): when VS Code rewrites already-sent messages (history_rewritten), the snapshot logic no longer duplicates the history tail — if snapshot+newMessages is longer than the full source, the snapshot is declared stale (reason=rewritten_history_would_duplicate) and the full source is sent. The cache prefix is stable: 4.5% miss → ~95%.

### 1.10.67
- Gentler compaction: `COMPACTION_TARGET_RATIO` 0.6 → 0.75 (~75% of current context is kept instead of ~60%; ~25% loss instead of ~40%). Reason: compaction snapshots showed that at 0.6 agent chats lost too much working context (201K→113K, 218K→129K). context-budget tests updated.

### 1.10.66
- Compaction diagnostics: every compaction (auto-compact and overflow retry) is auto-saved as a JSON snapshot in `<globalStorage>/compactions/` (rotation of 20 files, best-effort). Contains before/after (messages, tokens, chars), targetTokens, a summary sample (400 chars), the last 2 tail messages and the number of truncated tool results — so compression quality can be reviewed manually.

### 1.10.65
- Fix for "thoughts as the answer": reasoning in `delta.content` is folded by three markers (`<think>`, `|thinking|>`, `thinking>`); the fallback without `LanguageModelThinkingPart` no longer prints thoughts as visible text (hides them, symmetric to `emitThinkingText`).

### 1.10.64
- Fix for hard compaction: new setting `llamacpp.compactMaxToolResultChars` (default 8000, 1000-24000) — long tool results in the kept tail are truncated, so significantly more turns fit into the budget (was: 187 → 15 messages at a 60% budget because of uneven token distribution).
- DeepSeek setup wizard: `deepSeekDefaultMaxOutputTokens` 65536 → 131072; the wizard no longer re-enables `autoCompact`.

### 1.10.63
- DeepSeek loop fixes: the repeated-tool-call detector is fixed (separate `loopInspectionMessages` conversion in tool mode — previously the detector never fired); cross-turn nudge over an 8-turn window at tool-only density; hard `maxModelTurnsPerRequest` limit (default 6, clamp 2-20) with the "[agent loop guard]" text.

### 1.10.60
- Unified soft compaction scheme: target = current size × 0.6 (`COMPACTION_TARGET_RATIO`), the same for proactive compaction and overflow retry; the hard scheme and the `hardCompactKeepLastTurns` setting were removed (hardInputTarget stays as a diagnostic metric).
- `llamacpp.autoCompact` back to default true; `contextUtilization` 0.94 (~40K headroom to the trigger in a 258K window).
- Compaction protection between restarts: on the first request of a scope after extension startup without a snapshot, proactive compaction is skipped (`scopesSeenSinceStartup`).

### 1.10.58
- `autoCompact` default false — compaction used to fire between restarts (later reverted in 1.10.60 in favor of the `scopesSeenSinceStartup` protection).

## 1.10.0 - 2026-08-04

Stable release after the 1.9.x dev-patch series. Highlights:

### Performance & diagnostics

- Claude usage probes no longer spawn a full Claude Code CLI agent every
  ~2 minutes per window when Claude is not in active use — this heavyweight
  polling was loading the machine and slowing unrelated chats. Probes now
  only run within 10 minutes of real Claude activity (or on explicit
  refresh); Claude keep-alive behavior is unchanged.
- DeepSeek compaction grace (`deepSeekCacheWriteGraceMs`) reduced from 3
  minutes to 1 minute: after an auto-compaction the provider waits less
  before the next tool-result continuation, cutting idle "agent is silent"
  stretches from ~13 minutes/day to ~4. A rare extra uncached rewrite
  (~$0.05) is the only cost.
- New `chat.request.arrived` / `codex.chat.request_arrived` diagnostics log
  the gap between our last completed response and the next request arrival,
  splitting "VS Code-side pause" (tool execution, chat-view rendering,
  request plumbing) from model latency when investigating slow big chats.
- `sanitizeOrphanToolCalls` rewritten from O(n²) to O(n) via suffix counts —
  large-chat conversion no longer rescans the whole history per message.
- Codex cache diagnostics now record `idleGapSeconds` on reused threads and
  classify a cold first segment as TTL expiry vs. eviction/backend routing;
  a `codex.chat.cold_first_segment` event captures the exact idle gap and
  prefix delta when a fresh turn starts cold.

### Reliability fixes

- Fixed DeepSeek/subagent 400 errors: "An assistant message with 'tool_calls'
  must be followed by tool messages responding to each 'tool_call_id'".
  Orphan tool calls (from interrupted turns or subagent contexts that drop
  tool results) are now stripped before the request is sent, in both tool
  and user tool-result modes.
- Codex: interrupted/resumed turns and turn-boundary handling hardened
  (`turn-bridge`, `codex-provider`), rollout metrics and token usage
  accounting fixes across live and rollout sources.
- Copilot patch runtime: keep-alive and tool-catalog stability fixes.

## 1.9.25 - 2026-08-04

- Claude cache keep-alive now has an "Ignore usage-limit pause" toggle in
  Quick Access. When enabled, keep-alive continues even when the 5-hour
  usage limit exceeds the 90% auto-pause threshold so the prefix cache
  survives across the usage-limit window.

## 1.9.24 - 2026-08-04

- Fixed an intermittent Claude warm-session loss after large turns. The
  Anthropic API stream closes naturally after every turn, but the pump
  handler unconditionally marked the session unhealthy, which caused the
  next request to fall through to a durable restore with a stale runtimeKey
  and a cold first segment. Natural stream closure after a completed turn
  now leaves the session healthy so warm reuse survives.

## 1.9.23 - 2026-08-04

- Claude steering (sending a follow-up message mid-turn) now works. The root
  cause was that a cancelled turn never persisted its stableAssistantMessageId;
  the next durable restore replayed the orphan tail with incomplete tool calls
  and the model continued the old task instead of reacting to the follow-up.
  Cancelled turns now update the resume boundary before re-throwing, so the
  restored transcript ends at the last completed assistant message.

## 1.9.22 - 2026-08-04

- Claude runtime fingerprint no longer includes the tool catalog. VS Code's
  per-restart tool-selection optimization changes the advertised tool set,
  which flipped runtimeChanged on every reload and forced a cold session_restored
  with a full cache miss. The runtime key now only tracks model, context target,
  cwd, and effort — Claude SDK handles tool-catalog changes natively through
  forkSession.
- A restored Claude session with 90%+ cache hit is now classified as healthy
  instead of session_restored. The restored label is only used when the hit
  rate is below the threshold.

## 1.9.21 - 2026-08-04

- Removed the default Claude maxTurns limit (was 24). The Agent SDK no
  longer receives a turn budget, so long-running agent turns with many tool
  rounds run until the cumulative-input circuit breaker or Anthropic API
  rate-limit stops them. Set the claudeMaxAgentTurns setting to a positive
  value to re-enable a per-turn segment cap.

## 1.9.20 - 2026-08-04

- Claude turns that hit the configured maxTurns segment budget (default 24)
  now end gracefully instead of failing. The SDK stops cleanly, the turn
  completes with a max_model_segments safety-stop reason in the live report,
  and the warm session survives. Previously the guard called failActiveTurn,
  which tore the session down and forced the next turn into a cold
  session_restored with a full cache miss and a compacted prefix.
- The default remains conservative (24); raise claudeMaxAgentTurns for
  long-running agent turns with many tool rounds.

## 1.9.19 - 2026-08-03

- Claude cache keep-alive no longer shows "No eligible session" while a
  Claude turn is running. The health card now reports `Waiting` with a clear
  explanation: "Claude turn is active; keep-alive will check again in 60s."
  Sessions with a prefix below the 100k-token threshold also show `Waiting`
  instead of a dead-end status.


## 1.9.18 - 2026-08-03

- Codex context usage in the live report now reflects the full cumulative thread
  total instead of the last model segment's delta. A reused `user-turn` showed
  ~87k when the model actually saw ~340k. Context above the window (e.g. 333k
  in a 258k window) signals server-side compaction between turns, previously
  invisible.
- Codex turns in the live report now include `inputMode` and `compacted`
  fields, so a switch from `full` (whole history, large) to `user-turn` (delta,
  smaller) is no longer misread as data loss.
- A reused Codex thread with low cache hit is now classified `upstream_expired`
  rather than the unactionable `unknown`.
- The dev gate now contains 297 tests.

## 1.9.17 - 2026-08-03

- Fixed the "first DeepSeek turn after a window reload always misses" bug.
  `refreshLanguageModelChatInformation()` cleared the persisted stable tool
  catalog on every activation, so the first request after a reload could not
  compare against the previous catalog even when VS Code advertised the exact
  same tools. The persisted catalog is now retained, and the same tool set
  keeps its prefix-cache hash across reloads.
- Root cause was confirmed from state: the persisted catalog fingerprint
  (`c0fbc0dc…`) exactly matched the post-reload request fingerprint, yet the
  in-memory catalog had been wiped, so the request was treated as a catalog
  change and the full 400k-token prompt was rewritten.

## 1.9.16 - 2026-08-02

- Cache diagnostics now record the advertised tool count and system-message
  hash of every request and its predecessor. A `tool_catalog_changed` miss
  reports the actual `N → M` tool delta, and `system_prompt_changed` states
  that VS Code rewrote system instructions/history (typically after an
  interruption). Tool-catalog refresh/snapshot events log the exact removed and
  added tool names, so a reload-driven catalog change (for example VS Code's
  own "Optimized tool selection") is visible instead of appearing as an
  unexplained full miss.
- Fixed a corrupted prefix-snapshot block and completed the `toolsCount`
  plumbing so the enriched diagnostics survive TypeScript strictness.

## 1.9.15 - 2026-08-02

- The cumulative-input circuit breaker now counts cache reads at 0.1x weight
  instead of full size. A warm turn re-processes the whole prefix on every
  model segment, so the unweighted 2M limit fired on every large turn, failed
  it, tore down the SDK session, and forced the next turn into a cold restore
  (first-segment miss, smaller first segment, and no eligible keep-alive
  sessions). Weighted counting only trips the breaker on genuinely large fresh
  input.
- Session Quality now has an independent Claude Cache Keep-Alive health card,
  visible even when no Claude user turn is running. It reports the current
  state and reason, usage-snapshot age, eligible/live sessions, protected model
  and prefix size, next attempt, last attempt/success/failure, and the latest
  maintenance turn's cache-read/cache-write result.
- Keep-alive is fail-safe: unknown or stale five-hour usage pauses background
  requests instead of treating the limit as 0%. Usage refresh and maintenance
  now run sequentially, failures are preserved, and retries are throttled.
- Maintenance turns are tagged separately and no longer create or overwrite
  ordinary Claude turn rows in the live report. The largest eligible prefix is
  selected first so the most expensive cache receives priority.
- The dev gate now contains 297 tests.

## 1.9.14 - 2026-08-02

- Durable Codex `thread/resume` now reapplies the same model, normalized cwd,
  approval policy, read-only sandbox, developer instructions, and restricted
  app-server config used by `thread/start`. Previously resume sent only the
  thread id, allowing a restarted process to inherit a different managed
  permission profile and invalidate the exact prompt-cache prefix.
- Windows workspace cwd spelling is stable across reload (`D:/...` and
  `d:\\...` resolve to the same lower-case drive form in Codex thread settings).
- The dev gate now contains 295 tests.

## 1.9.13 - 2026-08-02

- Claude durable-resume fallback is fail-safe by default. Before any full-input
  replay, the provider estimates conversation plus tool-schema tokens and
  requires both a replay below 64k tokens and a fresh five-hour usage snapshot
  below 80%. Unknown/stale usage, larger replays, or policy `never` stop before
  the API call; `always` remains an explicit escape hatch.
- Claude Agent SDK turns now have two independent circuit breakers: at most 24
  model segments and 2M cumulative processed input tokens by default. This
  prevents the 48-segment/6.6M-token incident pattern from running until an
  upstream `rate_limit` failure.
- The compact live report includes the exact fallback decision, estimated and
  allowed replay size, configured turn limits, and any safety-stop reason.
- The dev gate now contains 294 tests.

## 1.9.12 - 2026-08-02

- Fixed the observed Claude cold-fallback trigger after an interrupted turn.
  Durable sessions now persist the last confirmed assistant message UUID and
  resume with Agent SDK `resumeSessionAt`, excluding orphan user/interruption
  messages from the resumed transcript tail.
- Claude fallback diagnostics now preserve the original resume failure reason,
  stage, and SDK error in the live turn record and in the session-quality UI.
- Session Quality now copies a compact, cost-oriented turn report by default;
  Shift+Copy produces formatted text and Alt+Copy retains the full JSON. Large
  step and usage tables show only their first 3 and last 5 entries.
- Claude cache health in the turn table now uses the final continuation segment
  while retaining the cumulative processed blend in the detailed report.
- The dev gate now contains 292 tests.

## 1.9.11 - 2026-08-01

- Live report now explains Claude cache misses after a reload: restored and
  rollover sessions are classified as `session_restored` / `session_rollover`
  instead of `unknown`. When the restored session's runtime fingerprint
  changed (model, context target, effort, or the advertised tool catalog —
  which happens after every VS Code reload), the detail states that the cached
  prefix was rewritten because the system prompt differs.
- The dev gate now contains 291 tests.

## 1.9.10 - 2026-08-01

- Fixed follow-up messages being ignored while Claude or Codex is mid-turn.
  - Claude: the Agent SDK query stream ends after an interrupt, so a session
    with a dead stream is now marked unhealthy, excluded from warm reuse, and
    replaced through the durable restore path. Previously a follow-up was
    pushed into the dead stream and never produced a reaction.
  - Codex: an active tool turn is now superseded even when the follow-up
    arrives with the same Copilot turn index (`>=` instead of `>`), so the new
    user message interrupts the old work instead of being queued forever.
- Smart Claude cache keep-alive: while idle and below 90% usage limit, a
  minimal "reply ok" turn refreshes the Anthropic prompt-cache TTL every
  45 minutes on the largest idle session with a prefix over 100k tokens.
  Tool calls are denied inline, it never runs during an active turn, pauses
  automatically at 90% usage, and is toggled from Quick Access > Claude >
  Cache Keep-Alive (`llamacpp.claudeCacheKeepAliveEnabled` /
  `llamacpp.claudeCacheKeepAliveMs`).
- The dev gate now contains 291 tests.

## 1.9.9 - 2026-08-01

- Extension audit: removed dead code found by a full repository pass.
  - `CLAUDE_EXTENDED_CONTEXT_WINDOW` — never referenced (the context-control
    slider already caps at `CLAUDE_CONTEXT_TARGET_MAX`).
  - `ToolCallBuffer` type, `validateTools()`, and `tryParseJSONObject()` —
    exported but never used, not even in tests.
- Verified consistency: all 50 manifest commands are registered in code (two
  are registered dynamically through `contextLimitCommand`), all 83 manifest
  settings are read or written by code, package scripts match AGENTS.md, and
  the only source file without importers is the `extension.ts` entry point.
- The dev gate now contains 289 tests.

## 1.9.8 - 2026-08-01

- Quick Access now shows the live usage limit directly on the provider row
  without expanding the group: `Codex Connected (Plus): 70% R:2.08 17:25` and
  `Claude Connected (Pro): 20% R:7.08 21:45`. `R` is the window reset time in
  `D.MM HH:MM`; Claude uses the 5-hour session window, Codex uses its
  subscription window (a Codex 5-hour window is shown automatically if the
  runtime reports it in the future).
- Codex subagent routing is restricted to the GPT-5.6 family (Sol still
  excluded): `gpt-5.4-mini` and other non-5.6 models are no longer advertised
  in the `runSubagent` model enum, so agents cannot select them as subagents.
- The dev gate now contains 289 tests.

## 1.9.7 - 2026-08-01

- Fixed "micro-compactions": every turn near the limit was recorded as
  auto-compacted while the history was returned unchanged. The compaction
  estimator used the uncalibrated heuristic while the trigger used the
  calibrated count, so the fast path no-opped whenever the calibration factor
  drifted above 1. Compaction now shares the calibrated estimate.
- Auto-compaction now lands at 75% of the soft input target
  (`COMPACTION_TARGET_RATIO`) instead of exactly at the trigger threshold.
  Compacting to the threshold re-triggered on the very next turn; the new
  target leaves real headroom (roughly 30% reduction) so one compaction lasts
  for dozens of turns and the upstream prompt cache is rewritten much less
  often.
- The dev gate now contains 287 tests.

## 1.9.6 - 2026-07-31

- Subagent routing is now enforced at schema level: `runSubagent.model` accepts
  only the advertised catalog labels (`enum`), so `model="Auto"` or unknown
  values are rejected instead of silently inheriting the expensive parent
  model. The tool description explains the rejection.
- Fixed Codex subagent labels to match the model picker exactly
  (`GPT-5.6 Terra (Codex)` / `GPT-5.6 Luna (Codex)`), which is why Luna and
  Terra were never actually selected before. Codex subagent availability now
  reflects the ChatGPT subscription rate-limit state, and Terra is preferred
  over Luna in the guidance ordering.
- Subagent budget policy now states an explicit order: local (unlimited) →
  DeepSeek (when no vision is needed; DeepSeek cannot process images) → Codex
  Terra → Codex Luna → Claude Opus 5 (last resort).
- Quick Access now shows a live `Usage Limit` row for Codex (percent used and
  reset time) and a `Balance` row for DeepSeek from the official
  `GET /user/balance` endpoint. All provider usage rows auto-refresh every
  minute so reset times are visible without manual refresh; Claude limits
  already showed per-window percentages.
- The dev gate now contains 286 tests.

## 1.9.5 - 2026-07-31

- Fixed the DeepSeek double-miss after compaction. DeepSeek materializes the
  disk cache for a newly compacted prefix asynchronously, so the immediate
  tool-result continuation missed even with a byte-identical prefix (~490k
  tokens wasted twice). The provider now waits out the remaining
  `llamacpp.deepSeekCacheWriteGraceMs` window (default 3 minutes) before the
  first continuation after a compaction; the wait is skipped for new user
  turns, non-DeepSeek sources, and disabled `cachePrompt`.
- Renamed the misleading `upstream_expired` classification for this race to
  `upstream_cache_pending` with an explicit write-race detail when the previous
  turn compacted the history; genuine eviction still reports
  `upstream_expired`.
- The dev gate now contains 284 tests.

## 1.9.4 - 2026-07-31

- Raised provider session retention to 24 hours: Claude in-memory SDK sessions,
  Codex native-tool continuations and tool timeouts, and both armed rollover
  intents no longer expire after the former 30 minutes. A pause or reload
  within a day keeps the live session and its durable mapping instead of
  starting a cold transcript.
- Durable Claude transcripts and Codex threads remain eligible for seven days,
  so a 24-hour gap still restores the session. Prompt-cache warmth remains
  bounded by the provider's own cache TTL (5 minutes or 1 hour) and still needs
  a keep-alive turn to be guaranteed across a long pause.

## 1.9.3 - 2026-07-30

- Added a Provider Context panel with real range sliders in Quick Access.
  Claude can select a 258.4k-967k working target inside the Opus 5 1M window;
  Codex can select a cold-start target capped to the latest server-reported
  model window.
- Updated the Claude Agent SDK and bundled platform runtime to `0.3.220` /
  Claude Code `2.1.220`. Claude sessions now use the actual `opus[1m]` model
  variant and pass the selected target through
  `CLAUDE_CODE_AUTO_COMPACT_WINDOW`; cold-start history scales with the target.
- Removed the extra Codex `0.45` history multiplier. Cold-start compaction now
  subtracts explicit output, tool-schema, developer-instruction, and safety
  reserves from the selected working target, raising the representative
  semantic-message budget from about 87k to about 197k inside a 258.4k window.
- Made Codex server telemetry authoritative for advertised context size, kept
  manual `codexContextLength` as a pre-telemetry fallback only, and added
  regressions for 1M Claude selection, context slider bounds, and exact Codex
  budget calculations. The dev gate now contains 283 tests.

## 1.9.2 - 2026-07-30

- Unified completed Codex thread and Claude Agent SDK session retention at
  seven days. Overnight or post-limit-window reloads no longer discard a valid
  Codex thread after the former four-hour TTL.
- Migrated legacy Claude durable mappings that predate Copilot turn indices.
  The same advancing Copilot conversation can now resume its validated SDK
  transcript after reload even when Copilot has compacted or rewritten the
  visible message history.
- Kept same-turn retry protection, model/workspace validation, transcript
  existence checks, and seven-day stale-entry pruning, with regression coverage
  for a five-hour Codex restore and a shortened legacy Claude history.

## 1.9.1 - 2026-07-29

- Restored durable Claude Agent SDK sessions after Extension Host reload even
  when the current VS Code tool catalog changes. A matching model and advanced
  Copilot conversation can resume its validated on-disk session with the
  current tools instead of paying for a cold full-transcript start.
- Emitted Claude native `usage` after the visible text or tool call on every
  completed provider response boundary. Copilot Chat Session Info can now
  observe the latest model segment throughout a native-tool loop as well as on
  the terminal response.
- Added privacy-safe restore diagnostics and regression coverage for runtime
  drift, stale or non-advanced conversations, legacy persisted mappings, and
  ordered per-boundary usage emission. The dev gate now contains 280 tests.

## 1.9.0 - 2026-07-29

- Promoted the unified Local, DeepSeek, Codex, and Claude model-picker workflow
  to a stable release after the full 1.8.x hardening cycle.
- Stabilized durable Codex app-server threads and Claude Agent SDK sessions,
  including reload/rollover recovery and same-turn continuation through native
  VS Code tool cards.
- Kept executable actions inside the visible VS Code tool and approval boundary,
  with fail-closed handling and same-thread recovery when a subscription runtime
  requests a prohibited internal action.
- Added live Session Quality diagnostics for model/tool timelines, context,
  compaction, cache reads and writes, reasoning, latency, lifecycle, and
  provider-specific continuation health without retaining prompt bodies.
- Normalized native and aggregate usage reporting so Codex and Claude current
  context occupancy is not confused with multi-segment processed billing.
- Hardened prompt stability, bounded tool results, deterministic compaction,
  session compatibility checks, Copilot patch validation, and release
  reproducibility; the stable gate contains 279 extension-host tests.

## 1.8.47 - 2026-07-29

- Kept the fail-closed Codex internal-action boundary while recovering on the
  same app-server thread: after the prohibited turn is interrupted, a bounded
  follow-up reminds Codex to use only native VS Code tools instead of replaying
  the full visible transcript on a cold thread.
- Split a real cold first segment from continuation health in Session Quality.
  A new thread whose later model segments recover above 90% is now healthy,
  while its paid cold-start segment remains visible in processed cache totals
  and a separate `cold Codex startup` counter.
- Added regression coverage for blocked-action interrupt settling, recoverable
  exception classification, final-segment cache health, and report rendering.

## 1.8.46 - 2026-07-29

- Added Claude Agent SDK usage to native Copilot Chat Session Info through the
  same `usage` response-data contract used by the other contributed providers.
- Native Claude context occupancy now uses the final assistant model segment,
  including fresh input, cache reads, cache creation, output, and cached-input
  detail. This avoids treating aggregate multi-step billing as one oversized
  context window.
- Kept aggregate usage across every Claude model segment in Live Report and
  usage history, while the native denominator continues to use the advertised
  context window refreshed by the SDK context probe.

## 1.8.45 - 2026-07-29

- Added one live Claude logical-turn record across Agent SDK model segments and
  native VS Code tool-result continuations, with stable request identity and
  explicit `new`, `warm`, `restored`, `rollover`, or `resume-fallback` mode.
- Added exact Anthropic fresh-input, cache-read, cache-creation, output, and
  thinking-token segments; first-model/visible latency; native tool names and
  duration; terminal lifecycle; and asynchronous SDK context categories to
  Session Quality.
- Added Claude-specific cache and context panels plus a live model/tool timeline
  instead of rendering Agent SDK sessions as stateless prompt-prefix requests.
- Extended subagent correlation to Claude parents and updated the guarded
  Copilot patch anchors for the minified variable names in VS Code 1.131 while
  retaining unique-match and syntax-validation safeguards.

## 1.8.44 - 2026-07-29

- Fixed a newer user turn arriving while Codex waits on a long native tool or
  `runSubagent`: the pending app-server turn is interrupted and the next user
  message continues on the same compatible thread instead of replaying a full
  compacted transcript as a cold start.
- Finalized abandoned, interrupted, failed, cancelled, and 30-minute tool
  timeout records in Live Report. Timed-out native tools no longer remain
  indefinitely `running`, and their server usage is accounted before reuse.
- Split Codex cache analytics into processed input/cache across all model
  segments and final/continuation cache reuse. A turn such as 0% then 96.7% now
  shows both facts instead of presenting the 49% blended cost as continuation
  health.
- Merged rollout and live model/tool timelines, distinguished VS Code tool
  execution from app-server catalog lookup, and correlated eligible local or
  DeepSeek subagent turns with their parent `runSubagent` call.

## 1.8.43 - 2026-07-28

- Reworked the primary README around the extension's actual goals, supported
  transports, native VS Code tool boundary, model-picker Codex flow, durable
  sessions, cache/context controls, diagnostics, security, and known limits.
- Updated the architecture, Codex subscription, Copilot patch, token/cache,
  reliability, and release-audit documentation for patch v16 and the live
  Codex model/tool timeline.
- Documented the 1.8.43 release gates explicitly. Building and installing this
  VSIX remains separate from the later reviewed commit, tag, and publish step.

## 1.8.42 - 2026-07-28

- Added running Codex turn upserts and a model/tool step timeline to Live
  Report, including token/cache snapshots, tool status, and latency while a
  model-picker Codex request is still active.
- Kept tool completion metrics synchronized across native VS Code tool-result
  continuations so the live timeline reflects the same app-server turn.

## 1.8.41 - 2026-07-28

- Added a direct, privacy-preserving Codex rollout collector. Live Report now
  distinguishes one logical chat turn from its model segments and records exact
  token/cache snapshots, tool calls/results, tool latency, first-model-event
  latency, first-visible-response latency, and reasoning tokens.
- Added live-notification fallback metrics when a persisted rollout is not yet
  available, while retaining the original turn's compaction and context data
  across native VS Code tool continuations.
- Fixed fractional `codexContextUtilization` values being rounded down by the
  integer configuration clamp and removed false subagent classification from
  Codex tool continuations.

## 1.8.40 - 2026-07-28

- Added conversation compaction for Codex: full-turn messages are now compacted
  (summary + recent suffix) before serialization, reducing input tokens from
  ~170-193K to ~50-70K per turn when history exceeds 12 messages.
- Enhanced Codex per-turn diagnostics: duration, tool calls, output chars,
  compaction metrics, and context window are now reported to the live Session
  Quality report instead of zeros.
- Added `codexContextUtilization` and `codexCompactKeepLastTurns` config keys
  to tune Codex compaction behaviour.

## 1.8.39 - 2026-07-28

- Persisted exact per-conversation DeepSeek message snapshots and stable tool
  catalogs across Extension Host restarts, with one-time recovery from legacy
  prefix snapshots.
- Fixed normal auto-compaction so it stops at the soft target. The lower hard
  target is now used only after a backend-confirmed context overflow instead of
  rewriting the same prompt a second time before its first request.
- Upgraded the native Copilot Chat patch to v16. It disables Copilot-owned
  summarization/truncation for contributed llama models, forwards a stable
  conversation id, uses deterministic tools, and waits for tool definitions
  only after their cached signature actually changes.
- Redesigned the live Session Quality report with cache diagnostics, filters,
  issue highlighting, expandable detail cards, and state-preserving updates.

## 1.8.1 - 2026-07-27

- Added `stabilizeMessagePrefix`: when two consecutive requests share a common
  message prefix AND the static parameters and tool catalog are unchanged, the
  prefix messages are replaced with the exact byte-copy of the previous
  request.  This keeps the DeepSeek prompt cache warm even when VS Code trims
  different numbers of middle messages between turns — the common prefix never
  drifts.
- Added `chat.cache.prefix_stabilized` diagnostics so you can see when the
  prefix was pinned and how many messages were reused.

## 1.8.0 - 2026-07-27

- Fixed the root cause of long-session prompt-cache collapse. VS Code attaches
  `cache_control` breakpoint markers to chat content and moves them between
  messages as a conversation grows. Every conversion path rendered them into
  message text — as `{"$mid":…}` JSON in the llama/DeepSeek path, as
  `[data cache_control, N bytes]` in the Codex and Claude tool-result paths,
  and as `{"type":"data",…}` in the serialized Claude transcript. A moving
  marker rewrote already-sent history and invalidated the whole upstream
  prefix. Diagnostics showed the prefix diverging at message 2 of 420 with an
  unchanged message count, pinning DeepSeek at ~10% cache hit for entire
  sessions. All paths now drop the markers before any textual rendering.
- Scoped the reasoning map per conversation. It was a single global map with
  LRU eviction at 256 entries shared by every chat and model, so a second busy
  conversation silently evicted entries the first one's cached prefix depended
  on. Whole conversations are now evicted instead of individual entries.
- Bound the positional reasoning fallback to the actual tool-call ids. The
  fallback target moved forward each turn, so the previous target lost its
  `reasoning_content` and changed shape after it had already been sent.
- Added `chat.cache.report` diagnostics to the local, DeepSeek, Codex, and
  Claude providers. Codex and Claude previously reported no cache telemetry at
  all. The report includes cached/uncached token split, hit and miss percent,
  and a classified miss reason: `cold_start`, `request_params_changed`,
  `tool_catalog_changed`, `system_prompt_changed`, `history_rewritten`,
  `history_truncated`, `session_not_reused`, or `upstream_expired`.

## 1.7.5 - 2026-07-27

- Persisted the DeepSeek reasoning map (`_reasoningByToolCallId`) to
  `globalState` so it survives Extension Host restarts.  Previously a reload
  cleared the in-memory map, causing historical tool-call messages to lose
  their `reasoning_content` and breaking DeepSeek prompt-cache prefix reuse.
- Added lazy `loadPersistedReasoningMap()` and `persistReasoningMap()` with
  LRU-aware merge so new entries never overwrite previously persisted ones.
- Overrode `processStreamingResponse` in the llama provider to restore the
  map before streaming and persist it after every successful response.
- Added `MockMemento` and two regression tests that reproduce the cache-prefix
  instability across simulated restarts and verify the map is fully restored.

## 1.7.4 - 2026-07-27

- Fixed a severe DeepSeek prompt-cache regression where the newest reasoning
  block could be copied into every historical assistant tool-call message.
  Stored reasoning is now restored only by its exact tool-call id, with a
  newest-message-only compatibility fallback.
- Stabilized the exact API Direct tool catalog for each Copilot conversation.
  Optional tool activation no longer rewrites the cached prefix unless a tool
  is explicitly activated or a previously available tool disappears.
- Upgraded the guarded Copilot integration to patch v9. It now also bounds
  terminal output, native tool text, and non-text tool payloads before VS Code
  serializes them into chat history, preventing multi-hundred-megabyte session
  snapshots and extension-host stalls.
- Added `Local LLM: Continue Latest Codex Thread in New Chat` to resume the
  newest durable completed Codex thread without loading an already bloated VS
  Code transcript.
- Added bounded-output guidance to Codex terminal, file, and search tools so
  large logs, JSONL data, repository listings, and binary content stay out of
  native tool cards unless a narrow excerpt is required.

## 1.7.3 - 2026-07-26

- Added an explicit Claude rollover command for chats that have grown too large
  for VS Code's renderer-to-extension-host RPC serialization. It opens a new
  lightweight chat and resumes the newest persisted Agent SDK session while
  sending only the new user turn.
- Persisted rollover intent for 30 minutes so a reload between the command and
  the first new message does not lose the recovery operation.
- Made completed Claude durable-session metadata writes awaited, preventing an
  immediate reload from racing the workspace-state update.
- Kept the original durable mapping and rollover intent intact when a resume
  fails, avoiding a silent cold-start fallback that would lose conversation
  context.

## 1.7.2 - 2026-07-26

- Fixed Claude cold starts failing with `Invalid string length` on very long
  Copilot chats by applying `claudeMaxInputChars` while serializing messages,
  instead of constructing an unbounded JSON string before truncation.
- Added a 5,109-message regression that verifies bounded cold-start input and
  preserves the complete transcript for small conversations.
- Upgraded the guarded Copilot integration to patch v8. Prompt rendering now
  remains bounded by the effective model budget instead of cloning the endpoint
  with `Number.MAX_SAFE_INTEGER`, preventing multi-second full-history materialization
  and garbage-collection stalls in long chats.
- Added pre-turn diagnostics for Claude input preparation failures and the
  effective cold-start character limit.

## 1.7.1 - 2026-07-26

- Fixed Codex conversations silently starting as ephemeral when an effective
  contributed configuration default disagreed with the new durable defaults.
  Only explicit user/workspace overrides can now disable persistence.
- Replaced the incorrect post-reload `thread/read` probe with the official
  `thread/resume` operation and verify the returned thread id and persistence.
- Made durable `workspaceState` writes part of completed-turn finalization and
  added diagnostics for requested/returned persistence plus stored thread ids.
- Added a fail-closed pre-turn check: if app-server does not honor the requested
  persistence mode, the thread is removed before any paid model turn starts.
- Added a zero-model-turn, two-process app-server persistence smoke test covering
  `dynamicTools`, history materialization, restart, resume, read, and cleanup.

## 1.7.0 - 2026-07-26

- Added durable completed-session resume across VS Code reloads for Claude and
  Codex, keyed by the stable Copilot conversation identity and validated
  provider/runtime/history fingerprints.
- Enabled official Claude Agent SDK transcript persistence for user chats with
  safe session forking and a full-history fallback before visible output.
- Made Codex threads durable by default, reattaching them through `thread/read`
  after app-server restart while retaining an explicit ephemeral privacy mode.
- Canonicalized Claude MCP and Codex dynamic tool ordering plus JSON Schema key
  ordering so Copilot tool re-enumeration cannot cause a false semantic cold start.
- Documented that physical VS Code extension/tool registration still occurs,
  while Local and DeepSeek preserve stable upstream prompt-cache prefixes.

## 1.6.2 - 2026-07-26

- Fixed Claude subscription availability so the SDK's `allowed_warning` status
  remains advisory near the usage limit; only `rejected` blocks new requests.
- Added regression coverage for both warning and rejected runtime statuses.

## 1.6.1 - 2026-07-26

- Added the backend-confirmed `claude-opus-5` subscription profile and removed
  Sonnet 4.5, Haiku 4.5, Fable 5, and Opus 4.8 from the curated Claude picker.
- Raised the default Claude output advertisement to the backend-reported Opus 5
  limit of 32,000 tokens and updated the personal Opus agent to the new model id.

## 1.6.0 - 2026-07-26

- Embedded guarded Copilot Chat patch v7 into the main extension with silent
  startup verification, apply/status/restore commands, exact backups, and
  fail-closed compatibility checks for native context and thinking controls.
- Compiled mandatory subagent `model` schema enforcement directly into the
  Codex and Claude bridges, removing the need for Patch Guardian on this extension.
- Consolidated the repository patch CLI onto the same runtime implementation,
  updated integration documentation, and synchronized the dependency lockfile.
- Removed stale reasoning state and passed the full lint plus 236-test quality gate.

## 1.5.33 - 2026-07-24

- Fix `summarizeToolResultContent` for base64/image-result data (was skipping binary content).
- Rewrite `subagent-guidance` with clearer model-selection rules and quoting around model labels.

## 1.5.32 - 2026-07-24

- Raised the default prioritized `apiDirect` tool subset from 48 to 70 so the
  current VS Code tool catalog can retain native subagent delegation tools.
- Assigned explicit priority to `runSubagent` and related delegation tools so
  they remain available even when a larger catalog must still be truncated.
- Added regression coverage for an 83-tool catalog: the request keeps exactly
  70 prioritized tools and includes `runSubagent`.

## 1.5.31 - 2026-07-24

- Added global custom agents for all available model tiers: Qwen 3.6 27B
  (local, unlimited tokens), DeepSeek V4 Pro (API), GPT-5.6 Sol/Luna/Terra
  (Codex subscription), and Claude Opus 4.8 (Claude subscription). Each agent
  describes its strengths, limitations, and best-use scenarios.
- Enhanced subagent budget routing policy with explicit model names and
  Qwen's unlimited-token advantage for large-output operations.
- Updated project README with model comparison table, cloud subscription
  availability notes, and current model tier descriptions.

## 1.5.30 - 2026-07-20

- Prevented DeepSeek and local models from accidentally multiplying terminal
  tabs when they pass small sync `run_in_terminal.timeout` values as seconds:
  suspicious values from 1 through 999 are now repaired to milliseconds before native
  VS Code tool execution.
- Strengthened terminal tool guidance to reuse the persistent sync shell, keep
  at most one background terminal, reserve async mode for indefinite services,
  and continue an existing background job by terminal id.
- Added regression coverage for timeout repair, intentional millisecond/zero/
  async timeouts, and the model-visible terminal reuse contract.

## 1.5.29 - 2026-07-19

- Added a cost-tiered subagent budget routing policy to the model-visible
  `runSubagent` guidance: prefer the cheapest capable tier (local for
  narrow/verifiable subtasks, DeepSeek for focused reasoning) and escalate to
  Codex/Claude subscription models only for work the cheaper tiers cannot do.
- Disabled implicit subagent model inheritance: `runSubagent.model` is now
  mandatory and must be one of the catalog models, preventing Copilot
  built-in or free-tier models from being selected for subagents.
- Added regression coverage for tier ordering, single-tier omission, and the
  mandatory-selection policy across the subagent and Codex guidance tests.

## 1.5.28 - 2026-07-19

- Fixed the `Native VS Code tool delegation is unavailable` race by queuing
  Codex tool calls that arrive between a delegated boundary and the next
  tool-result resume, then exposing them in a fresh native VS Code tool card.
- Added explicit queued/unavailable bridge diagnostics and regression coverage
  for late sequential tool calls without weakening the VS Code-only boundary.
- Moved Claude availability refreshes off the critical path for Local, Qwen,
  DeepSeek, and Codex requests while preserving Claude's own live preflight.
- Removed confirmed dead fields, exports, redundant routing checks, and a stale
  lock-file backup; the strict unused-symbol audit now passes cleanly.
- Updated the public documentation for Claude support, native-only actions,
  warm session reuse, and the distinction between current-prompt cache coverage
  and previous-prefix retention.

## 1.5.27 - 2026-07-19

- Made native VS Code tool delegation mandatory for Codex, matching the
  existing Claude SDK boundary; legacy Codex sandbox, approval, and tool
  opt-out settings no longer expose an alternate execution path.
- Disabled Codex built-in shell, web, MCP, browser, computer-use, image,
  plugin, hook, and subagent capabilities at thread startup while forcing a
  read-only sandbox and declining every internal permission request.
- Added a fail-closed turn guard that interrupts and rejects any unexpected
  internal Codex action before it can be presented as normal model progress.

## 1.5.26 - 2026-07-19

- Stabilized local and DeepSeek prompt prefixes by canonicalizing tool order,
  JSON schemas, tool arguments, and fallback tool-call identifiers.
- Removed volatile subscription availability and reset details from the
  model-visible `runSubagent` tool description while retaining routing policy.
- Added privacy-preserving cache-prefix fingerprints and prefix-continuity
  diagnostics to request logs without recording prompt contents.
- Added uncached-input totals and zero-cache-read counts to persistent Token
  Usage and Usage Experiment summaries.

## 1.5.25 - 2026-07-19

- Added persistent baseline/delegated usage experiments with Codex-only savings,
  separate child-provider and per-model totals, matched task labels, and
  Markdown/JSON report export from Quick Access.
- Recorded experiment samples from the existing completed-usage events for
  Local/Qwen, DeepSeek, Codex, and Claude without adding a second completion
  path or counting live snapshots.
- Corrected subagent routing guidance: `agentName` selects behavior while the
  optional exact `runSubagent.model` picker label switches model/provider.
- Raised Codex post-tool reconciliation idle tolerance from 30 seconds to
  three minutes so high-effort reasoning is not mistaken for a stalled turn.
- Added one bounded same-thread recovery for genuinely stale tool turns,
  preserving the Codex thread and prompt cache instead of triggering
  Copilot's full-history retry.
- Added terminal and reconciliation diagnostics with the last observed thread
  status, while keeping permanent input, authorization, and rate-limit errors
  non-retryable.

## 1.4.12 - 2026-07-18

- Added an explicit cross-extension conversation contract: Copilot patch v7
  forwards its stable conversation id through `modelOptions`, allowing the
  provider to identify a completed thread even when Copilot rewrites rendered
  service and tool history between user turns.
- Kept reuse fail-closed by requiring the exact prior visible assistant answer,
  an advancing Copilot turn index, matching runtime settings, and a safe
  intersection of the original and current tool catalogs.
- Added privacy-preserving diagnostics for conversation-id availability and
  matching, plus regressions for unstable rendered history and regenerated
  answers.

## 1.4.11 - 2026-07-18

- Removed the mutable VS Code tool catalog from the completed-thread runtime
  fingerprint after a measured `90 -> 93` tool change forced another 600K
  character full-history request.
- Preserved the original app-server thread catalog and namespace routes while
  exposing only the safe intersection with tools advertised by the current
  Copilot request. Newly added, removed, re-namespaced, or schema-changed tools
  cannot be delegated through the reused thread.
- Added separate catalog fingerprints and reuse telemetry for original,
  current, and callable tool counts.

## 1.4.10 - 2026-07-18

- Fixed the measured `history-suffix-changed` follow-up miss by canonicalizing
  recent semantic user history separately from Copilot's mutable tool-call and
  tool-result plumbing.
- Kept the exact prior visible-answer check and now requires the complete
  bounded suffix of recent user messages to match, so edited requests still
  force a safe cold thread.
- Renamed reuse diagnostics to report matched semantic user messages and the
  precise `user-history-suffix-changed` miss reason.

## 1.4.9 - 2026-07-18

- Added an initial completed-thread fallback for histories that are not
  byte-identical between user turns while retaining exact answer validation.
- Added body-free Codex thread-reuse diagnostics with categorized model,
  runtime, process, answer, and history mismatch reasons.
- Kept an active Codex turn alive when VS Code changes its advertised tool
  catalog between a native tool call and its result, preventing a redundant
  full-history thread restart.
- Moved the outer `apply_patch` and `view_image` tools into the non-deferred
  `vscode_native` namespace so they no longer collide with Codex built-ins and
  remain available through native Copilot tool cards.
- Added regression coverage for catalog changes and namespaced built-in
  collisions, plus a no-inference protocol smoke test with both namespaces.

## 1.4.8 - 2026-07-18

- Fixed Codex thread startup by placing deferred dynamic tools inside the
  required `vscode_deferred` namespace instead of marking flat functions as
  deferred.
- Validated namespaced tool routing in the provider and added a no-inference
  protocol smoke test against the bundled Codex CLI 0.144.5 `thread/start`.

## 1.4.7 - 2026-07-18

- Batched parallel Codex dynamic-tool requests into one native Copilot tool
  round and returned all matching results to the still-active app-server turn.
- Added fail-safe cleanup for incomplete parallel results, abandoned tools, and
  app-server exits so suspended turns cannot remain alive indefinitely.
- Isolated JSONL buffers and delayed server responses by app-server process
  generation, preventing stale output from a restarted process from affecting
  the new connection.
- Cached validated ChatGPT account state for five minutes, throttled background
  subscription status refreshes, and cached the model catalog for 30 seconds to
  remove repeated control-plane RPCs from native tool loops.
- Stopped resending images from old conversation messages already omitted by
  the bounded Codex input serializer.
- Deferred non-core schemas through the Codex runtime's built-in tool search,
  keeping the full 95-tool Copilot catalog available without placing every
  schema in each model prompt.
- Verified the integration against TypeScript protocol bindings generated by
  the bundled Codex CLI 0.144.5 and expanded regression coverage to 144 tests.

## 1.4.6 - 2026-07-18

- Kept the original app-server turn alive while Copilot renders and executes
  native tool cards, returning results to the pending dynamic-tool request
  without interrupting or starting another model turn.
- Preserved text, JSON, and image tool results in the bridge while applying the
  configured per-result bound before they re-enter model context.
- Extended ephemeral Codex thread reuse across normal follow-up user turns, not
  only native tool-result rounds, so unchanged chats send incremental input.
- Added SHA-256 conversation-lineage validation plus model, workspace, sandbox,
  approval, tool-catalog, and app-server generation checks before any reuse.
- Added bounded four-hour in-memory conversation caching with safe fallback to
  a fresh full-history thread after edits, model changes, restarts, or misses.
- Added thread-reuse and last prompt-cache diagnostics to Codex Quick Access
  status, plus input-mode and tool-schema-size request logging.
- Tuned Codex instructions to batch independent reads and searches and avoid
  excessive todo updates, reducing unnecessary model/tool round trips.
- Added a 30-minute abandoned-tool guard that releases pending app-server turns
  without leaving extension or server state alive indefinitely.

## 1.4.5 - 2026-07-18

- Reused the active ephemeral Codex thread after native Copilot tool calls
  instead of creating a new thread and resending the full chat history.
- Sent only the matching native tool-result tail on continuation rounds,
  preserving prompt-cache locality and sharply reducing repeated input usage.
- Added bounded, expiring continuation state keyed by native tool call id so
  separate chats cannot accidentally share Codex runtime state.
- Added request diagnostics for reused threads and regression coverage ensuring
  large earlier histories are excluded from continuation payloads.

## 1.4.4 - 2026-07-18

- Reworked Codex dynamic tools to emit native `LanguageModelToolCallPart`
  responses and delegate execution to the standard Copilot agent tool loop.
- Restored native command, search, file, web, and memory tool cards instead of
  rendering their lifecycle inside one continuous thinking block.
- Made delegated tools inherit Copilot session permission behavior, including
  `Bypass Approvals` and terminal auto-approval rules.
- Automatically declined internal Codex command/file permission requests while
  native delegation is active, preventing duplicate extension-owned prompts.
- Exposed private caller tools such as the native terminal tool to Codex without
  trying to invoke them through the narrower `vscode.lm.tools` registry.

## 1.4.3 - 2026-07-18

- Bridged compatible Copilot tools into Codex through the app-server
  `dynamicTools` protocol and `vscode.lm.invokeTool`.
- Added a `vscode_terminal` dynamic tool that runs commands in a visible VS Code
  integrated terminal, captures output, and respects the Codex approval policy.
- Added `llamacpp.codexUseVsCodeTools` plus a Quick Access toggle and dynamic
  tool invocation diagnostics.
- Bounded individual historical tool results before whole-message omission so
  long chats retain substantially more user and assistant conversation context.
- Added `llamacpp.codexMaxToolResultChars` and regression coverage for the tool
  bridge, output bounds, and conversation preservation.

## 1.4.2 - 2026-07-18

- Prevented long Copilot Chat histories from exceeding the Codex app-server
  hard limit of 1048576 input characters.
- Added bounded conversation serialization that preserves the first and newest
  messages, omits stale middle history, and truncates the newest request only
  when it cannot otherwise fit.
- Added `llamacpp.codexMaxInputChars` with a conservative 600000-character
  default and request-size diagnostics in `codex.chat.start` logs.
- Added regression coverage for oversized Codex conversations.

## 1.4.1 - 2026-07-18

- Fixed Codex models not appearing in the Copilot Chat model picker even when
  subscription status was connected.
- Combined Local, DeepSeek, and `codex::` models under the existing `llamacpp`
  provider vendor because Copilot did not query the separately contributed
  Codex vendor.
- Added regression coverage for combined discovery and transport routing.

## 1.4.0 - 2026-07-18

- Added a separate Codex Subscription language-model provider backed by the
  official local `codex app-server` and ChatGPT-managed OAuth.
- Added dynamic Codex model discovery, model-specific native Thinking Effort
  choices, image input, token usage forwarding, cancellation, and streamed
  reasoning summaries.
- Added guarded workspace command, file-change, and permission approvals while
  keeping OAuth credentials inside the official Codex runtime.
- Added Codex commands and Quick Access controls for sign-in, sign-out, account
  status, subscription usage, and source enablement without changing local or
  DeepSeek endpoints.
- Added Codex architecture and security documentation plus protocol, model,
  reasoning, usage, and conversation-adapter regression tests.

## 1.3.0 - 2026-07-17

- Added deterministic tool-call repair, advertised-schema validation, bounded
  correction retry, and repeated identical-call loop protection.
- Upgraded shared memory to format v2 with global/workspace/model scopes,
  typed entries, source provenance, verification time, expiry, and hybrid
  exact/fuzzy retrieval. Version-one files migrate automatically.
- Added a read-only provider health check for discovery, runtime context,
  tokenizer support, prompt-cache settings, reliability controls, and retired
  DeepSeek aliases.
- Added privacy-preserving Markdown/JSON session quality reports for cache hit
  rate, latency, throughput, compaction, overflow recovery, and tool-call
  reliability.
- Added the new diagnostics to Quick Access and expanded regression coverage
  across streaming, correction retries, memory migration, and reporting.

## 1.2.0 - 2026-07-17

- Added adaptive and strict knowledge-verification modes for source-backed,
  version-aware technical work with local models and DeepSeek.
- Added a cache-stable custom system prompt and kept retrieved memory near the
  mutable end of the request.
- Added primary-source and pinned-revision guidance to web and GitHub tools
  without prompt-dependent tool-catalog churn.
- Exposed knowledge verification in Quick Access and documented a repeatable
  before/after audit workflow.

## 1.1.6 - 2026-07-17

- Disabled Copilot Agent's automatic LLM summarization for local provider
  sessions while preserving the explicit Compact Conversation command.
- Let the provider receive raw host history before enforcing its own exact
  token budget, tool-result sanitization, and deterministic compaction.

## 1.1.5 - 2026-07-17

- Prevented Copilot from reserving its complete raw VS Code tool catalog before
  the local provider applies bounded API Direct tool selection.
- Stopped the resulting early foreground summary and immediate follow-up
  summary loop observed around 41K tokens on a 131K Qwen context.

## 1.1.4 - 2026-07-17

- Prevented Copilot's smaller global summarization threshold from triggering a
  foreground LLM compaction well before a local model's advertised context
  limit.
- Upgraded the guarded Copilot bundle patch to v4 while preserving emergency
  foreground recovery at the real prompt limit.

## 1.1.3 - 2026-07-17

- Prevented Copilot Chat from starting background LLM compaction early for
  extension-contributed local models.
- Made the guarded Copilot patch use the provider's complete context window and
  ignore stale smaller session context overrides for `llamacpp`.
- Added a fast service profile for unavoidable Copilot summaries: no reasoning,
  no memory injection or prompt caching, and a configurable 2048-token cap.
- Added regression coverage for native Copilot compaction prompt detection.

## 1.0.1 - 2026-07-16

- Increased the default local High/Deep reasoning cap from 8192 to 16384
  tokens for complex Qwen coding and agent tasks.
- Kept Light and Balanced at 512 and 2048 tokens.
- Prevented DeepSeek setup from overwriting the local numeric reasoning cap.

## 1.0.0 - 2026-07-16

- Established the independent MrLordCat extension and release workflow.
- Added simultaneous local OpenAI-compatible and DeepSeek model sources.
- Added durable shared memory and native Agent tools.
- Added context budgeting, deterministic compaction, exact usage forwarding,
  prompt-cache diagnostics, and optional native Copilot controls.
- Separated normal output defaults from the global hard ceiling.
- Added llama.cpp-native thinking controls and clarified reasoning semantics.
- Bounded API Direct tool definitions by priority, count, and token cost.
- Extracted source routing, context, request, transport, and UI modules.
- Added CI, tag-based GitHub releases, pinned packaging tools, and 79 tests.
