import * as assert from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { findCopilotBundles } from "../copilot-patch";
import {
	agentHostPathFor,
	collectAppRoots,
	collectExtensionRoots,
	commitFromAppRoot,
	findAgentHostBundles,
	findWorkbenchCandidates,
	isWsl,
	workbenchPathFor,
	type SearchOptions,
} from "../vscode-app-root";

const COMMIT = "e4c7e7b1d6d060162f4aa7f8225271b67ce1df75";
const SHORT_COMMIT = "e4c7e7b1d6";

function writeCopilotBundle(root: string): void {
	fs.mkdirSync(path.join(root, "dist"), { recursive: true });
	fs.writeFileSync(path.join(root, "dist", "extension.js"), "// copilot chat bundle\n");
	fs.writeFileSync(
		path.join(root, "package.json"),
		JSON.stringify({ name: "copilot-chat", version: "0.64.1" }, null, 2)
	);
}

function writeWorkbench(appRoot: string): void {
	const workbenchPath = workbenchPathFor(appRoot);
	fs.mkdirSync(path.dirname(workbenchPath), { recursive: true });
	fs.writeFileSync(workbenchPath, "// workbench\n");
}

suite("VS Code application root search", () => {
	let sandbox: string;

	suiteSetup(() => {
		sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "llama-app-root-test-"));
		// A remote server installation: Copilot Chat is bundled, but there is no
		// desktop workbench (the window is rendered elsewhere).
		writeCopilotBundle(path.join(sandbox, "server", "bin", COMMIT, "extensions", "copilot"));
		const agentHost = agentHostPathFor(path.join(sandbox, "server", "bin", COMMIT));
		fs.mkdirSync(path.dirname(agentHost), { recursive: true });
		fs.writeFileSync(agentHost, "// agent host\n");

		// The Windows installation the window actually belongs to, reachable from
		// a WSL extension host through /mnt/c. The installer folder carries the
		// short commit prefix, not the full hash.
		const windowsRoot = path.join(
			sandbox,
			"windows",
			"Users",
			"alice",
			"AppData",
			"Local",
			"Programs",
			"Microsoft VS Code",
			SHORT_COMMIT,
			"resources",
			"app"
		);
		writeCopilotBundle(path.join(windowsRoot, "extensions", "copilot"));
		writeWorkbench(windowsRoot);
		const windowsAgentHost = agentHostPathFor(windowsRoot);
		fs.mkdirSync(path.dirname(windowsAgentHost), { recursive: true });
		fs.writeFileSync(windowsAgentHost, "// agent host\n");

		// A Code - OSS style user installation: Copilot Chat is a normal
		// extension outside any application root.
		writeCopilotBundle(
			path.join(sandbox, "home", ".vscode-oss", "extensions", "github.copilot-chat-0.64.1")
		);
		fs.mkdirSync(path.join(sandbox, "home", ".vscode-server", "extensions"), { recursive: true });
		fs.mkdirSync(path.join(sandbox, "windows", "Users", "alice", ".vscode", "extensions"), { recursive: true });
	});

	suiteTeardown(() => {
		fs.rmSync(sandbox, { recursive: true, force: true });
	});

	function wslOptions(): SearchOptions {
		return {
			home: path.join(sandbox, "home"),
			platform: "linux",
			env: {},
			wsl: true,
			wslWindowsUsers: [path.join(sandbox, "windows", "Users", "alice")],
		};
	}

	test("extracts the commit from both server layouts", () => {
		assert.strictEqual(commitFromAppRoot(`/root/.vscode-server/bin/${COMMIT}`), COMMIT);
		assert.strictEqual(commitFromAppRoot(`/root/.vscode-server/cli/servers/Stable-${COMMIT}/server`), COMMIT);
		assert.strictEqual(commitFromAppRoot("/usr/share/code/resources/app"), undefined);
	});

	test("detects WSL from the environment or the kernel release", () => {
		assert.strictEqual(isWsl({ env: { WSL_DISTRO_NAME: "archlinux" } }), true);
		assert.strictEqual(isWsl({ env: {}, wsl: false }), false);
	});

	test("finds the Windows installation of a WSL session by commit prefix", () => {
		const roots = collectAppRoots(path.join(sandbox, "server", "bin", COMMIT), wslOptions());
		const server = roots.find(entry => entry.root === path.join(sandbox, "server", "bin", COMMIT));
		assert.ok(server, "the active server root must be listed");
		const windows = roots.find(entry => entry.root.includes("Microsoft VS Code"));
		assert.ok(windows, "the Windows installation must be found through the commit prefix");
		assert.match(windows.source, /commit match/);
	});

	test("uses the Windows workbench for a server bundle without one", () => {
		const options = wslOptions();
		const workbenches = findWorkbenchCandidates(path.join(sandbox, "server", "bin", COMMIT), options);
		assert.strictEqual(workbenches.length, 1, "only the Windows installation has a desktop workbench");
		assert.ok(workbenches[0].workbenchPath.includes("Microsoft VS Code"));

		const targets = findCopilotBundles(path.join(sandbox, "server", "bin", COMMIT), options);
		const serverTarget = targets.find(target => target.bundlePath.startsWith(path.join(sandbox, "server")));
		const windowsTarget = targets.find(target => target.bundlePath.includes("Microsoft VS Code"));
		assert.ok(serverTarget, "the server bundle must be found without a local workbench");
		assert.ok(windowsTarget, "the Windows bundle must be found as well");
		assert.strictEqual(
			serverTarget?.workbenchPath,
			workbenches[0].workbenchPath,
			"the server bundle must borrow the workbench of the window"
		);
	});

	test("finds user-installed Copilot Chat outside any application root", () => {
		const targets = findCopilotBundles(undefined, {
			home: path.join(sandbox, "home"),
			platform: "linux",
			env: {},
			wsl: false,
		});
		const userTarget = targets.find(target => target.bundlePath.includes(".vscode-oss"));
		assert.ok(userTarget, "the Code - OSS user extension must be found");
		assert.match(userTarget?.source ?? "", /user extensions/);
		assert.strictEqual(userTarget?.workbenchPath, undefined, "no workbench exists in this sandbox");
	});

	test("finds the agent host bundles of both installations", () => {
		const bundles = findAgentHostBundles(path.join(sandbox, "server", "bin", COMMIT), wslOptions());
		assert.strictEqual(bundles.length, 2, "the server and the Windows installation both ship an agent host");
	});

	test("lists extension directories including the remote server ones", () => {
		const roots = collectExtensionRoots(path.join(sandbox, "server", "bin", COMMIT), wslOptions());
		const paths = roots.map(entry => entry.root);
		assert.ok(paths.includes(path.join(sandbox, "home", ".vscode-server", "extensions")));
		assert.ok(paths.includes(path.join(sandbox, "home", ".vscode-oss", "extensions")));
		assert.ok(paths.includes(path.join(sandbox, "windows", "Users", "alice", ".vscode", "extensions")));
	});
});
