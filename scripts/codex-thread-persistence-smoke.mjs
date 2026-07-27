import { spawn } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { clearTimeout, setTimeout } from "node:timers";

const REQUEST_TIMEOUT_MS = 15_000;

function resolveCodexExecutable() {
	const explicit = process.argv[2] || process.env.LLAMA_CODEX_CLI;
	if (explicit) {
		return path.resolve(explicit);
	}
	const profile = process.env.USERPROFILE || process.env.HOME;
	if (!profile) {
		throw new Error("USERPROFILE/HOME is unavailable; pass the Codex executable as the first argument");
	}
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
		this.stderr = "";
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
		this.child.stderr.on("data", chunk => {
			this.stderr += chunk;
		});
		await new Promise((resolve, reject) => {
			this.child.once("spawn", resolve);
			this.child.once("error", reject);
		});
		await this.request("initialize", {
			clientInfo: {
				name: "llama-vscode-chat-persistence-smoke",
				title: "Codex Thread Persistence Smoke Test",
				version: "1",
			},
			capabilities: {
				experimentalApi: true,
				requestAttestation: false,
			},
		});
		this.notify("initialized", {});
	}

	request(method, params) {
		const id = this.nextId++;
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pending.delete(id);
				reject(new Error(`${method} timed out${this.stderr ? `: ${this.stderr.trim()}` : ""}`));
			}, REQUEST_TIMEOUT_MS);
			this.pending.set(id, { resolve, reject, timer });
			this.write({ id, method, params });
		});
	}

	notify(method, params) {
		this.write({ method, params });
	}

	write(message) {
		if (!this.child?.stdin.writable) {
			throw new Error("Codex app-server stdin is unavailable");
		}
		this.child.stdin.write(`${JSON.stringify(message)}\n`);
	}

	handleStdout(chunk) {
		this.buffer += chunk;
		let newline = this.buffer.indexOf("\n");
		while (newline >= 0) {
			const line = this.buffer.slice(0, newline).replace(/\r$/, "");
			this.buffer = this.buffer.slice(newline + 1);
			if (line) {
				const message = JSON.parse(line);
				if (message.id !== undefined && message.method) {
					this.write({
						id: message.id,
						error: { code: -32601, message: `Smoke test does not implement ${message.method}` },
					});
				} else if (message.id !== undefined) {
					const pending = this.pending.get(message.id);
					if (pending) {
						this.pending.delete(message.id);
						clearTimeout(pending.timer);
						if (message.error) {
							pending.reject(new Error(`${message.error.message}${message.error.data ? `: ${JSON.stringify(message.error.data)}` : ""}`));
						} else {
							pending.resolve(message.result);
						}
					}
				}
			}
			newline = this.buffer.indexOf("\n");
		}
	}

	async stop() {
		if (!this.child) {
			return;
		}
		const child = this.child;
		this.child = undefined;
		for (const pending of this.pending.values()) {
			clearTimeout(pending.timer);
			pending.reject(new Error("Codex app-server stopped"));
		}
		this.pending.clear();
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

function assertDurable(label, response, expectedHistoryMode) {
	if (!response?.thread?.id) {
		throw new Error(`${label}: missing thread id: ${JSON.stringify(response)}`);
	}
	if (response.thread.ephemeral !== false) {
		throw new Error(`${label}: app-server returned ephemeral=${String(response.thread.ephemeral)}`);
	}
	if (expectedHistoryMode && response.thread.historyMode !== expectedHistoryMode) {
		throw new Error(`${label}: expected historyMode=${expectedHistoryMode}, got ${String(response.thread.historyMode)}`);
	}
}

const executable = resolveCodexExecutable();
const first = new AppServerClient(executable);
const created = [];
let durableThreadId;
let setupCompleted = false;

try {
	await first.start();
	const variants = [
		{ label: "default", historyMode: undefined, dynamicTools: undefined },
		{ label: "legacy", historyMode: "legacy", dynamicTools: undefined },
		{
			label: "legacy-dynamic-tools",
			historyMode: "legacy",
			dynamicTools: [{
				type: "function",
				name: "persistence_smoke_tool",
				description: "No-op schema used to verify durable dynamic-tool threads.",
				inputSchema: { type: "object", additionalProperties: false },
			}],
		},
	];
	for (const variant of variants) {
		const response = await first.request("thread/start", {
			cwd: process.cwd(),
			approvalPolicy: "never",
			sandbox: "read-only",
			ephemeral: false,
			...(variant.historyMode ? { historyMode: variant.historyMode } : {}),
			...(variant.dynamicTools ? { dynamicTools: variant.dynamicTools } : {}),
		});
		assertDurable(`thread/start ${variant.label}`, response, variant.historyMode);
		created.push(response.thread.id);
		if (variant.label === "legacy-dynamic-tools") {
			durableThreadId = response.thread.id;
			await first.request("thread/inject_items", {
				threadId: durableThreadId,
				items: [{
					type: "message",
					role: "user",
					content: [{
						type: "input_text",
						text: "Durable thread smoke marker. No model turn was started.",
					}],
				}],
			});
		} else {
			await first.request("thread/delete", { threadId: response.thread.id });
			created.splice(created.indexOf(response.thread.id), 1);
		}
		console.log(JSON.stringify({ phase: "start", variant: variant.label, thread: response.thread }));
	}
	setupCompleted = true;
} finally {
	if (!setupCompleted) {
		for (const threadId of created) {
			try {
				await first.request("thread/delete", { threadId });
			} catch {
				// Best-effort cleanup; preserve the primary assertion failure.
			}
		}
	}
	await first.stop();
}

if (!durableThreadId) {
	throw new Error("Legacy durable thread was not created");
}

const second = new AppServerClient(executable);
try {
	await second.start();
	const resumed = await second.request("thread/resume", {
		threadId: durableThreadId,
		excludeTurns: true,
	});
	assertDurable("thread/resume after process restart", resumed, "legacy");
	if (resumed.thread.id !== durableThreadId) {
		throw new Error(`thread/resume changed id from ${durableThreadId} to ${resumed.thread.id}`);
	}
	const read = await second.request("thread/read", { threadId: durableThreadId, includeTurns: true });
	assertDurable("thread/read after resume", read, "legacy");
	console.log(JSON.stringify({
		phase: "resume",
		threadId: durableThreadId,
		resumed: true,
		turnCount: read.thread.turns?.length ?? 0,
	}));
	await second.request("thread/delete", { threadId: durableThreadId });
	created.splice(created.indexOf(durableThreadId), 1);
} finally {
	for (const threadId of created) {
		try {
			await second.request("thread/delete", { threadId });
		} catch {
			// Best-effort cleanup; preserve the primary assertion failure.
		}
	}
	await second.stop();
}

console.log(JSON.stringify({ ok: true, modelTurnsStarted: 0, executable }));