# Knowledge Verification And System Prompt

Local models can be strong coding agents while still having stale or incomplete
knowledge about current APIs, library versions, security guidance, and product
behavior. The provider compensates for that gap with a small stable system
policy and source-oriented tool guidance.

## Modes

`llamacpp.knowledgeMode` controls the built-in policy:

| Mode | Behavior | Recommended use |
| --- | --- | --- |
| `adaptive` | Verifies material claims when they are changing, version-specific, security-sensitive, or uncertain | Normal coding work |
| `strict` | Requires source-backed verification for material external technical claims and asks for implementation or runtime evidence when behavior matters | Audits, migrations, compatibility research |
| `off` | Disables the built-in verification policy | Fully custom prompting or minimum prompt overhead |

Adaptive is the default. Strict mode is intentionally more expensive because it
can produce additional web and source tool calls.

Change the mode from Quick Access under **Model Behavior**, run
`AI Agent Bridge: Set Knowledge Verification`, or use settings JSON:

```json
{
  "llamacpp.knowledgeMode": "strict"
}
```

## Evidence Rules

The policy tells the model to:

- inspect local source and tests before making project claims;
- use official documentation, specifications, release notes, and pinned source
  revisions for changing external facts;
- record versions, commits, dates, direct URLs, local paths, and line numbers
  when relevant;
- distinguish verified facts, inference, assumptions, and unavailable live
  verification;
- cross-check documentation against implementation or a reproducible test when
  runtime behavior matters.

API Direct adds matching hints to `fetch_webpage`, `github_repo`, and
`github_text_search`. Those tools remain in a stable priority-ordered catalog;
the provider does not change tool definitions based on prompt keywords because
that would reduce prompt-cache reuse and could hide a tool needed later in an
agent turn.

## Custom Instructions

`llamacpp.customSystemPrompt` appends durable user instructions to the provider
policy. It remains active when `knowledgeMode` is `off`.

Use it for stable preferences such as testing standards, source policies, or
project-wide coding constraints. Put task-specific text in the chat and mutable
facts in shared memory. Frequently editing the custom system prompt changes the
request prefix and lowers prompt-cache reuse.

The custom prompt is capped at 12,000 characters. It is not injected into
Copilot's explicit Compact Conversation service request.

## Cache Layout

The request is assembled in this order:

1. Provider knowledge policy and custom system prompt.
2. Native VS Code/Copilot system instructions.
3. Conversation history.
4. Retrieved shared memory immediately before the latest user message.

The provider policy changes only when its mode, custom text, or local calendar
date changes. Retrieved memory stays near the mutable end of the conversation,
so it does not invalidate the stable prefix. The normal llama.cpp
`cache_prompt` behavior remains enabled for local requests.

## Baseline Comparison

For a before/after audit comparison:

1. Keep the model, quantization, server arguments, reasoning mode, prompt, and
   workspace revision unchanged.
2. Run the baseline with `knowledgeMode = off`.
3. Start a new chat, select `strict`, and run the identical prompt again.
4. Compare primary-source coverage, pinned versions or commits, local
   file-and-line evidence, reproducible checks, unresolved claims, token use,
   tool calls, and elapsed time.

Do not compare two turns in the same chat. Earlier answers and tool results
would become additional context and make the result less meaningful.
