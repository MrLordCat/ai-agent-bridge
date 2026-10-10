import * as fs from "node:fs/promises";
import * as path from "node:path";
import { createHash } from "node:crypto";

export interface UserVsCodeOptions {
	signal?: AbortSignal;
	extensionsDir?: string;
	configHome?: string;
	onProgress?: (files: number) => void;
}

export interface UserVsCodeInstallation {
	installationRoot: string;
	appRoot: string;
	executable: string;
	launcher: string;
	desktopFile: string;
	profileDir: string;
	extensionsDir: string;
	version: string;
	reused: boolean;
}

const MARKER = ".ai-agent-bridge-install.json";

function shellQuote(value: string): string {
	return "'" + value.replace(/'/g, "'\"'\"'") + "'";
}

function desktopQuote(value: string): string {
	return '"' + value.replace(/%/g, "%%").replace(/[\\"\x60$]/g, char => "\\" + char) + '"';
}

async function exists(file: string): Promise<boolean> {
	try { await fs.lstat(file); return true; } catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") { return false; }
		throw error;
	}
}

async function directory(dir: string): Promise<void> {
	await fs.mkdir(dir, { recursive: true, mode: 0o700 });
	if (!(await fs.lstat(dir)).isDirectory()) {
		throw new Error("Expected a directory, not a symlink: " + dir);
	}
}

async function resolveDestination(file: string): Promise<string> {
	try { return await fs.realpath(file); } catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT" || await exists(file)) { throw error; }
		const parent = path.dirname(file);
		if (parent === file) { throw error; }
		return path.join(await resolveDestination(parent), path.basename(file));
	}
}

async function writeLauncher(file: string, content: string, mode: number): Promise<void> {
	if (await exists(file) && !(await fs.lstat(file)).isFile()) {
		throw new Error("Refusing to overwrite a linked launcher: " + file);
	}
	await fs.writeFile(file, content, { mode });
	await fs.chmod(file, mode);
}

/** Copy application files into new, writable files; never retain source symlinks. */
async function copyTree(source: string, destination: string, options: UserVsCodeOptions,
	state: { files: number }, ancestors = new Set<string>()): Promise<void> {
	options.signal?.throwIfAborted();
	const real = await fs.realpath(source), stat = await fs.stat(real);
	if (stat.isDirectory()) {
		if (ancestors.has(real)) { throw new Error("Circular application symlink: " + source); }
		await fs.mkdir(destination, { mode: 0o700 });
		const parents = new Set(ancestors).add(real);
		for (const name of await fs.readdir(real)) {
			await copyTree(path.join(real, name), path.join(destination, name), options, state, parents);
		}
	} else if (stat.isFile()) {
		await fs.copyFile(real, destination);
		// Preserve execute bits, remove setuid/setgid and make the new file writable.
		await fs.chmod(destination, (stat.mode & 0o777) | 0o600);
		if (++state.files % 100 === 0) { options.onProgress?.(state.files); }
	} else {
		throw new Error("Unsupported application file: " + source);
	}
}

