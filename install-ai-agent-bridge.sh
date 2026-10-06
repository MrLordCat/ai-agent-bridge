#!/usr/bin/env bash
set -Eeuo pipefail

if [[ "$(id -u)" == "0" ]]; then
	echo "ERROR: run this installer as a regular user, without sudo." >&2
	exit 1
fi

# AI Agent Bridge installer for Linux/macOS (including CachyOS).
# Keep this script next to the downloaded .vsix file.
#
# The installer does two things:
#   1. installs the extension from the .vsix;
#   2. applies the VS Code / Copilot Chat patches with the extension's own
#      compiled patch code, so a fresh install does not depend on the user
#      reloading the window and running a command by hand.
#
# Environment overrides:
#   VSCODE_CLI=<command>          VS Code CLI to use (default: code, code-insiders)
#   VSCODE_APP_ROOT=<dir>         VS Code application root (auto-detected)
#   VSCODE_EXTENSIONS_DIR=<dir>   Extensions directory (auto-detected)
#   SKIP_PATCHES=1                Install the extension only
#   DRY_RUN=1                     Show what would be done, then exit
#
# Use a user-owned VS Code installation when patching application bundles.
# A system-wide installation cannot be changed by this installer without
# administrator rights; the extension will retry compatible patches on reload.

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
# Pick the newest llama-vscode-chat-*.vsix sitting next to this script. Both
# naming styles occur: a local `npm run package` writes
# "llama-vscode-chat-<version>.vsix", while the GitHub release asset is
# "llama-vscode-chat-v<version>.vsix". The version is parsed out of either and
# the highest one wins, so this keeps working across releases with no edits.
vsix="${LLAMACPP_VSIX:-}"
if [[ -n "$vsix" ]]; then
	if [[ ! -f "$vsix" ]]; then
		echo "ERROR: LLAMACPP_VSIX does not point at a file: $vsix" >&2
		exit 1
	fi
else
	newest_vsix=""
	newest_version=""
	for candidate in "$script_dir"/llama-vscode-chat-*.vsix; do
		[[ -f "$candidate" ]] || continue
		candidate_name="${candidate##*/}"
		candidate_version="${candidate_name#llama-vscode-chat-}"
		candidate_version="${candidate_version%.vsix}"
		candidate_version="${candidate_version#v}"
		if [[ -z "$newest_version" ]] \
			|| { [[ "$candidate_version" != "$newest_version" ]] \
				&& [[ "$(printf '%s\n' "$candidate_version" "$newest_version" | sort -V | tail -n 1)" == "$candidate_version" ]]; }; then
			newest_vsix="$candidate"
			newest_version="$candidate_version"
		fi
	done
	vsix="$newest_vsix"
fi

if [[ -z "$vsix" ]]; then
	echo "ERROR: llama-vscode-chat-*.vsix not found next to this script: $script_dir" >&2
	echo "Download it from https://github.com/MrLordCat/ai-agent-bridge/releases/latest" >&2
	echo "or point LLAMACPP_VSIX at an existing .vsix file." >&2
	exit 1
fi

echo "Using: $vsix"

temp_dir="$(mktemp -d "${TMPDIR:-/tmp}/llama-vscode-chat.XXXXXX")"
trap 'rm -rf -- "$temp_dir"' EXIT
target="$temp_dir/llama-vscode-chat.vsix"

if ! cp -- "$vsix" "$target"; then
	echo "ERROR: could not copy the VSIX to $target" >&2
	exit 1
fi

code_command=""
if [[ -n "${VSCODE_CLI:-}" ]] && command -v "$VSCODE_CLI" >/dev/null 2>&1; then
	code_command="$VSCODE_CLI"
else
	for candidate in code code-insiders; do
		if command -v "$candidate" >/dev/null 2>&1; then
			code_command="$candidate"
			break
		fi
	done
fi

if [[ -z "$code_command" ]]; then
	echo "ERROR: VS Code CLI not found." >&2
	echo "Install VS Code and make sure the 'code' command is available in PATH." >&2
	echo "If it has another name, run: VSCODE_CLI=<command> $0" >&2
	exit 1
fi

if [[ "${DRY_RUN:-0}" == "1" ]]; then
	echo "[dry run] install: $code_command --install-extension $vsix --force"
	echo "[dry run] patches: attempt as the current user after installation"
	exit 0
fi

echo "Installing AI Agent Bridge with $code_command..."
if ! "$code_command" --install-extension "$target" --force; then
	echo >&2
	echo "Installation failed. See the message above." >&2
	exit 1
fi

# ---------------------------------------------------------------------------
# Patch phase
# ---------------------------------------------------------------------------

