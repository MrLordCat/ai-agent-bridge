import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/**
 * Locates VS Code application roots and extension directories for patch code.
 *
 * The extension host does not always run inside the VS Code application whose
 * bundles need patching:
 *  - Remote-WSL: `vscode.env.appRoot` is the Linux server
 *    (`~/.vscode-server/bin/<commit>`), which ships Copilot Chat but has no
 *    `out/vs/workbench/workbench.desktop.main.js`; the window bundle lives in
 *    the Windows installation, reachable through `/mnt/c/...`.
 *  - Remote-SSH/containers: same split, and the extension directories can be
 *    `~/.vscode-server/extensions` instead of `~/.vscode/extensions`.
 *  - Code - OSS / CachyOS: Copilot Chat is a normal user extension under
 *    `~/.vscode-oss/extensions`, outside any application root.
 *
 * Everything here is read-only discovery: it returns paths, it never writes.
 */

export interface RootCandidate {
	root: string;
	source: string;
}

export interface WorkbenchCandidate {
	appRoot: string;
	workbenchPath: string;
	source: string;
}

export interface BundleCandidate {
	bundlePath: string;
	appRoot: string;
	source: string;
}

export interface SearchOptions {
	home?: string;
	platform?: NodeJS.Platform;
	env?: NodeJS.ProcessEnv;
	/** Overrides the WSL detection, for tests. */
	wsl?: boolean;
	/** Overrides the Windows user folder list used under /mnt/c, for tests. */
	wslWindowsUsers?: string[];
}

const WSL_WINDOWS_USER_BLACKLIST = new Set([
	"all users",
	"default",
	"default user",
	"public",
	"wdagutilityaccount",
]);

const USER_EXTENSION_DIRS = [
	".vscode/extensions",
	".vscode-insiders/extensions",
	".vscode-oss/extensions",
	".vscode-oss-insiders/extensions",
	".vscode-server/extensions",
	".vscode-server-insiders/extensions",
];

// Windows user data directories do not hold extensions on Linux, but a WSL
// extension host can read the Windows user installation to patch its bundles.
const LINUX_APPLICATION_DIRS = [
	"/usr/share/code",
	"/usr/lib/code",
	"/usr/share/code-insiders",
	"/usr/lib/code-insiders",
	"/opt/visual-studio-code",
	"/opt/visual-studio-code-insiders",
	"/snap/code/current/usr/share/code",
	"/var/lib/flatpak/app/com.visualstudio.code/current/active/files/share/code",
	"/usr/local/share/code",
];

function isDirectory(candidate: string | undefined): boolean {
	if (!candidate) {
		return false;
	}
	try {
		return fs.statSync(candidate).isDirectory();
	} catch {
		return false;
	}
}

export function isWsl(options: SearchOptions = {}): boolean {
	if (options.wsl !== undefined) {
		return options.wsl;
	}
	const env = options.env ?? process.env;
	if (env.WSL_DISTRO_NAME || env.WSL_INTEROP) {
		return true;
	}
	if ((options.platform ?? process.platform) !== "linux") {
		return false;
	}
	try {
		return /microsoft/i.test(fs.readFileSync("/proc/sys/kernel/osrelease", "utf8"));
	} catch {
		return false;
	}
}

/**
 * Extracts the VS Code commit from an app root or server path, so a WSL
 * extension host can target the matching Windows installation:
 * `~/.vscode-server/bin/<commit>` and
 * `~/.vscode-server/cli/servers/Stable-<commit>/server` both carry it.
 */
export function commitFromAppRoot(appRoot: string): string | undefined {
	const stable = appRoot.match(/(?:stable|insiders)-([0-9a-f]{10,40})/i);
	if (stable) {
		return stable[1];
	}
	const bin = appRoot.match(/[\\/]bin[\\/]([0-9a-f]{10,40})(?:[\\/]|$)/i);
	if (bin) {
		return bin[1];
	}
	return undefined;
}

function appRootMarkers(root: string): string[] {
	return [
		path.join(root, "out", "vs", "workbench"),
		path.join(root, "out", "vs", "platform", "agentHost"),
		path.join(root, "extensions", "copilot"),
		path.join(root, "resources", "app", "extensions", "copilot"),
	];
}

export function looksLikeAppRoot(root: string): boolean {
	if (!isDirectory(root)) {
		return false;
	}
	return appRootMarkers(root).some(marker => fs.existsSync(marker));
}

