import * as assert from "node:assert";
import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";
import { compareVersions, ExtensionUpdater, parseLatestRelease, parseStableVersion, type ExtensionUpdaterOptions } from "../update/extension-updater";
import { buildUpdateItem } from "../ui/quick-access";

const REPO = "https://github.com/MrLordCat/ai-agent-bridge";
function release(version: string, bytes: Uint8Array, digest = createHash("sha256").update(bytes).digest("hex")) {
	return { tag_name: `v${version}`, html_url: `${REPO}/releases/tag/v${version}`, draft: false, prerelease: false, assets: ["win32-x64", "linux-x64"].map(target => ({
		name: `llama-vscode-chat-v${version}-${target}.vsix`, size: bytes.length, digest: `sha256:${digest}`,
		browser_download_url: `${REPO}/releases/download/v${version}/llama-vscode-chat-v${version}-${target}.vsix`,
	})) };
}
function memento(): Pick<vscode.Memento, "get" | "update"> {
	const values = new Map<string, unknown>();
	return { get: ((key: string, fallback?: unknown) => values.has(key) ? values.get(key) : fallback) as vscode.Memento["get"], update: async (key, value) => { values.set(key, value); } };
}
function ui(messages: string[], answer?: string): ExtensionUpdaterOptions["ui"] {
	const show = async (message: string) => { messages.push(message); return answer; };
	return { showInformationMessage: show, showWarningMessage: show, showErrorMessage: show } as unknown as ExtensionUpdaterOptions["ui"];
}