# Finds the VS Code application root: the directory that owns out/vs/workbench
# and extensions/copilot. The launcher may be a symlink into a different prefix
# (for example /usr/bin/code -> /usr/lib/code), so every plausible layout is
# probed instead of assuming one.
resolve_app_root() {
	local cli_path install_root
	local -a candidates=()

	if [[ -n "${VSCODE_APP_ROOT:-}" ]]; then
		candidates+=("$VSCODE_APP_ROOT")
	fi

	cli_path="$(command -v "$code_command" 2>/dev/null || true)"
	if [[ -n "$cli_path" ]]; then
		cli_path="$(readlink -f -- "$cli_path" 2>/dev/null || printf '%s' "$cli_path")"
		install_root="$(cd -- "$(dirname -- "$cli_path")/.." 2>/dev/null && pwd || true)"
		if [[ -n "$install_root" ]]; then
			candidates+=(
				"$install_root/code"
				"$install_root/code-insiders"
				"$install_root/lib/code"
				"$install_root/lib/code-insiders"
				"$install_root/lib64/code"
				"$install_root/share/code"
			)
		fi
		candidates+=("$(dirname -- "$cli_path")" "$(dirname -- "$(dirname -- "$cli_path")")")
	fi

	candidates+=(
		/usr/lib/code
		/usr/lib/code-insiders
		/usr/lib64/code
		/usr/share/code
		/usr/share/code-insiders
		/opt/visual-studio-code
		/opt/visual-studio-code-insiders
		"/Applications/Visual Studio Code.app/Contents/Resources/app"
		"/Applications/Visual Studio Code - Insiders.app/Contents/Resources/app"
	)

	local candidate
	for candidate in "${candidates[@]}"; do
		[[ -n "$candidate" ]] || continue
		if [[ -f "$candidate/out/vs/workbench/workbench.desktop.main.js" ]]; then
			printf '%s\n' "$candidate"
			return 0
		fi
	done
	return 1
}

# Finds the just-installed extension directory (the one shipping the patch code).
resolve_extension_dir() {
	local -a roots=()
	if [[ -n "${VSCODE_EXTENSIONS_DIR:-}" ]]; then
		roots+=("$VSCODE_EXTENSIONS_DIR")
	fi
	roots+=(
		"$HOME/.vscode-oss/extensions"
		"$HOME/.vscode/extensions"
		"$HOME/.vscode-insiders/extensions"
		"$HOME/.vscode-server/extensions"
		"$HOME/.vscode-oss-insiders/extensions"
	)

	local root candidate
	for root in "${roots[@]}"; do
		[[ -d "$root" ]] || continue
		candidate="$(find "$root" -maxdepth 1 -type d -name 'mrlordcat.llama-vscode-chat-*' -print 2>/dev/null \
			| sort -V | tail -n 1)"
		if [[ -n "$candidate" && -f "$candidate/out/copilot-patch.js" ]]; then
			printf '%s\n' "$candidate"
			return 0
		fi
	done
	return 1
}

write_patch_runner() {
	cat >"$1" <<'PATCH_RUNNER'
// Applies the three AI Agent Bridge patches with the extension's own compiled
// patch code, so the installer and the running extension never disagree.
const fs = require("node:fs");
const path = require("node:path");

const [extensionDir, appRoot] = process.argv.slice(2);

function load(relativePath) {
	// Compiled modules live in <extension>/out, but accept a bare extension
	// directory too so the runner keeps working if the layout ever changes.
	const candidates = [
		path.join(extensionDir, "out", relativePath),
		path.join(extensionDir, relativePath),
	];
	for (const full of candidates) {
		if (fs.existsSync(full)) {
			return require(full);
		}
	}
	throw new Error(`patch module not found: ${candidates[0]}`);
}

const copilot = load("copilot-patch.js");
const workbench = load(path.join("byok", "workbench-terminal-patch.js"));
const agentHost = load(path.join("byok", "agent-host-thinking-patch.js"));

const results = [];
function run(name, apply) {
	try {
		results.push({ name, ok: true, detail: apply() });
	} catch (error) {
		results.push({
			name,
			ok: false,
			detail: error && error.message ? error.message : String(error),
		});
	}
}

run("Copilot Chat bundle", () => {
	const targets = copilot.findCopilotBundles(appRoot);
	if (targets.length === 0) {
		throw new Error("no Copilot Chat bundle found");
	}
	const parts = [];
	for (const target of targets) {
		const result = copilot.applyCopilotPatch(target);
		const version = target.manifest && target.manifest.version ? `Copilot Chat ${target.manifest.version}` : "Copilot Chat";
		const where = target.source || target.bundlePath;
		const skipped = result.status && !result.status.workbenchApplied ? ", workbench part skipped" : "";
		parts.push(`${version} [${where}]: ${result.changed ? "applied" : "already applied"}${skipped}`);
	}
	return parts.join("; ");
});

run("VS Code workbench", () => {
	const target = workbench.findWorkbenchBundle(appRoot);
	const result = workbench.applyWorkbenchTerminalPatch(target.bundlePath);
	return result.changed ? "applied" : "already applied";
});

run("Agent-host thinking level", () => {
	const target = agentHost.findAgentHostBundle(appRoot);
	const result = agentHost.applyAgentHostThinkingPatch(target.bundlePath);
	if (result.changed) {
		return "applied";
	}
	// A build that implements this itself says so in the message; reporting
	// "already applied" would wrongly imply that the patch marker is present.
	return /natively/i.test(result.message) ? "provided natively by this VS Code build" : "already applied";
});

for (const result of results) {
	console.log(`${result.ok ? "OK" : "FAIL"}\t${result.name}\t${result.detail}`);
}
process.exitCode = results.some(result => !result.ok) ? 2 : 0;
PATCH_RUNNER
}

