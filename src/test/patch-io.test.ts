import * as assert from "assert";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { PatchBusyError, checkModuleSyntax, installationBuild, withPatchLocks, writeFileAtomic } from "../patch-io";

suite("Patch file operations", () => {
	let dir: string;
	setup(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), "patch-io-")); });
	teardown(() => { fs.rmSync(dir, { recursive: true, force: true }); });

	const leftovers = (): string[] => fs.readdirSync(dir).filter(name => name.includes(".llama-vscode-chat."));

	test("replaces a file without leaving temporary files and keeps its mode", () => {
		const file = path.join(dir, "bundle.js");
		fs.writeFileSync(file, "old");
		if (process.platform !== "win32") { fs.chmodSync(file, 0o640); }
		writeFileAtomic(file, "new");
		assert.strictEqual(fs.readFileSync(file, "utf8"), "new");
		assert.deepStrictEqual(leftovers(), []);
		if (process.platform !== "win32") { assert.strictEqual(fs.statSync(file).mode & 0o777, 0o640); }
		writeFileAtomic(path.join(dir, "created.json"), "{}");
		assert.strictEqual(fs.readFileSync(path.join(dir, "created.json"), "utf8"), "{}");
	});

	test("leaves a read-only file untouched", function () {
		if (process.getuid?.() === 0) { this.skip(); return; }
		const file = path.join(dir, "workbench.js");
		fs.writeFileSync(file, "original");
		fs.chmodSync(file, 0o444);
		try {
			assert.throws(() => writeFileAtomic(file, "patched"), /EACCES|EPERM|permission/i);
			assert.strictEqual(fs.readFileSync(file, "utf8"), "original");
			assert.deepStrictEqual(leftovers(), []);
		} finally {
			fs.chmodSync(file, 0o644);
		}
	});

	test("takes each distinct lock once and reports a held one as busy", () => {
		const first = path.join(dir, "a.js"), second = path.join(dir, "b.js");
		fs.writeFileSync(first, ""); fs.writeFileSync(second, "");
		const result = withPatchLocks([first, first, undefined, path.join(dir, "missing.js"), second], () => {
			assert.ok(fs.existsSync(first + ".llama-vscode-chat.lock"));
			assert.ok(fs.existsSync(second + ".llama-vscode-chat.lock"));
			return 42;
		});
		assert.strictEqual(result, 42);
		assert.deepStrictEqual(leftovers(), []);

		fs.writeFileSync(second + ".llama-vscode-chat.lock", "4242\n");
		assert.throws(() => withPatchLocks([first, second], () => 0), (error: unknown) => error instanceof PatchBusyError);
		assert.ok(!fs.existsSync(first + ".llama-vscode-chat.lock"), "the outer lock is released");
	});

	test("reports the parser message of an invalid module", function () {
		this.timeout(30_000);
		checkModuleSyntax("export const ok = 1;");
		assert.throws(() => checkModuleSyntax("export const = 1;"), /SyntaxError/);
	});

	test("reads the VS Code build from the installation that ships a file", () => {
		const root = path.join(dir, "app");
		const file = path.join(root, "out", "vs", "workbench", "workbench.desktop.main.js");
		fs.mkdirSync(path.dirname(file), { recursive: true });
		fs.writeFileSync(path.join(root, "product.json"), JSON.stringify({ commit: "abc123" }));
		assert.strictEqual(installationBuild(file), "abc123");
	});
});
