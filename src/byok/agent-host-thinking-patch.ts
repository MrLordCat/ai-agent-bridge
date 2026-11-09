import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";
import { checkModuleSyntax, installationBuild, readPatchMetadata, withPatchLock, writeFileAtomic } from "../patch-io";
import { findAgentHostBundles } from "../vscode-app-root";

/**
 * Patches the VS Code agent-host bundle so BYOK models get a thinking-level
 * picker in the Agents Window model selector.
 *
 * VS Code 1.131 mechanics (verified 2026-08-15 in the installed bundle):
 *  - agentHostMain.js `_refreshByokModels` builds the snapshot model for every
 *    BYOK model without a `configSchema`, so the UI has no thinking option.
 *  - Native models carry a `configSchema` whose `thinkingLevel` property
 *    (enum low|medium|high|xhigh) is rendered as a picker, stored in the
 *    session config, and forwarded to the model provider as
 *    modelOptions.reasoningEffort (llama-vscode-chat normalizes those levels).
 */
export const AGENT_HOST_THINKING_PATCH_ID = "llama-vscode-chat:agent-host-thinking-levels:v1";
export const AGENT_HOST_THINKING_PATCH_MARKER = `/* ${AGENT_HOST_THINKING_PATCH_ID} */`;
export const AGENT_HOST_NON_STREAMING_PATCH_ID = "llama-vscode-chat:agent-host-non-streaming:v1";
export const AGENT_HOST_NON_STREAMING_PATCH_MARKER = `/* ${AGENT_HOST_NON_STREAMING_PATCH_ID} */`;
export const AGENT_HOST_REASONING_EFFORT_PATCH_ID = "llama-vscode-chat:agent-host-reasoning-effort:v1";
export const AGENT_HOST_REASONING_EFFORT_PATCH_MARKER = `/* ${AGENT_HOST_REASONING_EFFORT_PATCH_ID} */`;
/** Every marker this module writes starts with this. */
const AGENT_HOST_MARKER_PREFIX = "/* llama-vscode-chat:agent-host-";

const BYOK_SNAPSHOT_PATTERN = "maxContextWindow:e.maxContextWindowTokens,supportsVision:e.supportsVision??!1,...t&&{_meta:t}}}";

// VS Code 1.131's ByokLmProxyService always answers with SSE, even when the
// SDK sends a non-streaming request (stream omitted or stream:false), which
// makes the native Copilot SDK fail with "non-streaming response body was not
// valid JSON". This patch answers those requests with a JSON chat.completion.
const PROXY_NON_STREAMING_PATTERN = `if(u.error){this._writeJsonError(t,502,u.error,"api_error");return}t.writeHead(200,{"Content-Type":"text/event-stream","Cache-Control":"no-cache",Connection:"keep-alive"});`;

const PROXY_NON_STREAMING_JSON_BRANCH =
	`if(u.error){this._writeJsonError(t,502,u.error,"api_error");return}` +
	AGENT_HOST_NON_STREAMING_PATCH_MARKER +
	`if(s.stream!==!0){let g={role:"assistant",content:u.content??null};u.toolCalls&&u.toolCalls.length>0&&(g.tool_calls=u.toolCalls.map((d,c)=>({index:c,id:d.id,type:"function",function:{name:d.name,arguments:d.argumentsJson}})));let v={id:K8(),object:"chat.completion",created:Math.floor(Date.now()/1e3),model:a.modelId,choices:[{index:0,message:g,finish_reason:u.toolCalls&&u.toolCalls.length>0?"tool_calls":"stop"}],...(u.usage?{usage:{prompt_tokens:u.usage.promptTokens??0,completion_tokens:u.usage.completionTokens??0,total_tokens:(u.usage.promptTokens??0)+(u.usage.completionTokens??0)}}:{})};t.writeHead(200,{"Content-Type":"application/json"});t.end(JSON.stringify(v));return}t.writeHead(200,{"Content-Type":"text/event-stream","Cache-Control":"no-cache",Connection:"keep-alive"});`;

// The proxy drops reasoning_effort from the SDK body; forward it so the model
// provider can honour the thinking-level picker.
const PROXY_REASONING_EFFORT_PATTERN = `typeof n.max_tokens=="number"&&(i.max_tokens=n.max_tokens),{vendor:r,modelId:e,messages:o,tools:j8(n.tools),modelOptions:Object.keys(i).length?i:void 0}`;

