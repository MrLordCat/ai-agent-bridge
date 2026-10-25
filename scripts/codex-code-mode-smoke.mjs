// Measures how Codex waits for a slow dynamic (VS Code) tool with and without code mode.
// Usage: node scripts/codex-code-mode-smoke.mjs [--delay-ms=40000] [--model=<id>] [--durable]
//   [--variant=default,yield,off,direct] [--tools-from=<rollout.jsonl>] [--codex=<codex.exe>]
// "default" is the policy without the code-mode table; "yield" is the shipped policy.
import { spawn } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { clearTimeout, setTimeout } from "node:timers";

const args = Object.fromEntries(process.argv.slice(2).map(arg => {
	const [key, ...rest] = arg.replace(/^--/, "").split("=");
	return [key, rest.join("=") || "true"];
}));
const TOOL_DELAY_MS = Number(args["delay-ms"] ?? 40_000);
const TURN_TIMEOUT_MS = Math.max(180_000, TOOL_DELAY_MS * 4);
// --tools-from=<rollout.jsonl> replays a real VS Code tool catalog; large catalogs switch Codex to code mode.
const EXTRA_TOOLS = args["tools-from"]
	? JSON.parse(readFileSync(args["tools-from"], "utf8").split("\n", 1)[0]).payload.dynamic_tools ?? []
	: [];

function resolveCodexExecutable() {
	if (args.codex || process.env.LLAMA_CODEX_CLI) {
		return path.resolve(args.codex || process.env.LLAMA_CODEX_CLI);
	}
	const profile = process.env.USERPROFILE || process.env.HOME;
	const extensionRoot = path.join(profile, ".vscode", "extensions");
	const platformDirectory = process.platform === "win32"
		? (process.arch === "arm64" ? "windows-aarch64" : "windows-x86_64")
		: process.platform === "darwin"
			? (process.arch === "arm64" ? "darwin-aarch64" : "darwin-x86_64")
			: (process.arch === "arm64" ? "linux-aarch64" : "linux-x86_64");
	const executableName = process.platform === "win32" ? "codex.exe" : "codex";
	const candidates = readdirSync(extensionRoot)
		.filter(name => name.startsWith("openai.chatgpt-"))
		.map(name => path.join(extensionRoot, name, "bin", platformDirectory, executableName))
		.filter(existsSync)
		.sort((left, right) => statSync(right).mtimeMs - statSync(left).mtimeMs);
	if (!candidates[0]) {
		throw new Error(`No bundled Codex executable found under ${extensionRoot}`);
	}
	return candidates[0];
}

class AppServerClient {
	constructor(executable) {
		this.executable = executable;
		this.nextId = 1;
		this.pending = new Map();
		this.buffer = "";
		this.listeners = new Set();
		this.onServerRequest = undefined;
	}

	async start() {
		this.child = spawn(this.executable, ["app-server", "--stdio"], {
			cwd: process.cwd(),
			env: process.env,
			stdio: ["pipe", "pipe", "pipe"],
			windowsHide: true,
		});
		this.child.stdout.setEncoding("utf8");
		this.child.stderr.setEncoding("utf8");
		this.child.stdout.on("data", chunk => this.handleStdout(chunk));
		this.child.stderr.on("data", () => {});
		await new Promise((resolve, reject) => {
			this.child.once("spawn", resolve);
			this.child.once("error", reject);
		});
		await this.request("initialize", {
			clientInfo: { name: "llama-vscode-chat-code-mode-smoke", title: "Codex Code Mode Smoke", version: "1" },
			capabilities: { experimentalApi: true, requestAttestation: false },
		});
		this.write({ method: "initialized", params: {} });
	}

	request(method, params, timeoutMs = 30_000) {
		const id = this.nextId++;
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pending.delete(id);
				reject(new Error(`${method} timed out`));
			}, timeoutMs);
			this.pending.set(id, { resolve, reject, timer });
			this.write({ id, method, params });
		});
	}

	write(message) {
		this.child.stdin.write(`${JSON.stringify(message)}\n`);
	}

	handleStdout(chunk) {
		this.buffer += chunk;
		let newline = this.buffer.indexOf("\n");
		while (newline >= 0) {
			const line = this.buffer.slice(0, newline).replace(/\r$/, "");
			this.buffer = this.buffer.slice(newline + 1);
			newline = this.buffer.indexOf("\n");
			if (!line) {
				continue;
			}
			const message = JSON.parse(line);
			if (message.id !== undefined && message.method) {
				void Promise.resolve(this.onServerRequest?.(message))
					.then(result => this.write({ id: message.id, result }))
					.catch(error => this.write({ id: message.id, error: { code: -32603, message: String(error?.message ?? error) } }));
			} else if (message.id !== undefined) {
				const pending = this.pending.get(message.id);
				if (pending) {
					this.pending.delete(message.id);
					clearTimeout(pending.timer);
					if (message.error) {
						pending.reject(new Error(message.error.message));
					} else {
						pending.resolve(message.result);
					}
				}
			} else if (message.method) {
				for (const listener of this.listeners) {
					listener(message);
				}
			}
		}
	}

	async stop() {
		const child = this.child;
		if (!child) {
			return;
		}
		this.child = undefined;
		child.stdin.end();
		await Promise.race([
			new Promise(resolve => child.once("exit", resolve)),
			new Promise(resolve => setTimeout(resolve, 2_000)),
		]);
		if (child.exitCode === null) {
			child.kill();
		}
	}
}

