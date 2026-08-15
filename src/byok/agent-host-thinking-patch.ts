import * as crypto from "crypto";
import { execFileSync } from "child_process";
import * as fs from "fs";
import * as path from "path";
import { findCopilotBundle } from "../copilot-patch";

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
	const copilot = findCopilotBundle(explicitRoot);
	const appRoot = path.resolve(path.dirname(copilot.workbenchPath), "..", "..", "..");
	const bundlePath = agentHostBundlePathFromAppRoot(appRoot);
	if (!fs.existsSync(bundlePath)) {
		throw new Error(`Could not locate the VS Code agent host bundle: ${bundlePath}`);
	}
	return { bundlePath };
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
	return {
		bundlePath,
		applied:
			installed.includes(AGENT_HOST_THINKING_PATCH_MARKER) &&
			installed.includes(AGENT_HOST_NON_STREAMING_PATCH_MARKER) &&
			installed.includes(AGENT_HOST_REASONING_EFFORT_PATCH_MARKER),
		backupExists: fs.existsSync(backupPath),
		backupPath,
		metadataPath,
		sha256: sha256(bundlePath),
	};
}

export function applyAgentHostThinkingPatch(bundlePath: string, force = false): AgentHostThinkingPatchResult {
	const status = getAgentHostThinkingPatchStatus(bundlePath);
	if (status.applied) {
		return { changed: false, status, message: "The agent-host thinking patch is already applied." };
	}
	if (status.backupExists && !force) {
		throw new Error(`Backup already exists: ${status.backupPath}. Restore it first or force the patch after inspection.`);
	}
	const original = fs.readFileSync(bundlePath, "utf8");
	const patched = patchAgentHostBundle(original);
	if (patched === original) {
		throw new Error("The installed agent host bundle does not contain any of the expected agent-host patterns (VS Code version mismatch?).");
	}
	const validationPath = bundlePath + ".llama-vscode-chat.tmp.mjs";
	fs.writeFileSync(validationPath, patched);
	try {
		execFileSync(process.execPath, ["--check", validationPath], { stdio: "pipe" });
	} finally {
		fs.rmSync(validationPath, { force: true });
	}
	if (!status.backupExists) {
		fs.copyFileSync(bundlePath, status.backupPath);
	}
	fs.writeFileSync(bundlePath, patched);
	fs.writeFileSync(
		status.metadataPath,
		JSON.stringify({
			patchId: AGENT_HOST_THINKING_PATCH_ID,
			appliedAt: new Date().toISOString(),
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
	const status = getAgentHostThinkingPatchStatus(bundlePath);
	if (!status.backupExists) {
		throw new Error(`Backup not found: ${status.backupPath}`);
	}
	fs.copyFileSync(status.backupPath, bundlePath);
	fs.rmSync(status.backupPath, { force: true });
	fs.rmSync(status.metadataPath, { force: true });
	return {
		changed: true,
		status: getAgentHostThinkingPatchStatus(bundlePath),
		message: "Restored the original agent host bundle. Reload all VS Code windows and restart the agent host to activate the change.",
	};
}