const PROXY_REASONING_EFFORT_PATCHED =
	`typeof n.max_tokens=="number"&&(i.max_tokens=n.max_tokens),` +
	AGENT_HOST_REASONING_EFFORT_PATCH_MARKER +
	`typeof n.reasoning_effort=="string"&&(i.reasoningEffort=n.reasoning_effort),{vendor:r,modelId:e,messages:o,tools:j8(n.tools),modelOptions:Object.keys(i).length?i:void 0}`;

const THINKING_LEVEL_CONFIG_SCHEMA =
	`{type:"object",properties:{thinkingLevel:{type:"string",title:"Thinking level",` +
	`description:"Controls how much the model reasons before responding.",` +
	`enum:["low","medium","high","xhigh"],enumLabels:["Low","Medium","High","Extra high"],` +
	`enumDescriptions:["Minimal reasoning for fast responses","Balanced reasoning","Deep reasoning","Maximum reasoning"],` +
	`default:"high"}}}`;

/**
 * Signatures of the upstream implementations that replace the agent-host patch.
 *
 * Verified 2026-09-17 against the VS Code 1.136.1 bundle
 * (`out/vs/platform/agentHost/node/agentHostMain.js`):
 *  - `_refreshByokModels` now calls `_createThinkingLevelConfigSchemaProperty`, so
 *    the picker is derived from the model provider's
 *    `configurationSchema.properties.reasoningEffort` instead of needing it.
 *  - The BYOK proxy answers a non-streaming request with `application/json`
 *    rather than always writing an SSE response.
 *  - The request builder forwards `reasoningEffort` from the SDK body.
 *
 * Older builds (for example 1.131) contain none of these and still need every
 * part of the patch, so support is detected per capability instead of being
 * inferred from the VS Code version string.
 */
export const AGENT_HOST_NATIVE_THINKING_LEVEL_SIGNATURE = "_createThinkingLevelConfigSchemaProperty";
export const AGENT_HOST_NATIVE_NON_STREAMING_PATTERN =
	/else\s+[\w$]+\.writeHead\(200,\{"Content-Type":"application\/json"\}\)/;
export const AGENT_HOST_NATIVE_REASONING_EFFORT_PATTERN = /reasoningEffort:[\w$]+\.reasoning\?\.effort/;

export type AgentHostPatchCapabilityId = "thinking-level" | "non-streaming" | "reasoning-effort";
export type AgentHostPatchCapabilityState = "applied" | "patchable" | "native" | "unsupported";

export interface AgentHostPatchCapability {
	id: AgentHostPatchCapabilityId;
	state: AgentHostPatchCapabilityState;
}

/**
 * Reports, per capability, whether this bundle already has it, still needs the
 * patch, or matches neither known shape. Used to avoid reporting a normal
 * upstream improvement as a version mismatch.
 */
export function inspectAgentHostPatchSupport(source: string): AgentHostPatchCapability[] {
	const capabilities: Array<{ id: AgentHostPatchCapabilityId; applied: string; native: boolean; patchable: string }> = [
		{
			id: "thinking-level",
			applied: AGENT_HOST_THINKING_PATCH_MARKER,
			native: source.includes(AGENT_HOST_NATIVE_THINKING_LEVEL_SIGNATURE),
			patchable: BYOK_SNAPSHOT_PATTERN,
		},
		{
			id: "non-streaming",
			applied: AGENT_HOST_NON_STREAMING_PATCH_MARKER,
			native: AGENT_HOST_NATIVE_NON_STREAMING_PATTERN.test(source),
			patchable: PROXY_NON_STREAMING_PATTERN,
		},
		{
			id: "reasoning-effort",
			applied: AGENT_HOST_REASONING_EFFORT_PATCH_MARKER,
			native: AGENT_HOST_NATIVE_REASONING_EFFORT_PATTERN.test(source),
			patchable: PROXY_REASONING_EFFORT_PATTERN,
		},
	];
	return capabilities.map(capability => ({
		id: capability.id,
		state: source.includes(capability.applied)
			? "applied"
			: source.split(capability.patchable).length - 1 === 1
				? "patchable"
				: capability.native
					? "native"
					: "unsupported",
	}));
}

