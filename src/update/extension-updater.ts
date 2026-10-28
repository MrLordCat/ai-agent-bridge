import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as WebReadableStream } from "node:stream/web";
import * as vscode from "vscode";

export const UPDATE_REPOSITORY = "MrLordCat/ai-agent-bridge";
const LATEST_RELEASE_URL = `https://api.github.com/repos/${UPDATE_REPOSITORY}/releases/latest`;
const DOWNLOAD_PREFIX = `https://github.com/${UPDATE_REPOSITORY}/releases/download/`;
const STATE_KEY = "llamacpp.update.state";
export const UPDATE_CHECK_INTERVAL_MS = 5 * 60 * 60_000;
/** Retry delay after a check that never reached GitHub (offline, sleep, DNS). */
export const UPDATE_OFFLINE_RETRY_MS = 30 * 60_000;
/** A manual check within this window reports the last result instead of asking GitHub again. */
export const MANUAL_CHECK_COOLDOWN_MS = 5 * 60_000;
const UPDATE_POLL_MS = 10 * 60_000;
const UPDATE_START_DELAY_MS = 60_000;
const API_TIMEOUT_MS = 15_000;
const DOWNLOAD_TIMEOUT_MS = 10 * 60_000;
const MAX_VSIX_BYTES = 512 * 1024 * 1024;
const INSTALL_LOCK_STALE_MS = 20 * 60_000;

export type AutoUpdateMode = "off" | "notify" | "install";
export const AUTO_UPDATE_MODES: readonly AutoUpdateMode[] = ["notify", "install", "off"];

export interface UpdateRelease {
	version: string;
	tag: string;
	pageUrl: string;
	asset: { name: string; url: string; size: number; sha256: string };
}

export interface UpdateStatus {
	currentVersion: string;
	mode: AutoUpdateMode;
	lastCheckAt?: number;
	latest?: UpdateRelease;
	/** A newer release exists and is not installed yet. */
	available: boolean;
	/** Installed by the updater; the window still runs the old version until reload. */
	installedVersion?: string;
	checking: boolean;
	installing: boolean;
	error?: string;
	/** The last check never reached GitHub; the automatic retry follows after UPDATE_OFFLINE_RETRY_MS. */
	offline?: boolean;
	/** Earliest time a manual check asks GitHub again. */
	manualCheckAt?: number;
}

/** offline: the last check failed before GitHub answered. */
interface StoredState { lastCheckAt?: number; latest?: UpdateRelease; error?: string; installedVersion?: string; offline?: boolean }

class UpdateNetworkError extends Error {}

/** Node reports every network failure as "fetch failed"; the reason is in its cause. */
export function describeNetworkError(error: unknown, timeoutMs = API_TIMEOUT_MS): string {
	if (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")) {
		return `GitHub did not answer within ${Math.round(timeoutMs / 1000)} s.`;
	}
	const cause = error instanceof Error ? (error as { cause?: unknown }).cause : undefined;
	const detail = cause instanceof Error ? cause.message || (cause as NodeJS.ErrnoException).code : undefined;
	const message = error instanceof Error ? error.message : String(error);
	return `Cannot reach GitHub (${detail || message}).`;
}

function formatAgo(ms: number): string {
	return ms < 60_000 ? "just now" : `${Math.floor(ms / 60_000)} min ago`;
}

type Ui = Pick<typeof vscode.window, "showInformationMessage" | "showWarningMessage" | "showErrorMessage">;

export interface ExtensionUpdaterOptions {
	state: Pick<vscode.Memento, "get" | "update">;
	storageDir: string;
	currentVersion: string;
	platform?: string;
	arch?: string;
	fetch?: typeof fetch;
	install?: (vsix: vscode.Uri) => Thenable<unknown>;
	reload?: () => Thenable<unknown>;
	openExternal?: (uri: vscode.Uri) => Thenable<unknown>;
	ui?: Ui;
	log?: (event: string, data?: Record<string, unknown>) => void;
	now?: () => number;
	mode?: () => AutoUpdateMode;
}

/** Stable x.y.z only; pre-release tags are never offered. */
export function parseStableVersion(value: unknown): [number, number, number] | undefined {
	const match = typeof value === "string" ? /^v?(\d{1,6})\.(\d{1,6})\.(\d{1,6})$/.exec(value.trim()) : null;
	return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : undefined;
}

export function compareVersions(left: string, right: string): number {
	const a = parseStableVersion(left), b = parseStableVersion(right);
	if (!a || !b) { return 0; }
	for (let index = 0; index < 3; index++) { if (a[index] !== b[index]) { return a[index] - b[index]; } }
	return 0;
}

