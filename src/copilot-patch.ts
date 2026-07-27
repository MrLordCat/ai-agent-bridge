import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { Script } from "node:vm";

export const COPILOT_PATCH_ID = "llama-vscode-chat:copilot-native-model-controls:v9";
export const COPILOT_PATCH_MARKER = `/* ${COPILOT_PATCH_ID} */`;
export const VSCODE_CHAT_HISTORY_PATCH_ID = "llama-vscode-chat:vscode-chat-history-bounds:v1";
export const VSCODE_CHAT_HISTORY_PATCH_MARKER = `/* ${VSCODE_CHAT_HISTORY_PATCH_ID} */`;

const LEGACY_PATCH_MARKERS = [
	"/* llama-vscode-chat:copilot-native-model-controls:v8 */",
	"/* llama-vscode-chat:copilot-native-model-controls:v7 */",
	"/* llama-vscode-chat:copilot-native-model-controls:v6 */",
	"/* llama-vscode-chat:copilot-native-model-controls:v5 */",
	"/* llama-vscode-chat:copilot-native-model-controls:v4 */",
	"/* llama-vscode-chat:copilot-native-model-controls:v3 */",
	"/* llama-vscode-chat:copilot-native-model-controls:v2 */",
];
const BACKUP_SUFFIX = ".llama-vscode-chat.backup";
const METADATA_SUFFIX = ".llama-vscode-chat.patch.json";

interface CopilotManifest {
	name?: string;
	version?: string;
}

export interface CopilotPatchTarget {
	bundlePath: string;
	workbenchPath: string;
	packagePath: string;
	manifest: CopilotManifest;
}

export interface CopilotPatchStatus {
	patchId: string;
	copilotVersion: string;
	bundlePath: string;
	workbenchPath: string;
	backupPath: string;
	workbenchBackupPath: string;
	metadataPath: string;
	applied: boolean;
	workbenchApplied: boolean;
	legacyPatch: boolean;
	backupExists: boolean;
	workbenchBackupExists: boolean;
	sha256: string;
	workbenchSha256: string;
}

export interface CopilotPatchResult {
	changed: boolean;
	status: CopilotPatchStatus;
	message: string;
}