suite("Extension updater", () => {
	let root: string;
	setup(async () => { root = await fs.mkdtemp(path.join(os.tmpdir(), "aab-update-")); });
	teardown(async () => { await fs.rm(root, { recursive: true, force: true }); });

	test("accepts only stable versions and compares them numerically", () => {
		assert.deepStrictEqual(parseStableVersion("v1.19.10"), [1, 19, 10]);
		assert.strictEqual(parseStableVersion("1.20.0-beta.1"), undefined);
		assert.ok(compareVersions("1.19.10", "1.19.9") > 0);
		assert.ok(compareVersions("1.19.0", "1.19.3") < 0);
	});

	test("picks the package for this platform and rejects foreign or unverifiable assets", () => {
		const bytes = new Uint8Array([1, 2, 3]);
		assert.strictEqual(parseLatestRelease(release("1.20.0", bytes), "linux", "x64").asset.name, "llama-vscode-chat-v1.20.0-linux-x64.vsix");
		assert.throws(() => parseLatestRelease(release("1.20.0", bytes), "darwin", "arm64"), /no package for darwin-arm64/);
		const foreign = release("1.20.0", bytes); foreign.assets[0].browser_download_url = "https://example.com/evil.vsix";
		assert.throws(() => parseLatestRelease(foreign, "win32", "x64"), /not hosted by this repository/);
		const unsigned = release("1.20.0", bytes); unsigned.assets[0].digest = "";
		assert.throws(() => parseLatestRelease(unsigned, "win32", "x64"), /no SHA-256 digest/);
		assert.throws(() => parseLatestRelease({ ...release("1.20.0", bytes), prerelease: true }, "win32", "x64"), /not a stable version/);
	});

	test("a local development build newer than the release is reported up to date", async () => {
		const messages: string[] = [];
		const updater = new ExtensionUpdater({ state: memento(), storageDir: root, currentVersion: "1.19.3", platform: "win32", arch: "x64", mode: () => "notify",
			fetch: async () => new Response(JSON.stringify(release("1.19.0", new Uint8Array([1])))), ui: ui(messages), now: () => 1000 });
		const status = await updater.check(true);
		assert.strictEqual(status.available, false); assert.strictEqual(status.lastCheckAt, 1000); assert.strictEqual(status.latest?.version, "1.19.0");
		assert.match(messages[0], /1\.19\.3 is up to date \(latest release 1\.19\.0\)/);
		updater.dispose();
	});

	test("installs a verified newer release and asks for a reload", async () => {
		const bytes = new Uint8Array(70_000).map((_, index) => index % 256), installed: string[] = [], messages: string[] = [];
		const updater = new ExtensionUpdater({ state: memento(), storageDir: root, currentVersion: "1.19.3", platform: "win32", arch: "x64", mode: () => "notify",
			fetch: async input => String(input).includes("api.github.com") ? new Response(JSON.stringify(release("1.20.0", bytes))) : new Response(bytes),
			install: async uri => { installed.push(path.basename(uri.fsPath)); assert.deepStrictEqual(await fs.readFile(uri.fsPath), Buffer.from(bytes)); }, ui: ui(messages) });
		assert.strictEqual(await updater.install(true), true);
		assert.deepStrictEqual(installed, ["llama-vscode-chat-v1.20.0-win32-x64.vsix"]);
		const status = updater.status;
		assert.strictEqual(status.installedVersion, "1.20.0"); assert.strictEqual(status.available, false);
		assert.ok(messages.some(message => /1\.20\.0 is installed\. Reload/.test(message)));
		assert.deepStrictEqual((await fs.readdir(path.join(root, "updates"))).filter(name => !name.startsWith("notified-")), [], "downloads and the lock are removed");
		updater.dispose();
	});

	test("a digest mismatch never reaches the VS Code installer", async () => {
		const bytes = new Uint8Array([9, 9, 9]);
		let installs = 0; const messages: string[] = [];
		const updater = new ExtensionUpdater({ state: memento(), storageDir: root, currentVersion: "1.19.3", platform: "linux", arch: "x64", mode: () => "notify",
			fetch: async input => String(input).includes("api.github.com") ? new Response(JSON.stringify(release("1.20.0", bytes, "0".repeat(64)))) : new Response(bytes),
			install: async () => { installs++; }, ui: ui(messages) });
		assert.strictEqual(await updater.install(true), false);
		assert.strictEqual(installs, 0); assert.match(updater.status.error ?? "", /SHA-256 digest does not match/);
		assert.deepStrictEqual(await fs.readdir(path.join(root, "updates")), []);
		updater.dispose();
	});

	test("an automatic check notifies about a version once across windows", async () => {
		const state = memento(), messages: string[] = [];
		const make = () => new ExtensionUpdater({ state, storageDir: root, currentVersion: "1.19.3", platform: "win32", arch: "x64", mode: () => "notify",
			fetch: async () => new Response(JSON.stringify(release("1.20.0", new Uint8Array([1])))), ui: ui(messages) });
		const first = make(), second = make();
		await first.check(false); await second.check(false);
		await new Promise(resolve => setImmediate(resolve));
		assert.strictEqual(messages.filter(message => message.includes("1.20.0 is available")).length, 1);
		first.dispose(); second.dispose();
	});

	test("Quick Access shows the version, last check and update actions", () => {
		const latest = parseLatestRelease(release("1.20.0", new Uint8Array([1])), "win32", "x64");
		const base = { currentVersion: "1.19.3", mode: "notify" as const, checking: false, installing: false };
		const item = buildUpdateItem({ ...base, lastCheckAt: 0, latest, available: true }, 2 * 3_600_000);
		assert.strictEqual(item.description, "v1.19.3 · update 1.20.0 available");
		const children = new Map(item.children!.map(child => [child.id!.replace("llamacpp.quickAccess.", ""), child]));
		assert.strictEqual(children.get("update.current")?.description, "1.19.3");
		assert.strictEqual(children.get("update.lastCheck")?.description, "2 h ago · latest 1.20.0");
		assert.strictEqual(children.get("update.check")?.command?.command, "llamacpp.checkForUpdates");
		assert.strictEqual(children.get("update.install")?.command?.command, "llamacpp.installUpdate");
		assert.strictEqual(children.get("update.mode")?.description, "Notify");
		const never = buildUpdateItem({ ...base, available: false });
		assert.strictEqual(never.description, "v1.19.3 · not checked yet");
		assert.ok(!never.children!.some(child => child.id?.endsWith("update.install")));
		const pending = buildUpdateItem({ ...base, lastCheckAt: 0, latest, available: false, installedVersion: "1.20.0" }, 30_000);
		assert.strictEqual(pending.children!.find(child => child.id?.endsWith("update.reload"))?.command?.command, "workbench.action.reloadWindow");
	});
});
