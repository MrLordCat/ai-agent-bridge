#!/usr/bin/env bash
set -Eeuo pipefail

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
#   FORCE_PATCH_SUDO=1            Elevate even when the files look writable
#   SUDO_ASKPASS=<helper>         Graphical password helper (auto-detected)
#
# Root is only needed when the VS Code application files are not writable by
# your user (the usual case for system-wide installs such as /usr/lib/code).
# User-local VS Code installations are patched without any elevation.
#
# The installer never blocks on a password prompt. It uses passwordless sudo
# when configured, otherwise a graphical askpass helper, and if neither is
# available it applies what it can and prints one command to finish the rest:
#
#   sudo bash ~/.local/share/llama-vscode-chat/apply-patches.sh
#
# That helper is generated on every run and is safe to re-run, which also makes
# it the way to re-apply the patches after a VS Code update.

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
primary_vsix="$script_dir/llama-vscode-chat-1.15.17.vsix"
vsix=""

if [[ -f "$primary_vsix" ]]; then
	vsix="$primary_vsix"
else
	mapfile -t vsix_candidates < <(
		find "$script_dir" -maxdepth 1 -type f -name 'llama-vscode-chat-*.vsix' -printf '%f\n' \
			| sort -V
	)
	if ((${#vsix_candidates[@]} > 0)); then
		vsix="$script_dir/${vsix_candidates[${#vsix_candidates[@]} - 1]}"
	fi
fi

if [[ -z "$vsix" ]]; then
	echo "ERROR: llama-vscode-chat-*.vsix not found next to this script: $script_dir" >&2
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
	const target = copilot.findCopilotBundle(appRoot);
	const result = copilot.applyCopilotPatch(target);
	const version = target.manifest && target.manifest.version ? ` (Copilot Chat ${target.manifest.version})` : "";
	return (result.changed ? "applied" : "already applied") + version;
});

run("VS Code workbench", () => {
	const target = workbench.findWorkbenchBundle(appRoot);
	const result = workbench.applyWorkbenchTerminalPatch(target.bundlePath);
	return result.changed ? "applied" : "already applied";
});

run("Agent-host thinking level", () => {
	const target = agentHost.findAgentHostBundle(appRoot);
	const result = agentHost.applyAgentHostThinkingPatch(target.bundlePath);
	return result.changed ? "applied" : "already applied";
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
	echo "WARNING: could not locate the VS Code application root; skipping patches." >&2
	echo "Re-run with VSCODE_APP_ROOT=<dir> if your VS Code uses a custom layout." >&2
	echo
	echo "Done. If VS Code is running, reload the window: Ctrl+Shift+P > Developer: Reload Window."
	exit 0
fi

if [[ -z "$extension_dir" ]]; then
	echo "WARNING: could not locate the installed extension directory; skipping patches." >&2
	echo "Re-run with VSCODE_EXTENSIONS_DIR=<dir> if your extensions live elsewhere." >&2
	echo
	echo "Done. If VS Code is running, reload the window: Ctrl+Shift+P > Developer: Reload Window."
	exit 0
fi

echo "Applying patches"
echo "  VS Code:   $app_root"
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

# Common graphical askpass helpers, so desktop users get a dialog instead of a
# password prompt on a terminal that a script may not control.
find_askpass() {
	if [[ -n "${SUDO_ASKPASS:-}" && -x "${SUDO_ASKPASS}" ]]; then
		printf '%s\n' "$SUDO_ASKPASS"
		return 0
	fi
	local candidate
	for candidate in ksshaskpass lxqt-openssh-askpass ssh-askpass gnome-ssh-askpass x11-ssh-askpass; do
		if command -v "$candidate" >/dev/null 2>&1; then
			command -v "$candidate"
			return 0
		fi
	done
	return 1
}

# The runner lives outside the temp dir so the printed command keeps working
# after this script exits and the patches can be re-applied later.
helper_dir="${XDG_DATA_HOME:-$HOME/.local/share}/llama-vscode-chat"
patch_helper=""
if mkdir -p "$helper_dir" 2>/dev/null; then
	runner="$helper_dir/apply-vscode-patches.cjs"
	patch_helper="$helper_dir/apply-patches.sh"
	write_patch_runner "$runner"
	printf '#!/usr/bin/env bash\n# Generated by install-ai-agent-bridge.sh. Safe to re-run.\nexec %q %q %q %q "$@"\n' \
		"$node_command" "$runner" "$extension_dir" "$app_root" >"$patch_helper"
	chmod +x "$patch_helper" 2>/dev/null || true
else
	runner="$temp_dir/apply-vscode-patches.cjs"
	write_patch_runner "$runner"
fi

# Report exactly which files need elevation, and which feature each one unlocks,
# so the reason for the privilege request is always explicit.
patch_targets=(
	"$app_root/extensions/copilot/dist/extension.js|Copilot Chat|native model controls and bounded stored tool output"
	"$app_root/out/vs/workbench/workbench.desktop.main.js|VS Code workbench|reuse of idle background tool terminals"
	"$app_root/out/vs/platform/agentHost/node/agentHostMain.js|VS Code agent host|reasoning-effort picker for BYOK models"
)
unwritable_targets=()
for patch_target in "${patch_targets[@]}"; do
	patch_file="${patch_target%%|*}"
	if [[ -e "$patch_file" && ! -w "$patch_file" ]]; then
		unwritable_targets+=("$patch_target")
	fi
done

# Elevation strategy, decided up front and never blocking:
#   direct        the files are writable, so no privilege change at all
#   sudo-n        passwordless sudo is configured, so no prompt
#   sudo-askpass  a graphical helper shows the password dialog
#   manual        nothing available: apply what is possible and print the rest
patch_used_sudo=0
elevation="direct"
if [[ ${#unwritable_targets[@]} -gt 0 || "${FORCE_PATCH_SUDO:-0}" == "1" ]]; then
	echo
	echo "Administrator rights are needed for this VS Code installation."
	if ((${#unwritable_targets[@]} > 0)); then
		echo "Your user cannot write these files:"
		for patch_target in "${unwritable_targets[@]}"; do
			patch_file="${patch_target%%|*}"
			patch_rest="${patch_target#*|}"
			printf '  %s\n      %s -> %s\n' "$patch_file" "${patch_rest%%|*}" "${patch_rest#*|}"
		done
	else
		echo "  (forced with FORCE_PATCH_SUDO=1)"
	fi
	echo
	echo "Only these files are edited; nothing is downloaded and no system package is"
	echo "changed. The original of each file is copied to a .llama-vscode-chat backup"
	echo "next to it first, and \"AI Agent Bridge: Restore Copilot Patch\" in the"
	echo "Command Palette can put the originals back at any time."

	elevation="manual"
	if command -v sudo >/dev/null 2>&1 && [[ -n "$patch_helper" ]]; then
		if sudo -n true 2>/dev/null; then
			elevation="sudo-n"
			patch_used_sudo=1
			echo
			echo "Passwordless sudo is available; applying the patches without a prompt."
		elif askpass_command="$(find_askpass)"; then
			elevation="sudo-askpass"
			patch_used_sudo=1
			echo
			echo "Using the graphical password dialog: $askpass_command"
		fi
	fi
	echo
fi

patch_output_file="$temp_dir/patch-output.txt"

# Runs the runner at the privilege level chosen above. Output is captured so the
# per-patch report can be printed uniformly; no invocation can block on input.
run_patch_runner() {
	set +e
	case "$1" in
		direct)
			"$node_command" "$runner" "$extension_dir" "$app_root" >"$patch_output_file" 2>&1
			;;
		sudo-n)
			sudo -n -- "$node_command" "$runner" "$extension_dir" "$app_root" >"$patch_output_file" 2>&1
			;;
		sudo-askpass)
			# sudo's own PATH (secure_path) would not find an nvm/fnm/volta node, so
			# the absolute interpreter resolved above is passed explicitly.
			SUDO_ASKPASS="$askpass_command" sudo -A -- "$node_command" "$runner" "$extension_dir" "$app_root" >"$patch_output_file" 2>&1
			;;
		*)
			sudo -- "$node_command" "$runner" "$extension_dir" "$app_root" >"$patch_output_file" 2>&1
			;;
	esac
	patch_status=$?
	set -e
}

if [[ "$elevation" == "manual" ]]; then
	run_patch_runner direct
else
	run_patch_runner "$elevation"
fi

if [[ ! -s "$patch_output_file" ]]; then
	echo "ERROR: the patch step produced no output." >&2
	exit 1
fi

# Artifacts written by an elevated run stay root-owned otherwise, and the
# extension's own auto-patch and restore (which run unelevated) could not touch
# them afterwards. Hand them back to the invoking user.
if [[ "$patch_used_sudo" == "1" && -n "${SUDO_UID:-}" ]]; then
	sudo -- find \
		"$app_root/extensions/copilot/dist" \
		"$app_root/out/vs/workbench" \
		"$app_root/out/vs/platform/agentHost/node" \
		-maxdepth 1 \
		\( -name '*.llama-vscode-chat.*' -o -name 'extension.js' \
		-o -name 'workbench.desktop.main.js' -o -name 'agentHostMain.js' \) \
		-exec chown "$SUDO_UID:${SUDO_GID:-$SUDO_UID}" {} + 2>/dev/null || true
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
patch_needs_root_hint=0
if [[ "$patch_status" -ne 0 || "$patch_failed" -ne 0 ]]; then
	# A permission failure is actionable. A shape mismatch (unsupported VS Code
	# build) only warns: the extension keeps working and retries on activation
	# without touching the original bundle.
	if grep -qiE 'eacces|eperm|erofs|permission denied|read-only' "$patch_output_file"; then
		patch_needs_root_hint=1
	fi
fi

if [[ "$patch_needs_root_hint" == "1" && "$elevation" == "manual" ]]; then
	echo "The remaining patches need administrator rights for this VS Code installation."
	echo "Finish them with this one command:"
	echo
	echo "  sudo bash '$patch_helper'"
	echo
	echo "It edits only the files listed above, asks for your password in your own"
	echo "terminal, and is safe to re-run (for example after a VS Code update)."
	echo "To remove the need for it permanently, make the installation writable once:"
	echo "  sudo chown -R \"\$USER\" '$app_root'"
	echo
elif [[ "$patch_needs_root_hint" == "1" ]]; then
	echo "ERROR: some patches could not be applied because of file permissions." >&2
	if [[ -n "$patch_helper" ]]; then
		echo "Re-run with: sudo bash '$patch_helper'" >&2
	fi
	exit 1
elif [[ "$patch_status" -ne 0 || "$patch_failed" -ne 0 ]]; then
	# Pattern mismatches are expected on some VS Code builds, because upstream
	# often implements the behaviour natively in a later release. Nothing was
	# modified, so this is informational rather than a failure.
	echo "NOTE: not every patch is needed on every VS Code build."
	echo "  - \"already applied\" means the patch is active."
	echo "  - \"does not contain the expected patterns\" usually means that VS Code"
	echo "    build implements the behaviour natively, so no patch is required."
	echo "No original file was modified when a patch did not apply, and the"
	echo "extension re-checks on every activation."
	echo "Details: Ctrl+Shift+P > AI Agent Bridge: Copilot Patch Status."
	echo
fi

echo "Done. If VS Code is running, reload the window: Ctrl+Shift+P > Developer: Reload Window."