function sha256(filePath: string): string {
	return createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function addCandidate(candidates: string[], candidate: string | undefined): void {
	if (!candidate) {
		return;
	}
	const resolved = path.resolve(candidate);
	for (const variant of [
		resolved,
		path.join(resolved, "extension.js"),
		path.join(resolved, "dist", "extension.js"),
		path.join(resolved, "extensions", "copilot", "dist", "extension.js"),
		path.join(resolved, "resources", "app", "extensions", "copilot", "dist", "extension.js"),
	]) {
		if (!candidates.includes(variant)) {
			candidates.push(variant);
		}
	}
}

function addCodeInstallationCandidates(candidates: string[], codeCommandPath: string): void {
	if (!codeCommandPath || !fs.existsSync(codeCommandPath)) {
		return;
	}
	const installRoot = path.dirname(path.dirname(codeCommandPath));
	addCandidate(candidates, installRoot);

	const commandText = fs.readFileSync(codeCommandPath, "utf8");
	const versionDir = commandText.match(/\.\.\\([^\\"/]+)\\resources\\app\\out\\cli\.js/i)?.[1];
	if (versionDir) {
		addCandidate(candidates, path.join(installRoot, versionDir));
	}

	for (const entry of fs.readdirSync(installRoot, { withFileTypes: true })) {
		if (entry.isDirectory()) {
			addCandidate(candidates, path.join(installRoot, entry.name));
		}
	}
}

export function findCopilotBundle(explicitRoot?: string): CopilotPatchTarget {
	const candidates: string[] = [];
	addCandidate(candidates, explicitRoot);

	if (process.platform === "win32") {
		try {
			const output = execFileSync("where.exe", ["code.cmd"], { encoding: "utf8" });
			for (const commandPath of output.split(/\r?\n/).filter(Boolean)) {
				addCodeInstallationCandidates(candidates, commandPath.trim());
			}
		} catch {
			// An explicit root can still locate portable and test installations.
		}
	}

	for (const candidate of candidates) {
		if (path.basename(candidate) !== "extension.js" || !fs.existsSync(candidate)) {
			continue;
		}
		const packagePath = path.resolve(path.dirname(candidate), "..", "package.json");
		if (!fs.existsSync(packagePath)) {
			continue;
		}
		const manifest = JSON.parse(fs.readFileSync(packagePath, "utf8")) as CopilotManifest;
		if (manifest.name === "copilot-chat") {
			const appRoot = path.resolve(path.dirname(packagePath), "..", "..");
			const workbenchPath = path.join(appRoot, "out", "vs", "workbench", "workbench.desktop.main.js");
			if (!fs.existsSync(workbenchPath)) {
				continue;
			}
			return { bundlePath: candidate, workbenchPath, packagePath, manifest };
		}
	}

	throw new Error("Could not locate the bundled Copilot Chat extension. Pass an explicit VS Code app root.");
}

function replaceOnce(source: string, search: string, replacement: string, description: string): string {
	const first = source.indexOf(search);
	if (first < 0) {
		throw new Error(`Copilot bundle shape changed: ${description} was not found.`);
	}
	if (source.indexOf(search, first + search.length) >= 0) {
		throw new Error(`Copilot bundle shape changed: ${description} is not unique.`);
	}
	return source.slice(0, first) + replacement + source.slice(first + search.length);
}

function replacePatternOnce(
	source: string,
	pattern: RegExp,
	replacement: string,
	description: string
): string {
	const flags = pattern.flags.replaceAll("g", "");
	const matcher = new RegExp(pattern.source, flags);
	const first = matcher.exec(source);
	if (!first || first.index === undefined) {
		throw new Error(`Copilot bundle shape changed: ${description} was not found.`);
	}
	const tail = source.slice(first.index + first[0].length);
	if (matcher.test(tail)) {
		throw new Error(`Copilot bundle shape changed: ${description} is not unique.`);
	}
	const replaced = first[0].replace(new RegExp(pattern.source, flags), replacement);
	return source.slice(0, first.index) + replaced + source.slice(first.index + first[0].length);
}

function replacePatternOnceWith(
	source: string,
	pattern: RegExp,
	replacement: (match: RegExpExecArray) => string,
	description: string
): string {
	const flags = pattern.flags.replaceAll("g", "");
	const matcher = new RegExp(pattern.source, flags);
	const first = matcher.exec(source);
	if (!first || first.index === undefined) {
		throw new Error(`VS Code workbench shape changed: ${description} was not found.`);
	}
	const tail = source.slice(first.index + first[0].length);
	if (matcher.test(tail)) {
		throw new Error(`VS Code workbench shape changed: ${description} is not unique.`);
	}
	return source.slice(0, first.index) + replacement(first) + source.slice(first.index + first[0].length);
}

export function patchVsCodeWorkbenchBundle(source: string): string {
	if (source.includes(VSCODE_CHAT_HISTORY_PATCH_MARKER)) {
		return source;
	}

	const helper =
		`${VSCODE_CHAT_HISTORY_PATCH_MARKER}function __llamaBoundToolText(e){` +
		'if(typeof e!="string"||e.length<=12000)return e;' +
		'let t="\\n...["+(e.length-12000)+" stored tool-output characters omitted]...\\n",' +
		'o=Math.max(0,12000-t.length),n=Math.floor(o*.35);' +
		'return e.slice(0,n)+t+e.slice(-(o-n))}' +
		'function __llamaBoundToolPayload(e,t){return typeof t=="string"&&!t.startsWith("text/")?' +
		'`[${t} payload omitted from stored chat history]`:__llamaBoundToolText(e)}';

	let patched = replacePatternOnceWith(
		source,
		/(function [A-Za-z_$][\w$]*\([A-Za-z_$][\w$]*\)\{[\s\S]{0,700}?return\{text:)([A-Za-z_$][\w$]*\.replace\(\/\\r\?\\n\/g,`\\r\r?\n`\))/,
		match => `${helper}${match[1]}__llamaBoundToolText(${match[2]})`,
		"terminal tool output serializer"
	);
	patched = replacePatternOnce(
		patched,
		/case"text":([A-Za-z_$][\w$]*)\.push\(\{type:"embed",value:([A-Za-z_$][\w$]*)\.text,isText:!0,mimeType:"text\/plain"\}\);break;case"embeddedResource":\1\.push\(\{type:"embed",value:\2\.data,mimeType:\2\.contentType\}\);break/,
		'case"text":$1.push({type:"embed",value:__llamaBoundToolText($2.text),isText:!0,mimeType:"text/plain"});break;' +
			'case"embeddedResource":$1.push({type:"embed",value:__llamaBoundToolPayload($2.data,$2.contentType),mimeType:$2.contentType});break',
		"native tool result serializer"
	);
	patched = replacePatternOnce(
		patched,
		/terminalCommandOutput:typeof ([A-Za-z_$][\w$]*)\.output\?\.text=="string"\?\{text:\1\.output\.text\}:void 0/,
		'terminalCommandOutput:typeof $1.output?.text=="string"?{text:__llamaBoundToolText($1.output.text),' +
			'truncated:$1.output.text.length>12000}:void 0',
		"extension terminal output serializer"
	);
	return patched;
}

export function patchCopilotBundle(source: string): string {
	if (source.includes(COPILOT_PATCH_MARKER)) {
		return source;
	}

	const errorMarker = "processResponseFromChatEndpoint not supported for extension contributed endpoints";
	const markerIndex = source.indexOf(errorMarker);
	if (markerIndex < 0) {
		throw new Error("Copilot extension endpoint wrapper was not found.");
	}

	const classStart = source.lastIndexOf("var ", markerIndex);
	const classHeader = source.slice(classStart, markerIndex).match(/^var ([A-Za-z_$][\w$]*)=class\{/);
	if (classStart < 0 || !classHeader) {
		throw new Error("Could not identify the Copilot extension endpoint class.");
	}
	const className = classHeader[1];
	const classEnd = source.indexOf(`};${className}=`, markerIndex);
	if (classEnd < 0) {
		throw new Error("Could not identify the end of the Copilot extension endpoint class.");
	}

	let classSource = source.slice(classStart, classEnd + 1);
	classSource = replaceOnce(
		classSource,
		"get modelMaxPromptTokens(){return this._maxTokens}",
		'get modelMaxPromptTokens(){return this.languageModel.vendor==="llamacpp"?' +
			'this._maxTokens+(this.languageModel.maxOutputTokens??0):this._maxTokens}',
		"extension endpoint full context budget"
	);
	classSource = replaceOnce(
		classSource,
		"get maxOutputTokens(){return 8192}",
		'get maxOutputTokens(){return this.languageModel.vendor==="llamacpp"?' +
			'this.languageModel.maxOutputTokens??8192:8192}',
		"extension endpoint output token limit"
	);
	classSource = replaceOnce(
		classSource,
		'get supportsPrediction(){return!1}get policy(){return"enabled"}',
		`${COPILOT_PATCH_MARKER}get supportsPrediction(){return!1}` +
			'get supportsReasoningEffort(){if(this.languageModel.vendor!=="llamacpp")return;' +
			'let e=(this.languageModel.family||"").toLowerCase();' +
			'return e.includes("deepseek")?["high","max"]:["none","low","medium","high"]}' +
			'get policy(){return"enabled"}',
		"extension endpoint capability getters"
	);

	const methodSignature = /async makeChatRequest2\(\{([^{}]*\btelemetryProperties:[A-Za-z_$][\w$]*)([^{}]*)\},([A-Za-z_$][\w$]*)\)\{/;
	const signatureMatch = classSource.match(methodSignature);
	if (!signatureMatch) {
		throw new Error("Copilot extension endpoint request signature was not found.");
	}
	if (/\bmodelCapabilities:/.test(signatureMatch[1] + signatureMatch[2])) {
		throw new Error("Copilot request signature already contains modelCapabilities without this patch marker.");
	}
	const telemetryVariable = (signatureMatch[1] + signatureMatch[2])
		.match(/\btelemetryProperties:([A-Za-z_$][\w$]*)/)?.[1];
	if (!telemetryVariable) {
		throw new Error("Copilot request telemetry variable was not found.");
	}
	classSource = classSource.replace(
		methodSignature,
		`async makeChatRequest2({${signatureMatch[1]}${signatureMatch[2]},modelCapabilities:__llamaModelCapabilities},${signatureMatch[3]}){` +
			`let __llamaConversationId=__llamaConversationMetadata(${telemetryVariable});`
	);

	classSource = replaceOnce(
		classSource,
		"modelOptions:{",
		"modelOptions:{...(__llamaModelCapabilities?.reasoningEffort?" +
			"{reasoningEffort:__llamaModelCapabilities.reasoningEffort}:{})," +
			'...((this.languageModel.vendor==="llamacpp"&&__llamaConversationId)?' +
			"{_copilotConversationId:__llamaConversationId}:{}),",
		"extension endpoint modelOptions"
	);

	const cloneAnchor =
		"cloneWithTokenOverride(e){return this._instantiationService.createInstance(" +
		`${className},{...this.languageModel,maxInputTokens:e})}`;
	classSource = replaceOnce(
		classSource,
		cloneAnchor,
		'cloneWithTokenOverride(e){let t=this.languageModel.vendor==="llamacpp"?' +
			'Math.max(1,e-(this.languageModel.maxOutputTokens??0)):e;return this._instantiationService.createInstance(' +
			`${className},{...this.languageModel,maxInputTokens:t})}`,
		"extension endpoint token override"
	);

	let patched = source.slice(0, classStart) + classSource + source.slice(classEnd + 1);
	patched = replacePatternOnce(
		patched,
		/(function [A-Za-z_$][\w$]*\(([A-Za-z_$][\w$]*)\)\{if\(typeof \2\?\.turnIndex!="string"\|\|!\/\^\\d\+\$\/\.test\(\2\.turnIndex\)\)return;let ([A-Za-z_$][\w$]*)=Number\.parseInt\(\2\.turnIndex,10\);return Number\.isSafeInteger\(\3\)\?\3:void 0\})(function [A-Za-z_$][\w$]*)/,
		'$1function __llamaConversationMetadata(n){let e=n?.conversationId;return typeof e==="string"&&e.length>0&&e.length<=256?e:void 0}$4',
		"extension endpoint Copilot conversation identity"
	);
	patched = replacePatternOnce(
		patched,
		/([A-Za-z_$][\w$]*)=t\.tools\?\.availableTools,([A-Za-z_$][\w$]*)=!!this\.endpoint\.supportsToolSearch,([A-Za-z_$][\w$]*)=\1\?\.length\?await this\.endpoint\.acquireTokenizer\(\)\.countToolTokens\(\1\):0/,
		'$1=t.tools?.availableTools,$2=!!this.endpoint.supportsToolSearch,$3=this.endpoint.modelProvider==="llamacpp"?0:$1?.length?await this.endpoint.acquireTokenizer().countToolTokens($1):0',
		"extension endpoint host tool reservation"
	);
	patched = replacePatternOnce(
		patched,
		/([A-Za-z_$][\w$]*)=this\.configurationService\.getConfig\(([A-Za-z_$][\w$]*)\.SummarizeAgentConversationHistory\)&&this\.prompt===([A-Za-z_$][\w$]*)&&!([A-Za-z_$][\w$]*)/,
		'$1=this.configurationService.getConfig($2.SummarizeAgentConversationHistory)&&this.prompt===$3&&!$4&&this.endpoint.modelProvider!=="llamacpp"',
		"extension endpoint automatic summarization"
	);
	patched = replacePatternOnce(
		patched,
		/([A-Za-z_$][\w$]*)=typeof ([A-Za-z_$][\w$]*)=="number"&&\2<this\.endpoint\.modelMaxPromptTokens\?\2:this\.endpoint\.modelMaxPromptTokens/,
		'$1=this.endpoint.modelProvider==="llamacpp"?this.endpoint.modelMaxPromptTokens:typeof $2=="number"&&$2<this.endpoint.modelMaxPromptTokens?$2:this.endpoint.modelMaxPromptTokens',
		"extension endpoint session context override"
	);
	patched = replacePatternOnce(
		patched,
		/([A-Za-z_$][\w$]*)=([A-Za-z_$][\w$]*)\(([A-Za-z_$][\w$]*),([A-Za-z_$][\w$]*),([A-Za-z_$][\w$]*)\.Advanced\.SummarizeAgentConversationHistoryThreshold\.id\),([A-Za-z_$][\w$]*)=Math\.min\(\1\?\?\4,\4\)/,
		'$1=$2($3,$4,$5.Advanced.SummarizeAgentConversationHistoryThreshold.id),$6=this.endpoint.modelProvider==="llamacpp"?$4:Math.min($1??$4,$4)',
		"extension endpoint summarization threshold"
	);
	patched = replaceOnce(
		patched,
		'B=_?this._getOrCreateBackgroundSummarizer(t.conversation?.sessionId):void 0',
		'B=_&&this.endpoint.modelProvider!=="llamacpp"?this._getOrCreateBackgroundSummarizer(t.conversation?.sessionId):void 0',
		"extension endpoint background compaction"
	);
	return patched;
}

export function getCopilotPatchStatus(target: CopilotPatchTarget): CopilotPatchStatus {
	const backupPath = target.bundlePath + BACKUP_SUFFIX;
	const workbenchBackupPath = target.workbenchPath + BACKUP_SUFFIX;
	const metadataPath = target.bundlePath + METADATA_SUFFIX;
	const installed = fs.readFileSync(target.bundlePath, "utf8");
	const installedWorkbench = fs.readFileSync(target.workbenchPath, "utf8");
	return {
		patchId: COPILOT_PATCH_ID,
		copilotVersion: target.manifest.version ?? "unknown",
		bundlePath: target.bundlePath,
		workbenchPath: target.workbenchPath,
		backupPath,
		workbenchBackupPath,
		metadataPath,
		applied: installed.includes(COPILOT_PATCH_MARKER),
		workbenchApplied: installedWorkbench.includes(VSCODE_CHAT_HISTORY_PATCH_MARKER),
		legacyPatch: LEGACY_PATCH_MARKERS.some(marker => installed.includes(marker)),
		backupExists: fs.existsSync(backupPath),
		workbenchBackupExists: fs.existsSync(workbenchBackupPath),
		sha256: sha256(target.bundlePath),
		workbenchSha256: sha256(target.workbenchPath),
	};
}

export function formatCopilotPatchStatus(status: CopilotPatchStatus): string {
	return [
		`Copilot Chat: ${status.copilotVersion}`,
		`Bundle: ${status.bundlePath}`,
		`Patch: ${status.applied ? "applied" : status.legacyPatch ? "legacy" : "not applied"}`,
		`Backup: ${status.backupExists ? status.backupPath : "not found"}`,
		`SHA-256: ${status.sha256}`,
		`VS Code workbench: ${status.workbenchPath}`,
		`Chat history bounds: ${status.workbenchApplied ? "applied" : "not applied"}`,
		`Workbench backup: ${status.workbenchBackupExists ? status.workbenchBackupPath : "not found"}`,
		`Workbench SHA-256: ${status.workbenchSha256}`,
	].join("\n");
}

export function applyCopilotPatch(target: CopilotPatchTarget, force = false): CopilotPatchResult {
	const initialStatus = getCopilotPatchStatus(target);
	if (initialStatus.applied && initialStatus.workbenchApplied) {
		return { changed: false, status: initialStatus, message: "Copilot Chat patch is already applied." };
	}
	if (initialStatus.legacyPatch && !initialStatus.backupExists) {
		throw new Error("Cannot upgrade the legacy Copilot patch because its original bundle backup is missing.");
	}
	const installed = fs.readFileSync(target.bundlePath, "utf8");
	const original = initialStatus.applied
		? installed
		: initialStatus.legacyPatch
		? fs.readFileSync(initialStatus.backupPath, "utf8")
		: installed;
	if (initialStatus.backupExists && !force && !initialStatus.legacyPatch && !initialStatus.applied) {
		throw new Error(
			`Backup already exists: ${initialStatus.backupPath}. Restore it first or explicitly force the patch after inspection.`
		);
	}
	if (initialStatus.workbenchApplied && !initialStatus.workbenchBackupExists) {
		throw new Error("Cannot manage the VS Code chat history patch because its original workbench backup is missing.");
	}
	if (initialStatus.workbenchBackupExists && !force && !initialStatus.workbenchApplied) {
		throw new Error(
			`Backup already exists: ${initialStatus.workbenchBackupPath}. Restore it first or explicitly force the patch after inspection.`
		);
	}

	const patched = patchCopilotBundle(original);
	const installedWorkbench = fs.readFileSync(target.workbenchPath, "utf8");
	const patchedWorkbench = patchVsCodeWorkbenchBundle(installedWorkbench);
	const validationPath = target.bundlePath + ".llama-vscode-chat.tmp.js";
	const workbenchValidationPath = target.workbenchPath + ".llama-vscode-chat.tmp.mjs";
	fs.writeFileSync(validationPath, patched);
	fs.writeFileSync(workbenchValidationPath, patchedWorkbench);
	try {
		new Script(patched, { filename: validationPath });
		execFileSync(process.execPath, ["--check", workbenchValidationPath], { stdio: "pipe" });
	} catch (error) {
		throw new Error(`Patched VS Code bundle failed syntax validation: ${error instanceof Error ? error.message : String(error)}`);
	} finally {
		fs.rmSync(validationPath, { force: true });
		fs.rmSync(workbenchValidationPath, { force: true });
	}

	if (!initialStatus.backupExists || (force && !initialStatus.legacyPatch && !initialStatus.applied)) {
		fs.copyFileSync(target.bundlePath, initialStatus.backupPath);
	}
	if (!initialStatus.workbenchBackupExists) {
		fs.copyFileSync(target.workbenchPath, initialStatus.workbenchBackupPath);
	}
	fs.writeFileSync(target.bundlePath, patched);
	fs.writeFileSync(target.workbenchPath, patchedWorkbench);
	fs.writeFileSync(
		initialStatus.metadataPath,
		JSON.stringify({
			patchId: COPILOT_PATCH_ID,
			copilotVersion: target.manifest.version,
			appliedAt: new Date().toISOString(),
			originalSha256: sha256(initialStatus.backupPath),
			patchedSha256: sha256(target.bundlePath),
			originalWorkbenchSha256: sha256(initialStatus.workbenchBackupPath),
			patchedWorkbenchSha256: sha256(target.workbenchPath),
		}, null, 2) + "\n"
	);

	return {
		changed: true,
		status: getCopilotPatchStatus(target),
		message: "Applied native model controls and bounded chat-history tool output. Reload all VS Code windows to activate them.",
	};
}

export function restoreCopilotPatch(target: CopilotPatchTarget): CopilotPatchResult {
	const initialStatus = getCopilotPatchStatus(target);
	if (!initialStatus.backupExists) {
		throw new Error(`Backup not found: ${initialStatus.backupPath}`);
	}
	fs.copyFileSync(initialStatus.backupPath, target.bundlePath);
	if (initialStatus.workbenchBackupExists) {
		fs.copyFileSync(initialStatus.workbenchBackupPath, target.workbenchPath);
	}
	fs.rmSync(initialStatus.backupPath, { force: true });
	fs.rmSync(initialStatus.workbenchBackupPath, { force: true });
	fs.rmSync(initialStatus.metadataPath, { force: true });
	return {
		changed: true,
		status: getCopilotPatchStatus(target),
		message: "Restored the original Copilot Chat and VS Code workbench bundles. Reload all VS Code windows to activate them.",
	};
}