/** Prepare a Linux desktop installation; extension directories are referenced, never copied. */
export async function prepareUserVsCode(appRoot: string, home: string,
	options: UserVsCodeOptions = {}): Promise<UserVsCodeInstallation> {
	options.signal?.throwIfAborted();
	const sourceApp = await fs.realpath(appRoot);
	const userHome = await fs.realpath(home);
	if (path.basename(sourceApp) !== "app" || path.basename(path.dirname(sourceApp)) !== "resources") {
		throw new Error("This command needs a local Linux desktop VS Code installation (resources/app).");
	}
	const sourceRoot = path.dirname(path.dirname(sourceApp));
	const product = JSON.parse(await fs.readFile(path.join(sourceApp, "product.json"), "utf8")) as {
		applicationName?: string; commit?: string; dataFolderName?: string;
	};
	const { version } = JSON.parse(await fs.readFile(path.join(sourceApp, "package.json"), "utf8")) as { version: string };
	const application = product.applicationName;
	if (!application || !/^[a-zA-Z0-9_-]+$/.test(application) || !/^\d+\.\d+\.\d+(?:[-.\w]*)$/.test(version)) {
		throw new Error("Cannot identify this VS Code distribution.");
	}
	await fs.access(path.join(sourceRoot, application));
	await fs.access(path.join(sourceRoot, "bin", application));
	await fs.access(path.join(sourceApp, "out/vs/workbench/workbench.desktop.main.js"));
	const identity = product.commit && /^[a-f0-9]{40}$/i.test(product.commit)
		? product.commit : createHash("sha256").update(sourceRoot + version).digest("hex").slice(0, 16);
	const base = await resolveDestination(path.join(userHome, ".local/share/ai-agent-bridge/vscode"));
	const relative = path.relative(sourceRoot, base);
	if (relative !== ".." && !relative.startsWith(".." + path.sep) && !path.isAbsolute(relative)) {
		throw new Error("The user installation must be outside the source application.");
	}
	await directory(base);
	const installationRoot = path.join(base, application + "-" + version + "-" + identity);
	const profileDir = path.join(options.configHome ?? path.join(userHome, ".config"), "ai-agent-bridge-code", application);
	const dataFolder = product.dataFolderName && /^\.[a-zA-Z0-9_-]+$/.test(product.dataFolderName)
		? product.dataFolderName : ".vscode";
	const extensionsDir = options.extensionsDir ?? path.join(userHome, dataFolder, "extensions");
	let reused = false;
	if (await exists(installationRoot)) {
		if (!(await fs.lstat(installationRoot)).isDirectory()) { throw new Error("Refusing a linked installation: " + installationRoot); }
		const marker = JSON.parse(await fs.readFile(path.join(installationRoot, MARKER), "utf8"));
		if (marker.identity !== identity || marker.version !== version) { throw new Error("Unmanaged installation: " + installationRoot); }
		await fs.access(path.join(installationRoot, application));
		reused = true;
	} else {
		const staging = await fs.mkdtemp(path.join(base, ".prepare-"));
		try {
			const state = { files: 0 };
			for (const name of await fs.readdir(sourceRoot)) {
				// Portable profiles may contain credentials, extensions and running-process files.
				if (name === "data" || name === MARKER) { continue; }
				await copyTree(path.join(sourceRoot, name), path.join(staging, name), options, state);
			}
			options.signal?.throwIfAborted();
			await fs.writeFile(path.join(staging, MARKER), JSON.stringify({ identity, version, sourceRoot }), { mode: 0o600 });
			await fs.rename(staging, installationRoot);
		} finally {
			await fs.rm(staging, { recursive: true, force: true });
		}
	}
	options.signal?.throwIfAborted();
	await directory(profileDir);
	const binDir = path.join(userHome, ".local/bin"), desktopDir = path.join(userHome, ".local/share/applications");
	await directory(binDir); await directory(desktopDir);
	const launcher = path.join(binDir, "code-ai-agent-bridge");
	const desktopFile = path.join(desktopDir, "ai-agent-bridge-code.desktop");
	// Separate profile: the CLI must not forward to an already-running system VS Code.
	const cli = path.join(installationRoot, "bin", application);
	await writeLauncher(launcher, "#!/bin/sh\nunset VSCODE_IPC_HOOK_CLI VSCODE_PORTABLE ELECTRON_RUN_AS_NODE\nexec " + shellQuote(cli) + " --user-data-dir " + shellQuote(profileDir)
		+ " --extensions-dir " + shellQuote(extensionsDir) + ' "$@"\n', 0o700);
	await writeLauncher(desktopFile, "[Desktop Entry]\nType=Application\nName=AI Agent Bridge Code\n"
		+ "Comment=User-owned VS Code for AI Agent Bridge\nExec=" + desktopQuote(launcher)
		+ " %F\nTerminal=false\nCategories=Development;IDE;\n", 0o600);
	return { installationRoot, appRoot: path.join(installationRoot, "resources/app"),
		executable: path.join(installationRoot, application), launcher, desktopFile,
		profileDir, extensionsDir, version, reused };
}
