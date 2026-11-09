import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// The elevated patch runner loads this module in plain Node: it must not import vscode.

const LOCK_SUFFIX = ".llama-vscode-chat.lock";
/** A lock older than this belongs to a process that died while patching. */
const LOCK_STALE_MS = 120_000;
const RENAME_RETRY_CODES = new Set(["EPERM", "EACCES", "EBUSY"]);

/** Another process holds the patch lock; the caller should retry later. */
export class PatchBusyError extends Error {}

/**
 * Serialises patching of one file across VS Code windows and processes. Two
 * windows that start after an update would otherwise both copy the bundle to
 * the backup, and the slower one copies a file the faster one already patched.
 */
export function withPatchLock<T>(filePath: string, action: () => T): T {
	const lockPath = filePath + LOCK_SUFFIX;
	let descriptor: number | undefined;
	for (let attempt = 0; attempt < 2 && descriptor === undefined; attempt++) {
		try {
			descriptor = fs.openSync(lockPath, "wx");
		} catch (error) {
			const code = (error as NodeJS.ErrnoException).code;
			if (code === "EPERM" || code === "EACCES" || code === "EROFS") {
				// A read-only installation: the writes below fail with the same
				// permission error, which drives the permission recovery flow.
				return action();
			}
			if (code !== "EEXIST") {
				throw error;
			}
			let age: number;
			try {
				age = Date.now() - fs.statSync(lockPath).mtimeMs;
			} catch {
				continue;
			}
			if (age < LOCK_STALE_MS) {
				break;
			}
			fs.rmSync(lockPath, { force: true });
		}
	}
	if (descriptor === undefined) {
		throw new PatchBusyError(`Another VS Code process is patching ${path.basename(filePath)} (${lockPath}).`);
	}
	try {
		fs.writeSync(descriptor, `${process.pid}\n`);
		return action();
	} finally {
		fs.closeSync(descriptor);
		fs.rmSync(lockPath, { force: true });
	}
}

/** Takes the lock of every existing file, in order; a missing file needs none. */
export function withPatchLocks<T>(filePaths: readonly (string | undefined)[], action: () => T): T {
	const unique = [...new Set(filePaths.filter((file): file is string => Boolean(file && fs.existsSync(file))).map(file => path.resolve(file)))];
	return unique.reduceRight<() => T>((next, file) => () => withPatchLock(file, next), action)();
}

function sleepSync(milliseconds: number): void {
	Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

/**
 * Replaces a file through a temporary sibling and a rename, so an interrupted
 * write leaves the old or the new bundle and never a truncated one.
 */
export function writeFileAtomic(filePath: string, data: string | Uint8Array): void {
	const target = fs.existsSync(filePath) ? fs.realpathSync(filePath) : filePath;
	let existing: fs.Stats | undefined;
	try {
		existing = fs.statSync(target);
	} catch {
		existing = undefined;
	}
	if (existing) {
		// A rename only needs a writable directory; a read-only file must stay as protected as before.
		fs.accessSync(target, fs.constants.W_OK);
	}
	const temporary = `${target}.llama-vscode-chat.tmp-${process.pid}-${randomBytes(4).toString("hex")}`;
	try {
		fs.writeFileSync(temporary, data, { flag: "wx" });
		if (existing) {
			fs.chmodSync(temporary, existing.mode & 0o777);
			if (process.getuid?.() === 0) {
				// The elevated runner also writes user-owned Copilot bundles.
				fs.chownSync(temporary, existing.uid, existing.gid);
			}
		}
		for (let attempt = 0; ; attempt++) {
			try {
				fs.renameSync(temporary, target);
				return;
			} catch (error) {
				const code = (error as NodeJS.ErrnoException).code ?? "";
				if (process.platform !== "win32" || !RENAME_RETRY_CODES.has(code)) {
					throw error;
				}
				if (attempt < 3) {
					sleepSync(100 * (attempt + 1));
					continue;
				}
				// Windows cannot replace a file another process keeps open without delete sharing.
				fs.writeFileSync(target, data);
				return;
			}
		}
	} finally {
		fs.rmSync(temporary, { force: true });
	}
}

/** Runs `node --check` on an ES module source and throws with the parser message. */
export function checkModuleSyntax(source: string, fileName = "bundle.mjs"): void {
	const directory = fs.mkdtempSync(path.join(os.tmpdir(), "ai-agent-bridge-patch-check-"));
	const file = path.join(directory, fileName);
	try {
		fs.writeFileSync(file, source, { mode: 0o600 });
		// The extension host runs on the Electron binary, which only behaves as Node with this variable.
		execFileSync(process.execPath, ["--check", file], {
			stdio: "pipe",
			env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
		});
	} catch (error) {
		const stderr = (error as { stderr?: Buffer | string }).stderr?.toString().trim();
		throw new Error(stderr || (error instanceof Error ? error.message : String(error)), { cause: error });
	} finally {
		fs.rmSync(directory, { recursive: true, force: true });
	}
}

/** The VS Code build (product.json commit) that ships a file, if the file is inside an installation. */
export function installationBuild(filePath: string): string | undefined {
	let directory = path.dirname(path.resolve(filePath));
	for (let depth = 0; depth < 6; depth++) {
		try {
			const product = JSON.parse(fs.readFileSync(path.join(directory, "product.json"), "utf8")) as { commit?: unknown };
			if (typeof product.commit === "string" && product.commit) {
				return product.commit;
			}
		} catch {
			// Not the application root; keep walking up.
		}
		const parent = path.dirname(directory);
		if (parent === directory) {
			break;
		}
		directory = parent;
	}
	return undefined;
}

export function readPatchMetadata(metadataPath: string): Record<string, unknown> | undefined {
	try {
		const value = JSON.parse(fs.readFileSync(metadataPath, "utf8")) as unknown;
		return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
	} catch {
		return undefined;
	}
}