export function resolveAutoUpdateMode(config: Pick<vscode.WorkspaceConfiguration, "get"> = vscode.workspace.getConfiguration("llamacpp")): AutoUpdateMode {
	const value = config.get<string>("autoUpdate", "notify");
	return value === "off" || value === "install" ? value : "notify";
}

/** Reads the GitHub "latest release" response and picks the VSIX built for this platform. */
export function parseLatestRelease(json: unknown, platform: string, arch: string): UpdateRelease {
	const release = json as { tag_name?: unknown; html_url?: unknown; draft?: unknown; prerelease?: unknown; assets?: unknown };
	const version = parseStableVersion(release?.tag_name);
	if (!version || release.draft === true || release.prerelease === true) { throw new Error("The latest GitHub release is not a stable version."); }
	const text = version.join(".");
	const name = `llama-vscode-chat-v${text}-${platform}-${arch}.vsix`;
	const asset = (Array.isArray(release.assets) ? release.assets : []).find((item: { name?: unknown }) => item?.name === name) as
		{ browser_download_url?: unknown; size?: unknown; digest?: unknown } | undefined;
	if (!asset) { throw new Error(`Release ${text} has no package for ${platform}-${arch}.`); }
	const url = typeof asset.browser_download_url === "string" ? asset.browser_download_url : "";
	const digest = typeof asset.digest === "string" ? /^sha256:([0-9a-f]{64})$/i.exec(asset.digest)?.[1] : undefined;
	const size = Number(asset.size);
	if (!url.startsWith(DOWNLOAD_PREFIX)) { throw new Error("The release package is not hosted by this repository."); }
	if (!digest) { throw new Error(`Release ${text} publishes no SHA-256 digest for ${name}.`); }
	if (!Number.isSafeInteger(size) || size <= 0 || size > MAX_VSIX_BYTES) { throw new Error(`Release ${text} reports an invalid package size.`); }
	const pageUrl = typeof release.html_url === "string" && release.html_url.startsWith(`https://github.com/${UPDATE_REPOSITORY}/`)
		? release.html_url : `https://github.com/${UPDATE_REPOSITORY}/releases/tag/v${text}`;
	return { version: text, tag: `v${text}`, pageUrl, asset: { name, url, size, sha256: digest.toLowerCase() } };
}

export class ExtensionUpdater implements vscode.Disposable {
	private readonly changes = new vscode.EventEmitter<void>();
	readonly onDidChange = this.changes.event;
	private checking?: Promise<UpdateStatus>;
	private installing?: Promise<boolean>;
	private timer?: ReturnType<typeof setInterval>;
	private startTimer?: ReturnType<typeof setTimeout>;
	private readonly fetch: typeof fetch;
	private readonly ui: Ui;
	private readonly now: () => number;

	constructor(private readonly options: ExtensionUpdaterOptions) {
		this.fetch = options.fetch ?? fetch;
		this.ui = options.ui ?? vscode.window;
		this.now = options.now ?? Date.now;
	}

	private get stored(): StoredState { return this.options.state.get<StoredState>(STATE_KEY) ?? {}; }
	private async store(next: StoredState): Promise<void> { await this.options.state.update(STATE_KEY, next); this.changes.fire(); }
	private get mode(): AutoUpdateMode { return (this.options.mode ?? resolveAutoUpdateMode)(); }

	get status(): UpdateStatus {
		const stored = this.stored, current = this.options.currentVersion;
		const latest = stored.latest && parseStableVersion(stored.latest.version) ? stored.latest : undefined;
		const installedVersion = stored.installedVersion && compareVersions(stored.installedVersion, current) > 0 ? stored.installedVersion : undefined;
		const available = !!latest && compareVersions(latest.version, current) > 0 && latest.version !== installedVersion;
		return { currentVersion: current, mode: this.mode, lastCheckAt: stored.lastCheckAt, latest, available, installedVersion,
			checking: !!this.checking, installing: !!this.installing, error: stored.error, offline: stored.offline,
			manualCheckAt: stored.lastCheckAt === undefined ? undefined : stored.lastCheckAt + MANUAL_CHECK_COOLDOWN_MS };
	}

	/** At most every 5 hours; 30 minutes after a check that never reached GitHub. The state is shared by all windows. */
	automaticCheckDue(): boolean {
		const stored = this.stored;
		return this.mode !== "off" && this.now() - (stored.lastCheckAt ?? 0) >= (stored.offline ? UPDATE_OFFLINE_RETRY_MS : UPDATE_CHECK_INTERVAL_MS);
	}