function pushAppRoot(out: RootCandidate[], candidate: string | undefined, source: string): void {
	if (!candidate) {
		return;
	}
	const resolved = path.resolve(candidate);
	for (const variant of [resolved, path.join(resolved, "resources", "app")]) {
		if (looksLikeAppRoot(variant) && !out.some(entry => entry.root === variant)) {
			out.push({ root: variant, source });
		}
	}
}

/**
 * A Windows VS Code installation keeps the application under a commit-named
 * folder (`Microsoft VS Code/<commit>/resources/app`). The commit is preferred
 * when it is known, because it pins the build the running window belongs to.
 */
function pushWindowsInstallRoot(
	out: RootCandidate[],
	installRoot: string | undefined,
	source: string,
	commit?: string
): void {
	if (!installRoot || !isDirectory(installRoot)) {
		return;
	}
	pushAppRoot(out, installRoot, source);
	if (commit) {
		pushAppRoot(out, path.join(installRoot, commit, "resources", "app"), `${source} (commit match)`);
	}
	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(installRoot, { withFileTypes: true });
	} catch {
		return;
	}
	for (const entry of entries) {
		if (!entry.isDirectory()) {
			continue;
		}
		// The Windows installer names the application folder after a short
		// prefix of the commit (for example `e4c7e7b1d6`).
		const matchesCommit = Boolean(commit && commit.toLowerCase().startsWith(entry.name.toLowerCase()));
		pushAppRoot(
			out,
			path.join(installRoot, entry.name, "resources", "app"),
			matchesCommit ? `${source} (commit match)` : source
		);
	}
}

export function wslWindowsUserDirectories(options: SearchOptions = {}): string[] {
	if (options.wslWindowsUsers) {
		return options.wslWindowsUsers.slice();
	}
	const usersRoot = "/mnt/c/Users";
	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(usersRoot, { withFileTypes: true });
	} catch {
		return [];
	}
	return entries
		.filter(entry => entry.isDirectory() && !WSL_WINDOWS_USER_BLACKLIST.has(entry.name.toLowerCase()))
		.map(entry => path.join(usersRoot, entry.name));
}

function pushWindowsFromWsl(out: RootCandidate[], explicitRoot: string | undefined, options: SearchOptions): void {
	const commit = explicitRoot ? commitFromAppRoot(explicitRoot) : undefined;
	const installRoots: Array<{ root: string; source: string }> = [];
	for (const userDir of wslWindowsUserDirectories(options)) {
		const programs = path.join(userDir, "AppData", "Local", "Programs");
		installRoots.push(
			{ root: path.join(programs, "Microsoft VS Code"), source: "windows user installation" },
			{ root: path.join(programs, "Microsoft VS Code Insiders"), source: "windows user installation" }
		);
	}
	for (const programsRoot of ["/mnt/c/Program Files", "/mnt/c/Program Files (x86)"]) {
		installRoots.push(
			{ root: path.join(programsRoot, "Microsoft VS Code"), source: "windows system installation" },
			{ root: path.join(programsRoot, "Microsoft VS Code Insiders"), source: "windows system installation" }
		);
	}
	for (const { root, source } of installRoots) {
		pushWindowsInstallRoot(out, root, source, commit);
	}
}

function pushWindowsFromWhere(out: RootCandidate[], commit?: string): void {
	let output: string;
	try {
		output = execFileSync("where.exe", ["code.cmd"], { encoding: "utf8" });
	} catch {
		return;
	}
	for (const commandPath of output.split(/\r?\n/).filter(Boolean)) {
		const installRoot = path.dirname(path.dirname(commandPath.trim()));
		pushWindowsInstallRoot(out, installRoot, "code.cmd", commit);
	}
}

/**
 * `code.cmd` is not on PATH on many Windows machines (the installer checkbox
 * is off by default), so the standard installation folders are probed too.
 */
function pushWindowsFromEnvironment(out: RootCandidate[], options: SearchOptions, commit?: string): void {
	const env = options.env ?? process.env;
	const candidates: Array<{ root: string; source: string }> = [];
	const localAppData = env.LOCALAPPDATA;
	if (localAppData) {
		const programs = path.join(localAppData, "Programs");
		candidates.push(
			{ root: path.join(programs, "Microsoft VS Code"), source: "windows user installation" },
			{ root: path.join(programs, "Microsoft VS Code Insiders"), source: "windows user installation" }
		);
	}
	for (const programFiles of [env.ProgramFiles, env["ProgramFiles(x86)"]]) {
		if (!programFiles) {
			continue;
		}
		candidates.push(
			{ root: path.join(programFiles, "Microsoft VS Code"), source: "windows system installation" },
			{ root: path.join(programFiles, "Microsoft VS Code Insiders"), source: "windows system installation" }
		);
	}
	for (const { root, source } of candidates) {
		pushWindowsInstallRoot(out, root, source, commit);
	}
}

