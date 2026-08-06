#!/usr/bin/env node
/**
 * Performance report for llama-vscode-chat.
 *
 * Reads the extension's session logs (JSONL) and prints, per conversation:
 *   - a timeline of turns (time, message count, gap to previous turn, provider
 *     duration, TTFT, tokenizer RPC calls, cache hit);
 *   - medians/p95 for gap and duration;
 *   - request shape (roles, chars, tool calls) so a silently disabled history
 *     cap becomes visible;
 *   - compaction events.
 *
 * Usage:
 *   node scripts/perf-report.mjs [logDir] [--chat <key-prefix>] [--since ISO|HH:MM] [--last N] [--json]
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";

function defaultLogDir() {
  return path.join(os.homedir(), "AppData", "Roaming", "Code", "User", "globalStorage", "mrlordcat.llama-vscode-chat", "logs");
}

function parseArgs(argv) {
  const args = { dir: defaultLogDir(), chat: "", since: 0, last: Infinity, json: false };
  let i = 0;
  while (i < argv.length) {
    const a = argv[i];
    if (a === "--chat") args.chat = argv[++i] || "";
    else if (a === "--since") {
      const v = argv[++i] || "";
      args.since = v.includes("T") || v.includes("-") ? Date.parse(v) : (() => {
        const [h, m] = v.split(":").map(Number);
        const d = new Date();
        d.setHours(h, m || 0, 0, 0);
        return d.getTime();
      })();
    } else if (a === "--last") args.last = Number(argv[++i]) || Infinity;
    else if (a === "--json") args.json = true;
    else if (!a.startsWith("-")) args.dir = a;
    i++;
  }
  return args;
}

function median(values) {
  if (!values.length) return undefined;
  const s = [...values].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}
function pct(values, p) {
  if (!values.length) return undefined;
  const s = [...values].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
}
const fmtS = (ms) => (ms === undefined ? "—" : ms >= 1000 ? (ms / 1000).toFixed(1) + "s" : ms + "ms");
const fmtMs = (ms) => (ms === undefined ? "—" : Math.round(ms).toLocaleString());

async function readEvents(logDir) {
  const files = fs
    .readdirSync(logDir)
    .filter((f) => f.endsWith(".jsonl"))
    .map((f) => ({ f, t: fs.statSync(path.join(logDir, f)).mtimeMs }))
    .sort((a, b) => a.t - b.t);
  const events = [];
  for (const { f } of files) {
    await new Promise((res) => {
      const r = readline.createInterface({ input: fs.createReadStream(path.join(logDir, f)), crlfDelay: Infinity });
      r.on("line", (l) => {
        let e;
        try { e = JSON.parse(l); } catch { return; }
        events.push({ file: f, ...e });
      });
      r.on("close", res);
    });
  }
  events.sort((a, b) => a.ts.localeCompare(b.ts));
  return events;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!fs.existsSync(args.dir)) {
    console.error(`Log directory not found: ${args.dir}`);
    process.exit(1);
  }
  const events = await readEvents(args.dir);
  if (!events.length) {
    console.error("No events found.");
    process.exit(1);
  }

  const chats = new Map(); // key -> { id, turns: [], compactions: [] }
  let open = new Map(); // requestId -> turn buffer
  for (const e of events) {
    const d = e.data || {};
    if (e.event === "chat.request.arrived") {
      const key = String((d.requestedModelOptions && d.requestedModelOptions._copilotConversationId) || "").slice(0, 8) || "(unknown)";
      open.set(d.requestId, {
        requestId: d.requestId,
        ts: e.ts,
        msgs: d.messageCount,
        gap: d.gapSinceLastResponseMs,
        ctk: (d.hostTokenCounting || {}).calls,
        key,
      });
    } else if (e.event === "chat.request.shape") {
      const b = open.get(d.requestId);
      if (b) {
        b.shape = d;
      } else {
        // shape arrives even when arrived was skipped (first turn after restart)
        open.set(d.requestId, { requestId: d.requestId, ts: e.ts, shape: d });
      }
    } else if (e.event === "chat.turn.complete") {
      const b = open.get(d.requestId);
      const m = d.metrics || {};
      const key = b?.key ?? (m.conversationKey ? String(m.conversationKey).slice(0, 8) : "(unknown)");
      let chat = chats.get(key);
      if (!chat) { chat = { id: key, turns: [], compactions: 0 }; chats.set(key, chat); }
      chat.turns.push({
        ts: b?.ts ?? e.ts,
        msgs: b?.msgs ?? m.messageCount,
        gap: b?.gap,
        ctk: b?.ctk,
        dur: m.durationMs,
        ttft: m.firstTokenLatencyMs,
        hit: m.promptCacheHitPercent,
        autoCompacted: d.contextUsage?.autoCompacted,
        shape: b?.shape,
        model: m.modelId,
      });
      open.delete(d.requestId);
    } else if (e.event === "chat.messages.auto_compact") {
      // attribute to most recent chat by rough timestamp ordering
      const chat = [...chats.values()].sort((a, b2) => {
        const la = a.turns.at(-1)?.ts ?? "";
        const lb = b2.turns.at(-1)?.ts ?? "";
        return la.localeCompare(lb);
      }).at(-1);
      if (chat) chat.compactions++;
    }
  }

  const cutoff = args.since;
  const out = [];
  for (const [key, chat] of [...chats.entries()].sort((a, b) => {
    const ta = a[1].turns.at(-1)?.ts ?? "";
    const tb = b[1].turns.at(-1)?.ts ?? "";
    return ta.localeCompare(tb);
  })) {
    let turns = chat.turns.filter((t) => !cutoff || Date.parse(t.ts) >= cutoff);
    if (args.chat && !key.startsWith(args.chat)) continue;
    if (!turns.length) continue;
    turns = turns.slice(-args.last);
    const gaps = turns.map((t) => t.gap).filter((v) => typeof v === "number");
    const durs = turns.map((t) => t.dur).filter((v) => typeof v === "number");
    const ctk = turns.map((t) => t.ctk).filter((v) => typeof v === "number");

    out.push({ key, turns, gaps, durs, ctk, compactions: chat.compactions });
  }

  if (args.json) {
    console.log(JSON.stringify(out, null, 2));
    return;
  }

  for (const c of out) {
    const lastTs = c.turns.at(-1)?.ts?.slice(11, 19) ?? "";
    const msgs = c.turns.map((t) => t.msgs ?? 0);
    console.log(`\n== chat ${c.key}  turns=${c.turns.length}  last=${lastTs}  compactions=${c.compactions}`);
    console.log(
      `   msgs min/med/max: ${Math.min(...msgs)} / ${median(msgs)} / ${Math.max(...msgs)}` +
      `   gap med/p95: ${fmtS(median(c.gaps))} / ${fmtS(pct(c.gaps, 95))}` +
      `   turn med/p95: ${fmtS(median(c.durs))} / ${fmtS(pct(c.durs, 95))}` +
      `   countTokens med: ${median(c.ctk)?.toFixed(0) ?? "—"}`
    );
    console.log(`   time     msgs  gap      turn     ttft   ctk hit%   roles(head→tail)`);
    for (const t of c.turns.slice(-15)) {
      const head = t.shape?.headRoles?.join("") ?? "";
      const tail = t.shape?.tailRoles?.join("") ?? "";
      console.log(
        `   ${t.ts.slice(11, 19)} ${String(t.msgs ?? "?").padStart(5)} ${fmtS(t.gap).padStart(8)} ${fmtS(t.dur).padStart(8)} ${fmtS(t.ttft).padStart(7)} ${String(t.ctk ?? "?").padStart(5)} ${t.hit !== undefined ? String(t.hit).padStart(4) + "%" : "  — "}  ${head}→${tail}`
      );
      if (t.shape) {
        console.log(
          `        roles=${JSON.stringify(t.shape.byRole)} chars=${fmtMs(t.shape.totalChars)} toolCalls=${t.shape.toolCalls} results=${t.shape.toolResults} largest=${fmtMs(t.shape.largestChars)}`
        );
      }
    }
  }

  // Aggregate summary
  const allGaps = out.flatMap((c) => c.gaps);
  const allDurs = out.flatMap((c) => c.durs);
  console.log("\n== overall");
  console.log(`   chats=${out.length}  turns=${out.reduce((a, c) => a + c.turns.length, 0)}`);
  console.log(`   gap med/p95/max: ${fmtS(median(allGaps))} / ${fmtS(pct(allGaps, 95))} / ${fmtS(Math.max(...allGaps, 0))}`);
  console.log(`   turn med/p95/max: ${fmtS(median(allDurs))} / ${fmtS(pct(allDurs, 95))} / ${fmtS(Math.max(...allDurs, 0))}`);
  console.log(`   hint: gap − turn ≈ Copilot renderer+plumbing time (our provider is idle in the gap)`);
}

main().catch((e) => { console.error(e); process.exit(1); });
