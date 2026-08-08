# Reliability And Diagnostics

## Tool-Call Guard

The provider validates every streamed tool call against the exact catalog sent
in that request before creating a VS Code `LanguageModelToolCallPart`.

Deterministic repairs are deliberately narrow:

- remove an outer `json` code fence;
- extract one balanced JSON object from surrounding text;
- remove trailing commas outside strings;
- match an advertised tool name by case and remove outer backticks.

The guard does not invent required arguments, coerce types, rename properties,
or select a different tool. It checks required fields, primitive and array
types, enums, `anyOf`, item schemas, and `additionalProperties: false`. Unknown
tools and invalid arguments are rejected before execution.

When a rejection occurs before visible text or an executable tool part has
been emitted, the provider may retry the model with a short correction message.
`llamacpp.toolCallRepairMaxAttempts` bounds this path to at most two attempts;
the default is one. Correction messages are appended near the mutable end of
history so the stable cache prefix is retained.

Loop protection canonicalizes historical assistant tool calls and detects only
consecutive identical name/argument signatures. At the configured threshold it
adds a guard requiring the model to use the existing result, inspect an error,
change approach, or state the blocker. It does not silently suppress execution.

Relevant settings:

```json
{
  "llamacpp.toolCallRepairEnabled": true,
  "llamacpp.validateToolCallSchema": true,
  "llamacpp.toolCallRepairMaxAttempts": 1,
  "llamacpp.toolLoopProtection": true,
  "llamacpp.toolLoopDetectionThreshold": 3
}
```

## Provider Health Check

Run `Local LLM: Run Provider Health Check` from the Command Palette or Quick
Access. It performs read-only, non-generating checks:

- model discovery for each configured source;
- local llama.cpp runtime context from `/slots`;
- exact local prompt counting through `/apply-template` and `/tokenize`;
- local `cache_prompt`, API Direct, knowledge policy, memory, schema validation,
  repair, and loop-protection settings;
- DeepSeek cache/tokenizer expectations;
- warning for retired `deepseek-chat` and `deepseek-reasoner` aliases.

The report is written as Markdown and JSON under
`<globalStorage>/reports/` and the Markdown file opens automatically. `FAIL`
means a source is not currently usable, `WARN` means a fallback or risky
configuration is active, and `INFO` records expected provider-specific behavior.

## Session Quality Report

Run `Local LLM: Open Session Quality Report` to open the live webview for
metrics accumulated since extension activation or the last reset. It updates
without replacing the webview document, preserving expanded rows and active
model/search/issues-only filters. Turn details use stable request ids, so a new
live turn cannot redirect an already open card; its viewport position is also
preserved across updates.

- prompt and cached prompt tokens with weighted cache-hit percentage;
- ordered prompt/cache blocks with an optional exploded view: every block gets
  its own full-width cached/uncached meter and exact total/read/miss/hit values,
  including blocks too small to inspect in the proportional overview;
- per-model cache health, miss classification, and best/worst turn visibility;
- first-model-event, first-visible-text, and generation throughput metrics;
- tool calls, native tool duration/breakdown, deterministic repairs,
  rejections, and correction retries;
- detected tool loops;
- provider compaction and context-overflow retries;
- per-turn model id, transport, context budget, and exact/estimated source;
- Codex and Claude model usage segments and ordered live model/tool step
  timelines with running, completed, failed, timed-out, or cancelled status;
- Codex thread mode and lifecycle, plus separate processed cache cost and final
  continuation reuse. Catalog searches and delegated VS Code tools are counted
  separately, recovered cold startup segments remain visible without making a
  healthy continuation an issue, and eligible subagent turns link back to their
  parent request.
- Claude Agent SDK session mode, fresh/cache-read/cache-creation input, thinking
  tokens, native tool round trips, and asynchronous SDK context categories.

Reports contain metrics and model ids only. They do not retain message or tool
result bodies. Markdown and JSON snapshots are updated automatically under
`<globalStorage>/reports/`, so a completed run remains inspectable outside the
webview. Use `Local LLM: Reset Session Metrics` before a controlled test.

## Usage Experiments

Use `Local LLM: Start Baseline Usage Experiment` and `Local LLM: Start
Delegated Usage Experiment` with the exact same task label to compare two
routing strategies. Stop each run with `Local LLM: Stop and Export Usage
Experiment`; the tracker records bounded provider usage samples and exports a
Markdown/JSON comparison. This is intended for controlled repeated tasks, not
for comparing unrelated prompts or different model/effort settings.

## Repeatable Agent Benchmark

1. Reload VS Code after installing the VSIX.
2. Run the provider health check and keep the generated report.
3. Reset session metrics.
4. Start a new chat, select the same model and Thinking Effort used for the
   baseline, and submit the exact same audit prompt.
5. Let the agent finish without manually compacting or changing models.
6. Open the live report and retain its automatically written Markdown/JSON
  snapshot. For an A/B routing comparison, also complete a matched Usage
  Experiment pair.
7. Compare evidence quality and task completion together with cache hit rate,
   first-token latency, tool retries/rejections, tool loops, compaction, and
   overflow recovery.

A better answer with bounded additional tool work is a useful improvement. A
longer answer or more tool calls alone is not.