/**
 * Application roots, best match first: the running build, an explicit
 * `VSCODE_APP_ROOT`, the platform's standard installations, and - from a WSL
 * extension host - the matching Windows installation.
 */
export function collectAppRoots(explicitRoot?: string, options: SearchOptions = {}): RootCandidate[] {
	const out: RootCandidate[] = [];
	const platform = options.platform ?? process.platform;
	const env = options.env ?? process.env;
	const commit = explicitRoot ? commitFromAppRoot(explicitRoot) : undefined;

	pushAppRoot(out, explicitRoot, "active window");
	pushAppRoot(out, env.VSCODE_APP_ROOT, "VSCODE_APP_ROOT");

	if (platform === "win32") {
		pushWindowsFromEnvironment(out, options, commit);
		pushWindowsFromWhere(out, commit);
	} else {
		for (const dir of LINUX_APPLICATION_DIRS) {
			pushAppRoot(out, dir, "standard installation");
			pushAppRoot(out, path.join(dir, "resources", "app"), "standard installation");
		}
	}

	if (isWsl(options)) {
		pushWindowsFromWsl(out, explicitRoot, options);
	}

	return out;
}

function pushExtensionRoot(out: RootCandidate[], candidate: string | undefined, source: string): void {
	if (!candidate || !isDirectory(candidate)) {
		return;
	}
	const resolved = path.resolve(candidate);
	if (!out.some(entry => entry.root === resolved)) {
		out.push({ root: resolved, source });
	}
}

/**
 * Directories that can hold a user-installed Copilot Chat. A remote extension
 * host keeps its extensions in `~/.vscode-server/extensions`, and a WSL host
 * may also see the Windows side under `/mnt/c/Users/<user>/.vscode/...`.
 */
export function collectExtensionRoots(explicitRoot?: string, options: SearchOptions = {}): RootCandidate[] {
	const out: RootCandidate[] = [];
	const home = options.home ?? os.homedir();

	for (const relative of USER_EXTENSION_DIRS) {
		pushExtensionRoot(out, path.join(home, relative), "user extensions");
	}
	if (isWsl(options)) {
		for (const userDir of wslWindowsUserDirectories(options)) {
			for (const relative of [".vscode/extensions", ".vscode-insiders/extensions", ".vscode-oss/extensions"]) {
				pushExtensionRoot(out, path.join(userDir, relative), "windows user extensions");
			}
		}
	}
	for (const { root, source } of collectAppRoots(explicitRoot, options)) {
		pushExtensionRoot(out, path.join(root, "extensions"), `${source} built-in extensions`);
	}
	return out;
}

export function workbenchPathFor(appRoot: string): string {
	return path.join(appRoot, "out", "vs", "workbench", "workbench.desktop.main.js");
}

export function agentHostPathFor(appRoot: string): string {
	return path.join(appRoot, "out", "vs", "platform", "agentHost", "node", "agentHostMain.js");
}

export function findWorkbenchCandidates(explicitRoot?: string, options: SearchOptions = {}): WorkbenchCandidate[] {
	const out: WorkbenchCandidate[] = [];
	for (const { root, source } of collectAppRoots(explicitRoot, options)) {
		const workbenchPath = workbenchPathFor(root);
		if (fs.existsSync(workbenchPath) && !out.some(entry => entry.workbenchPath === workbenchPath)) {
			out.push({ appRoot: root, workbenchPath, source });
		}
	}
	return out;
}

export function findAgentHostBundles(explicitRoot?: string, options: SearchOptions = {}): BundleCandidate[] {
	const out: BundleCandidate[] = [];
	for (const { root, source } of collectAppRoots(explicitRoot, options)) {
		const bundlePath = agentHostPathFor(root);
		if (fs.existsSync(bundlePath) && !out.some(entry => entry.bundlePath === bundlePath)) {
			out.push({ bundlePath, appRoot: root, source });
		}
	}
	return out;
}

/** True when the process can write the file (used to plan elevation only). */
export function isWritable(filePath: string): boolean {
	try {
		fs.accessSync(filePath, fs.constants.W_OK);
		return true;
	} catch {
		return false;
	}
}