	/** Automatic checks: shortly after startup, then whenever automaticCheckDue() allows. */
	start(): void {
		const tick = () => { if (this.automaticCheckDue()) { void this.check(false); } };
		this.startTimer = setTimeout(tick, UPDATE_START_DELAY_MS);
		this.timer = setInterval(tick, UPDATE_POLL_MS);
	}

	/** Milliseconds until a manual check may ask GitHub again; 0 when it may now. */
	manualCheckWaitMs(): number {
		const last = this.stored.lastCheckAt, now = this.now();
		return last === undefined || now < last ? 0 : Math.max(0, last + MANUAL_CHECK_COOLDOWN_MS - now);
	}

	check(manual: boolean): Promise<UpdateStatus> {
		if (manual && !this.checking && this.manualCheckWaitMs() > 0) { return Promise.resolve(this.reportRecentCheck()); }
		return this.track(manual, true);
	}

	/** A manual check inside the cooldown repeats the last result without a request. */
	private reportRecentCheck(): UpdateStatus {
		const status = this.status;
		if (status.available && status.latest) { void this.offer(status.latest); return status; }
		const ago = formatAgo(this.now() - (status.lastCheckAt ?? this.now()));
		const wait = Math.max(1, Math.ceil(this.manualCheckWaitMs() / 60_000));
		const result = status.error ? `the check failed: ${status.error}`
			: status.installedVersion ? `${status.installedVersion} is installed, reload the window to use it`
				: `${status.currentVersion} is up to date (latest release ${status.latest?.version ?? "unknown"})`;
		void this.ui.showInformationMessage(`AI Agent Bridge was checked ${ago}: ${result}. The next manual check is possible in ${wait} min.`);
		return status;
	}

	private track(manual: boolean, react: boolean): Promise<UpdateStatus> {
		this.checking ??= this.runCheck(manual, react).finally(() => { this.checking = undefined; this.changes.fire(); });
		this.changes.fire();
		return this.checking;
	}

	private async runCheck(manual: boolean, react: boolean): Promise<UpdateStatus> {
		const previous = this.stored;
		try {
			let response: Response;
			try {
				response = await this.fetch(LATEST_RELEASE_URL, { signal: AbortSignal.timeout(API_TIMEOUT_MS), headers: {
					Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28", "User-Agent": `ai-agent-bridge/${this.options.currentVersion}`,
				} });
			} catch (error) { throw new UpdateNetworkError(describeNetworkError(error)); }
			if (response.status === 403 || response.status === 429) { throw new Error("GitHub rate limit reached; try again later."); }
			if (!response.ok) { throw new Error(`GitHub answered ${response.status}.`); }
			const latest = parseLatestRelease(await response.json(), this.options.platform ?? process.platform, this.options.arch ?? process.arch);
			await this.store({ ...previous, lastCheckAt: this.now(), latest, error: undefined, offline: undefined });
			this.options.log?.("update.check", { manual, current: this.options.currentVersion, latest: latest.version });
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			const offline = error instanceof UpdateNetworkError;
			await this.store({ ...previous, lastCheckAt: this.now(), error: message, offline: offline || undefined });
			this.options.log?.("update.check_failed", { manual, offline, error: message });
			if (manual) { void this.ui.showErrorMessage(`AI Agent Bridge update check failed: ${message}`); }
			return this.status;
		}
		const status = this.status;
		if (!react) { return status; }
		if (status.available && status.latest) {
			if (!manual && this.mode === "install") { void this.install(false); }
			else if (manual || await this.claimNotification(status.latest.version)) { void this.offer(status.latest); }
		} else if (manual) {
			void this.ui.showInformationMessage(status.installedVersion
				? `AI Agent Bridge ${status.installedVersion} is installed. Reload the window to use it.`
				: `AI Agent Bridge ${status.currentVersion} is up to date (latest release ${status.latest?.version ?? "unknown"}).`);
		}
		return status;
	}

	/** One notification per version across all windows. */
	private async claimNotification(version: string): Promise<boolean> {
		const dir = path.join(this.options.storageDir, "updates");
		try {
			await fs.mkdir(dir, { recursive: true });
			await (await fs.open(path.join(dir, `notified-${version}`), "wx")).close();
			return true;
		} catch { return false; }
	}