if [[ "${SKIP_PATCHES:-0}" == "1" ]]; then
	echo
	echo "Skipping patches (SKIP_PATCHES=1). The extension retries on activation."
	echo
	echo "Done. If VS Code is running, reload the window: Ctrl+Shift+P > Developer: Reload Window."
	exit 0
fi

echo
app_root="$(resolve_app_root || true)"
extension_dir="$(resolve_extension_dir || true)"

if [[ -z "$app_root" ]]; then
	# Not fatal: the patch code searches the known installations itself, which
	# is what a WSL extension host needs (the Copilot bundle lives in the Linux
	# server, the workbench in the Windows installation under /mnt/c).
	echo "NOTE: no VS Code application root found by path; the patch code will search the known installations." >&2
fi

if [[ -z "$extension_dir" ]]; then
	echo "WARNING: could not locate the installed extension directory; skipping patches." >&2
	echo "Re-run with VSCODE_EXTENSIONS_DIR=<dir> if your extensions live elsewhere." >&2
	echo
	echo "Done. If VS Code is running, reload the window: Ctrl+Shift+P > Developer: Reload Window."
	exit 0
fi

echo "Applying patches"
echo "  VS Code:   ${app_root:-<search the known installations>}"
echo "  extension: $extension_dir"

node_command="$(command -v node 2>/dev/null || true)"
if [[ -z "$node_command" ]]; then
	echo
	echo "WARNING: 'node' was not found in PATH, so the patches were not applied here." >&2
	echo "The extension applies them automatically on the next window reload instead." >&2
	echo
	echo "Done. If VS Code is running, reload the window: Ctrl+Shift+P > Developer: Reload Window."
	exit 0
fi

# Run only as the current user. The runner is temporary, so no user-owned
# JavaScript is left behind for a later privileged invocation.
runner="$temp_dir/apply-vscode-patches.cjs"
write_patch_runner "$runner"
patch_output_file="$temp_dir/patch-output.txt"

set +e
"$node_command" "$runner" "$extension_dir" "$app_root" >"$patch_output_file" 2>&1
patch_status=$?
set -e

if [[ ! -s "$patch_output_file" ]]; then
	echo "ERROR: the patch step produced no output." >&2
	exit 1
fi

patch_failed=0
while IFS=$'\t' read -r patch_state patch_name patch_detail; do
	case "$patch_state" in
		OK)
			printf '  \033[32m\u2713\033[0m %s: %s\n' "$patch_name" "$patch_detail"
			;;
		FAIL)
			printf '  \033[31m\u2717\033[0m %s: %s\n' "$patch_name" "$patch_detail"
			patch_failed=1
			;;
		*) continue ;;
	esac
done <"$patch_output_file"

echo
if grep -qiE 'eacces|eperm|erofs|permission denied|read-only' "$patch_output_file"; then
	echo "ERROR: this account cannot write the active VS Code application files." >&2
	echo "Install VS Code for this user (User Installer or portable build), then re-run this installer." >&2
	echo "The VSIX is installed, but patches requiring application-file access remain inactive." >&2
	exit 1
fi

if [[ "$patch_status" -ne 0 || "$patch_failed" -ne 0 ]]; then
	if grep -qiE 'shape changed|patterns|not found|not unique' "$patch_output_file"; then
		echo "NOTE: some patches are incompatible with this VS Code build or already provided natively."
		echo "The extension will re-check the active build on activation."
	else
		echo "ERROR: one or more patches failed; see the details above." >&2
		exit 1
	fi
fi

echo "Done. If VS Code is running, reload the window: Ctrl+Shift+P > Developer: Reload Window."
