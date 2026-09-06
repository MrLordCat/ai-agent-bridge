import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

const require = createRequire(import.meta.url);
const {
	patchCopilotBundle,
	patchAgentHistoryCap,
	patchVsCodeWorkbenchBundle,
	patchCopilotGitRepositoriesGuard,
} = require("../out/copilot-patch.js");

// Defaults to the CachyOS/Arch VS Code install; override with `--root` or
// VSCODE_ROOT for other locations.
const bundledArg = process.argv.findIndex((arg) => arg === "--root");
const root =
	(bundledArg >= 0 ? process.argv[bundledArg + 1] : undefined) ??
	process.env.VSCODE_ROOT ??
	"/usr/lib/code";
const bundlePath = path.join(root, "extensions", "copilot", "dist", "extension.js");
const workbenchPath = path.join(root, "out", "vs", "workbench", "workbench.desktop.main.js");
const source = fs.readFileSync(bundlePath, "utf8");
const workbenchSource = fs.readFileSync(workbenchPath, "utf8");
const steps = [
	["patchCopilotBundle", () => patchCopilotBundle(source)],
	["patchAgentHistoryCap", () => patchAgentHistoryCap(source)],
	["patchVsCodeWorkbenchBundle", () => patchVsCodeWorkbenchBundle(workbenchSource)],
	["patchCopilotGitRepositoriesGuard", () => patchCopilotGitRepositoriesGuard(source)],
];
let failed = false;
for (const [name, fn] of steps) {
	try {
		fn();
		console.log(`OK ${name}`);
	} catch (e) {
		failed = true;
		console.error(`FAIL ${name}: ${e.message}`);
	}
}
process.exit(failed ? 1 : 0);