	private async offer(latest: UpdateRelease): Promise<void> {
		const choice = await this.ui.showInformationMessage(
			`AI Agent Bridge ${latest.version} is available (installed ${this.options.currentVersion}).`, "Install", "Release Notes");
		if (choice === "Install") { await this.install(true); }
		else if (choice === "Release Notes") { await (this.options.openExternal ?? vscode.env.openExternal)(vscode.Uri.parse(latest.pageUrl)); }
	}

	install(manual: boolean): Promise<boolean> {
		this.installing ??= this.runInstall(manual).finally(() => { this.installing = undefined; this.changes.fire(); });
		this.changes.fire();
		return this.installing;
	}

	private async runInstall(manual: boolean): Promise<boolean> {
		let status = this.status;
		if (!status.available && manual && !status.installedVersion && this.manualCheckWaitMs() === 0) { status = await this.track(false, false); }
		const latest = status.latest;
		if (!status.available || !latest) {
			if (manual) { void this.ui.showInformationMessage(status.installedVersion ? `AI Agent Bridge ${status.installedVersion} is already installed. Reload the window to use it.` : "No AI Agent Bridge update is available."); }
			return false;
		}
		const dir = path.join(this.options.storageDir, "updates"), lock = path.join(dir, "install.lock");
		const file = path.join(dir, latest.asset.name), partial = `${file}.part`;
		await fs.mkdir(dir, { recursive: true });
		if (!await this.acquireLock(lock)) {
			if (manual) { void this.ui.showInformationMessage("Another VS Code window is installing the AI Agent Bridge update."); }
			return false;
		}
		try {
			await this.download(latest, partial);
			await fs.rename(partial, file);
			await (this.options.install ?? (uri => vscode.commands.executeCommand("workbench.extensions.installExtension", uri)))(vscode.Uri.file(file));
			await this.store({ ...this.stored, installedVersion: latest.version, error: undefined });
			this.options.log?.("update.installed", { from: this.options.currentVersion, to: latest.version, manual });
			void this.ui.showInformationMessage(`AI Agent Bridge ${latest.version} is installed. Reload the window to use it.`, "Reload Window").then(choice => {
				if (choice === "Reload Window") { void (this.options.reload ?? (() => vscode.commands.executeCommand("workbench.action.reloadWindow")))(); }
			});
			return true;
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			await this.store({ ...this.stored, error: `Install failed: ${message}` });
			this.options.log?.("update.install_failed", { to: latest.version, manual, error: message });
			void this.ui.showErrorMessage(`AI Agent Bridge ${latest.version} was not installed: ${message}`);
			return false;
		} finally {
			await fs.rm(partial, { force: true }).catch(() => undefined);
			await fs.rm(file, { force: true }).catch(() => undefined);
			await fs.rm(lock, { force: true }).catch(() => undefined);
		}
	}

	private async acquireLock(lock: string): Promise<boolean> {
		for (let attempt = 0; attempt < 2; attempt++) {
			try { await (await fs.open(lock, "wx")).close(); return true; } catch {
				const stat = await fs.stat(lock).catch(() => undefined);
				if (stat && this.now() - stat.mtimeMs < INSTALL_LOCK_STALE_MS) { return false; }
				await fs.rm(lock, { force: true }).catch(() => undefined);
			}
		}
		return false;
	}

	private async download(latest: UpdateRelease, target: string): Promise<void> {
		const response = await this.fetch(latest.asset.url, { redirect: "follow", signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
			headers: { "User-Agent": `ai-agent-bridge/${this.options.currentVersion}` } });
		if (!response.ok || !response.body) { throw new Error(`download failed (${response.status}).`); }
		const hash = createHash("sha256");
		let bytes = 0;
		const meter = new Transform({ transform(chunk: Buffer, _encoding, done) {
			bytes += chunk.length;
			if (bytes > latest.asset.size) { done(new Error("the download is larger than the release reports.")); return; }
			hash.update(chunk); done(undefined, chunk);
		} });
		await pipeline(Readable.fromWeb(response.body as WebReadableStream<Uint8Array>), meter, createWriteStream(target, { mode: 0o600 }));
		if (bytes !== latest.asset.size) { throw new Error(`the download is incomplete (${bytes} of ${latest.asset.size} bytes).`); }
		if (hash.digest("hex") !== latest.asset.sha256) { throw new Error("the SHA-256 digest does not match the release."); }
	}

	dispose(): void {
		if (this.timer) { clearInterval(this.timer); }
		if (this.startTimer) { clearTimeout(this.startTimer); }
		this.changes.dispose();
	}
}
