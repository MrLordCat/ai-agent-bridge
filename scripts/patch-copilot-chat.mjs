import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const {
	applyCopilotPatch,
	findCopilotBundle,
	formatCopilotPatchStatus,
	getCopilotPatchStatus,
	restoreCopilotPatch,
} = require("../out/copilot-patch.js");

function parseArgs(argv) {
	const result = { action: "status", root: undefined, force: false };
	for (let index = 0; index < argv.length; index += 1) {
		const value = argv[index];
		if (["apply", "status", "restore"].includes(value)) {
			result.action = value;
		} else if (value === "--root") {
			result.root = argv[index + 1];
			index += 1;
		} else if (value === "--force") {
			result.force = true;
		} else {
			throw new Error(`Unknown argument: ${value}`);
		}
	}
	return result;
}

try {
	const args = parseArgs(process.argv.slice(2));
	const target = findCopilotBundle(args.root);
	if (args.action === "apply") {
		const result = applyCopilotPatch(target, args.force);
		console.log(result.message);
		console.log(formatCopilotPatchStatus(result.status));
	} else if (args.action === "restore") {
		const result = restoreCopilotPatch(target);
		console.log(result.message);
		console.log(formatCopilotPatchStatus(result.status));
	} else {
		console.log(formatCopilotPatchStatus(getCopilotPatchStatus(target)));
	}
} catch (error) {
	console.error(error instanceof Error ? error.message : String(error));
	process.exitCode = 1;
}