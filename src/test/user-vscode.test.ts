import * as assert from "node:assert";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import { prepareUserVsCode } from "../user-vscode";

suite("User-owned VS Code preparation", () => {
	let sandbox: string, root: string, appRoot: string, home: string;
	setup(async () => {
		sandbox = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "bridge-user-code-")));
		root = path.join(sandbox, "system"); appRoot = path.join(root, "resources/app");
		home = path.join(sandbox, "home with ' quote");
		await fs.mkdir(home);
		await fs.mkdir(path.join(appRoot, "out/vs/workbench"), { recursive: true });
		await fs.mkdir(path.join(root, "bin"), { recursive: true });
		await fs.writeFile(path.join(appRoot, "product.json"), JSON.stringify({
			applicationName: "code", commit: "a".repeat(40), dataFolderName: ".vscode",
		}));
		await fs.writeFile(path.join(appRoot, "package.json"), JSON.stringify({ version: "1.141.0" }));
		await fs.writeFile(path.join(appRoot, "out/vs/workbench/workbench.desktop.main.js"), "original");
		await fs.writeFile(path.join(root, "code"), "binary");
		await fs.writeFile(path.join(root, "bin/code"), '#!/bin/sh\nprintf "%s\\n" "$@"\n', { mode: 0o755 });
		await fs.mkdir(path.join(root, "data/extensions/private"), { recursive: true });
		await fs.writeFile(path.join(root, "data/extensions/private/token"), "do not copy");
	});
	teardown(async () => { await fs.rm(sandbox, { recursive: true, force: true }); });

	test("copies the application while sharing extensions and isolating the profile", async () => {
		const extensions = path.join(home, "custom extensions"), result = await prepareUserVsCode(appRoot, home, { extensionsDir: extensions });
		assert.strictEqual(result.extensionsDir, extensions);
		assert.strictEqual(result.reused, false);
		const bundle = path.join(result.appRoot, "out/vs/workbench/workbench.desktop.main.js");
		await fs.writeFile(bundle, "patched");
		assert.strictEqual(await fs.readFile(path.join(appRoot, "out/vs/workbench/workbench.desktop.main.js"), "utf8"), "original");
		await assert.rejects(fs.access(path.join(result.installationRoot, "data")));
		await assert.rejects(fs.access(extensions));
		assert.ok(result.profileDir.startsWith(home));
		const launcher = await fs.readFile(result.launcher, "utf8");
		assert.ok(launcher.includes("--user-data-dir") && launcher.includes("--extensions-dir"));
	});

	test("reuses the same commit without overwriting patches", async () => {
		const first = await prepareUserVsCode(appRoot, home);
		await fs.writeFile(path.join(first.installationRoot, "code"), "patched");
		const next = await prepareUserVsCode(appRoot, home);
		assert.strictEqual(next.reused, true);
		assert.strictEqual(next.installationRoot, first.installationRoot);
		assert.strictEqual(await fs.readFile(next.executable, "utf8"), "patched");
		const fromCopy = await prepareUserVsCode(next.appRoot, home);
		assert.strictEqual(fromCopy.reused, true);
		assert.strictEqual(fromCopy.installationRoot, first.installationRoot);
	});

	test("cancellation cleans partial copies and leaves the original intact", async () => {
		for (let i = 0; i < 110; i++) { await fs.writeFile(path.join(root, "extra-" + i), "file"); }
		const abort = new AbortController();
		await assert.rejects(prepareUserVsCode(appRoot, home, {
			signal: abort.signal, onProgress: () => abort.abort(),
		}), error => error instanceof Error && error.name === "AbortError");
		assert.deepStrictEqual(await fs.readdir(path.join(home, ".local/share/ai-agent-bridge/vscode")), []);
		assert.strictEqual(await fs.readFile(path.join(root, "code"), "utf8"), "binary");
	});

	test("rejects a server installation and a destination inside the source", async () => {
		await assert.rejects(prepareUserVsCode(root, home), /local Linux desktop/);
		await assert.rejects(prepareUserVsCode(appRoot, root), /outside the source/);
		if (process.platform !== "win32") {
			await fs.mkdir(path.join(home, ".local"));
			await fs.symlink(root, path.join(home, ".local/share"));
			await assert.rejects(prepareUserVsCode(appRoot, home), /outside the source/);
			await assert.rejects(fs.access(path.join(root, "ai-agent-bridge")));
		}
	});

	test("does not replace an unmarked existing installation", async () => {
		const target = path.join(home, ".local/share/ai-agent-bridge/vscode/code-1.141.0-" + "a".repeat(40));
		await fs.mkdir(target, { recursive: true });
		await fs.writeFile(path.join(target, "keep"), "user data");
		await assert.rejects(prepareUserVsCode(appRoot, home));
		assert.strictEqual(await fs.readFile(path.join(target, "keep"), "utf8"), "user data");
	});

	test("dereferences application links and makes read-only source files writable", async function () {
		if (process.platform === "win32") { this.skip(); return; }
		await fs.writeFile(path.join(root, "shared"), "original", { mode: 0o444 });
		await fs.symlink("shared", path.join(root, "linked"));
		const result = await prepareUserVsCode(appRoot, home);
		assert.strictEqual((await fs.lstat(path.join(result.installationRoot, "linked"))).isSymbolicLink(), false);
		await fs.writeFile(path.join(result.installationRoot, "linked"), "patched");
		assert.strictEqual(await fs.readFile(path.join(root, "shared"), "utf8"), "original");
		const output = execFileSync(result.launcher, ["folder with spaces"], { encoding: "utf8" }).trim().split("\n");
		assert.deepStrictEqual(output, ["--user-data-dir", result.profileDir, "--extensions-dir", result.extensionsDir, "folder with spaces"]);
	});

	test("does not follow an existing launcher symlink", async function () {
		if (process.platform === "win32") { this.skip(); return; }
		await fs.mkdir(path.join(home, ".local/bin"), { recursive: true });
		await fs.symlink(path.join(root, "code"), path.join(home, ".local/bin/code-ai-agent-bridge"));
		await assert.rejects(prepareUserVsCode(appRoot, home), /linked launcher/);
		assert.strictEqual(await fs.readFile(path.join(root, "code"), "utf8"), "binary");
	});
});