const BASE_FEATURES = {
	apps: false, browser_use: false, browser_use_external: false, browser_use_full_cdp_access: false,
	computer_use: false, enable_mcp_apps: false, hooks: false, image_generation: false, in_app_browser: false,
	multi_agent: false, multi_agent_v2: false, plugin_sharing: false, plugins: false, remote_plugin: false,
	shell_snapshot: false, shell_tool: false, unified_exec: false,
};
const VARIANTS = {
	default: BASE_FEATURES,
	off: { ...BASE_FEATURES, code_mode: false, code_mode_host: false, code_mode_only: false },
	yield: { ...BASE_FEATURES, code_mode: { default_exec_yield_time_ms: 600_000 } },
	direct: { ...BASE_FEATURES, code_mode: { direct_only_tool_namespaces: ["probe"] } },
};

const PROBE_TOOL = {
	type: "function",
	name: "probe_slow_tool",
	description: "Returns a secret word. It is slow: it can take a minute because a human approves it.",
	inputSchema: { type: "object", properties: { reason: { type: "string" } }, required: ["reason"], additionalProperties: false },
};

async function runVariant(client, label, features, modelId) {
	const started = Date.now();
	const stats = { label, model: modelId, items: {}, toolCalls: 0, toolCallAtMs: [], usageUpdates: 0, inputTokens: 0, status: undefined, finalText: "" };
	const thread = await client.request("thread/start", {
		model: modelId,
		cwd: process.cwd(),
		approvalPolicy: "on-request",
		sandbox: "read-only",
		environments: [],
		config: { web_search: "disabled", mcp_servers: {}, tools: { web_search: false }, features },
		developerInstructions: "Use only the advertised dynamic tools for actions.",
		ephemeral: args.durable !== "true",
		historyMode: "legacy",
		dynamicTools: [...EXTRA_TOOLS, label === "direct" ? {
			type: "namespace",
			name: "probe",
			description: "Probe tools.",
			tools: [PROBE_TOOL],
		} : PROBE_TOOL],
	});
	const threadId = thread.thread.id;
	client.onServerRequest = async request => {
		if (request.method !== "item/tool/call") {
			return { decision: "decline" };
		}
		if (request.params?.tool !== "probe_slow_tool") {
			stats.otherTools = [...(stats.otherTools ?? []), request.params?.tool];
			return { contentItems: [{ type: "inputText", text: "Unavailable in this smoke test." }], success: false };
		}
		stats.toolCalls++;
		stats.toolCallAtMs.push(Date.now() - started);
		await new Promise(resolve => setTimeout(resolve, TOOL_DELAY_MS));
		return { contentItems: [{ type: "inputText", text: "The secret word is PINEAPPLE." }], success: true };
	};
	const done = new Promise((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error(`${label}: turn timed out`)), TURN_TIMEOUT_MS);
		const listener = message => {
			const params = message.params ?? {};
			if (params.threadId && params.threadId !== threadId) {
				return;
			}
			if (message.method === "item/started" || message.method === "item/completed") {
				if (message.method === "item/started") {
					const item = params.item ?? {};
					const key = [item.type, item.tool ?? item.name ?? ""].filter(Boolean).join(":");
					stats.items[key] = (stats.items[key] ?? 0) + 1;
				} else if (params.item?.type === "agentMessage" && typeof params.item.text === "string") {
					stats.finalText = params.item.text;
				}
			}
			if (message.method === "thread/tokenUsage/updated") {
				stats.usageUpdates++;
				stats.inputTokens = params.tokenUsage?.total?.inputTokens ?? stats.inputTokens;
			}
			if (message.method === "turn/completed") {
				clearTimeout(timer);
				client.listeners.delete(listener);
				stats.status = params.turn?.status;
				stats.error = params.turn?.error?.message;
				resolve();
			}
		};
		client.listeners.add(listener);
	});
	await client.request("turn/start", {
		threadId,
		input: [{ type: "text", text: "Call probe_slow_tool exactly once with reason \"smoke\", then reply with only the secret word.", text_elements: [] }],
		effort: "low",
		summary: "none",
	});
	await done;
	stats.durationMs = Date.now() - started;
	stats.threadId = threadId;
	if (args.durable === "true") {
		const read = await client.request("thread/read", { threadId });
		const rollout = typeof read.thread?.path === "string" ? readFileSync(read.thread.path, "utf8") : "";
		const calls = {};
		for (const line of rollout.split("\n")) {
			try {
				const payload = JSON.parse(line).payload ?? {};
				if (payload.type === "function_call" || payload.type === "custom_tool_call") {
					const key = payload.namespace ? `${payload.namespace}.${payload.name}` : payload.name;
					calls[key] = (calls[key] ?? 0) + 1;
				}
				if (/Script running with cell ID/.test(JSON.stringify(payload.output ?? ""))) {
					stats.execYields = (stats.execYields ?? 0) + 1;
				}
			} catch {
				// partial trailing line
			}
		}
		stats.rolloutCalls = calls;
		stats.instructionsMentionExec = rollout.includes("functions.exec");
		await client.request("thread/delete", { threadId }).catch(() => undefined);
	}
	return stats;
}

const executable = resolveCodexExecutable();
const client = new AppServerClient(executable);
try {
	await client.start();
	const models = await client.request("model/list", { cursor: null, limit: 100, includeHidden: false });
	const modelId = args.model ?? (models.data.find(model => model.isDefault) ?? models.data[0]).id;
	const selected = args.variant ? args.variant.split(",") : ["default", "yield"];
	console.log(JSON.stringify({ executable, modelId, toolDelayMs: TOOL_DELAY_MS }));
	for (const label of selected) {
		console.log(JSON.stringify(await runVariant(client, label, VARIANTS[label], modelId)));
	}
} finally {
	await client.stop();
}
