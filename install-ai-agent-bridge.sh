#!/usr/bin/env bash
set -Eeuo pipefail

# AI Agent Bridge installer for Linux (including CachyOS).
# Keep this script next to the downloaded .vsix file.

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
primary_vsix="$script_dir/llama-vscode-chat-1.15.16.vsix"
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

echo
echo "Done. If VS Code is running, reload the window: Ctrl+Shift+P > Developer: Reload Window."