function sha256(filePath: string): string {
	return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

export function agentHostBundlePathFromAppRoot(appRoot: string): string {
	return path.join(appRoot, "out", "vs", "platform", "agentHost", "node", "agentHostMain.js");
}

export interface AgentHostThinkingPatchTarget {
	bundlePath: string;
}

/** Locates the agent-host bundle of the installed VS Code. */
export function findAgentHostBundle(explicitRoot?: string): AgentHostThinkingPatchTarget {
	// The agent-host bundle lives at a deterministic path under an application
	// root, so an explicit root (or the running extension host) needs no
	// Copilot-bundle lookup — bare VS Code archives on CI runners have no
	// bundled extensions. A remote extension host has no agent host of its own
	// when the window runs on another machine, so every known root is checked.
	const candidates = findAgentHostBundles(explicitRoot);
	if (candidates.length > 0) {
		return { bundlePath: candidates[0].bundlePath };
	}
	throw new Error(`Could not locate the VS Code agent host bundle (tried the app root and installed VS Code installations)`);
}

/** Applies the thinking-level schema to the BYOK snapshot model mapping. */
export function patchAgentHostBundle(source: string): string {
	let patched = source;
	if (!patched.includes(AGENT_HOST_THINKING_PATCH_MARKER)) {
		const occurrences = patched.split(BYOK_SNAPSHOT_PATTERN).length - 1;
		if (occurrences === 1) {
			patched = patched.replace(
				BYOK_SNAPSHOT_PATTERN,
				"maxContextWindow:e.maxContextWindowTokens,supportsVision:e.supportsVision??!1,...t&&{_meta:t}," +
					AGENT_HOST_THINKING_PATCH_MARKER +
					"configSchema:" +
					THINKING_LEVEL_CONFIG_SCHEMA +
					"}}",
			);
		}
	}
	if (!patched.includes(AGENT_HOST_NON_STREAMING_PATCH_MARKER)) {
		const occurrences = patched.split(PROXY_NON_STREAMING_PATTERN).length - 1;
		if (occurrences === 1) {
			patched = patched.replace(PROXY_NON_STREAMING_PATTERN, PROXY_NON_STREAMING_JSON_BRANCH);
		}
	}
	if (!patched.includes(AGENT_HOST_REASONING_EFFORT_PATCH_MARKER)) {
		const occurrences = patched.split(PROXY_REASONING_EFFORT_PATTERN).length - 1;
		if (occurrences === 1) {
			patched = patched.replace(PROXY_REASONING_EFFORT_PATTERN, PROXY_REASONING_EFFORT_PATCHED);
		}
	}
	return patched;
}

export interface AgentHostThinkingPatchStatus {
	bundlePath: string;
	applied: boolean;
	/** True when this VS Code build implements all three behaviours itself. */
	nativeSupport: boolean;
	backupExists: boolean;
	backupPath: string;
	metadataPath: string;
	sha256: string;
}

export interface AgentHostThinkingPatchResult {
	changed: boolean;
	status: AgentHostThinkingPatchStatus;
	message: string;
}

export function getAgentHostThinkingPatchStatus(bundlePath: string): AgentHostThinkingPatchStatus {
	const backupPath = bundlePath + ".llama-vscode-chat.bak";
	const metadataPath = bundlePath + ".llama-vscode-chat.agent-host-thinking.json";
	const installed = fs.readFileSync(bundlePath, "utf8");
	const capabilities = inspectAgentHostPatchSupport(installed);
	return {
		bundlePath,
		applied:
			installed.includes(AGENT_HOST_THINKING_PATCH_MARKER) &&
			installed.includes(AGENT_HOST_NON_STREAMING_PATCH_MARKER) &&
			installed.includes(AGENT_HOST_REASONING_EFFORT_PATCH_MARKER),
		nativeSupport: capabilities.every(
			capability => capability.state === "native" || capability.state === "applied"
		),
		backupExists: fs.existsSync(backupPath),
		backupPath,
		metadataPath,
		sha256: sha256(bundlePath),
	};
}

/** The backup was taken from another VS Code build (a package update replaced the bundle in place). */
function backupFromOtherBuild(status: AgentHostThinkingPatchStatus): boolean {
	const recorded = readPatchMetadata(status.metadataPath)?.vscodeBuild;
	const current = installationBuild(status.bundlePath);
	return typeof recorded === "string" && current !== undefined && recorded !== current;
}

export function applyAgentHostThinkingPatch(bundlePath: string, force = false): AgentHostThinkingPatchResult {
	return withPatchLock(bundlePath, () => applyAgentHostThinkingPatchLocked(bundlePath, force));
}

function applyAgentHostThinkingPatchLocked(bundlePath: string, force: boolean): AgentHostThinkingPatchResult {
	const status = getAgentHostThinkingPatchStatus(bundlePath);
	if (status.applied) {
		return { changed: false, status, message: "The agent-host thinking patch is already applied." };
	}
	const originalBytes = fs.readFileSync(bundlePath);
	const original = originalBytes.toString("utf8");
	const capabilityIds = inspectAgentHostPatchSupport(original);
	// An updated VS Code that implements all of this itself must not be reported
	// as a version mismatch, and it needs no backup handling either.
	if (capabilityIds.every(capability => capability.state === "native")) {
		return {
			changed: false,
			status,
			message:
				"This VS Code build already provides the thinking-level picker, non-streaming JSON responses, "
				+ `and reasoning-effort forwarding natively (${capabilityIds.map(capability => capability.id).join(", ")}), `
				+"so no agent-host patch is needed.",
		};
	}
	// An unpatched bundle is the true original of this build: a backup equal to it, or one of an older build, is replaced.
	const refreshBackup =
		status.backupExists &&
		!original.includes(AGENT_HOST_MARKER_PREFIX) &&
		(backupFromOtherBuild(status) || fs.readFileSync(status.backupPath).equals(originalBytes));
	if (status.backupExists && !force && !refreshBackup) {
		throw new Error(`Backup already exists: ${status.backupPath}. Restore it first or force the patch after inspection.`);
	}
	const patched = patchAgentHostBundle(original);
	if (patched === original) {
		const unmatched = capabilityIds.filter(capability => capability.state !== "native");
		throw new Error(
			"The installed agent host bundle does not contain any of the expected agent-host patterns "
			+ `(VS Code version mismatch? unmatched: ${unmatched.map(capability => capability.id).join(", ")}).`,
		);
	}
	try {
		checkModuleSyntax(patched, "agentHostMain.mjs");
	} catch (error) {
		throw new Error(
			`Patched agent host bundle failed syntax validation: ${error instanceof Error ? error.message : String(error)}`,
			{ cause: error },
		);
	}
	if (!status.backupExists || refreshBackup) {
		writeFileAtomic(status.backupPath, originalBytes);
	}
	writeFileAtomic(bundlePath, patched);
	writeFileAtomic(
		status.metadataPath,
		JSON.stringify({
			patchId: AGENT_HOST_THINKING_PATCH_ID,
			appliedAt: new Date().toISOString(),
			vscodeBuild: installationBuild(bundlePath),
			originalSha256: sha256(status.backupPath),
			patchedSha256: sha256(bundlePath),
		}, null, 2) + "\n",
	);
	return {
		changed: true,
		status: getAgentHostThinkingPatchStatus(bundlePath),
		message: "Applied the thinking-level picker for BYOK models in the Agents Window. Reload all VS Code windows and restart the agent host to activate it.",
	};
}

export function restoreAgentHostThinkingPatch(bundlePath: string): AgentHostThinkingPatchResult {
	return withPatchLock(bundlePath, () => restoreAgentHostThinkingPatchLocked(bundlePath));
}

function restoreAgentHostThinkingPatchLocked(bundlePath: string): AgentHostThinkingPatchResult {
	const status = getAgentHostThinkingPatchStatus(bundlePath);
	if (!status.backupExists) {
		throw new Error(`Backup not found: ${status.backupPath}`);
	}
	// Copying a backup over an unpatched bundle could only bring back an older build.
	const patched = fs.readFileSync(bundlePath, "utf8").includes(AGENT_HOST_MARKER_PREFIX);
	if (patched && backupFromOtherBuild(status)) {
		throw new Error(
			`The saved agent host bundle (${status.backupPath}) belongs to another VS Code build; restoring it would break the agent host. Reinstall VS Code to remove the patch.`,
		);
	}
	if (patched) {
		writeFileAtomic(bundlePath, fs.readFileSync(status.backupPath));
	}
	fs.rmSync(status.backupPath, { force: true });
	fs.rmSync(status.metadataPath, { force: true });
	return {
		changed: patched,
		status: getAgentHostThinkingPatchStatus(bundlePath),
		message: patched
			? "Restored the original agent host bundle. Reload all VS Code windows and restart the agent host to activate the change."
			: "The agent host bundle carries no patch; removed its outdated backup.",
	};
}
