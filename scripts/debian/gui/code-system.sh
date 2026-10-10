#!/usr/bin/env bash
set -e
exec /opt/vscode-system/bin/code --no-sandbox --disable-gpu \
    --user-data-dir="$HOME/.config/Code-System" --extensions-dir="$HOME/.vscode/extensions" "$@"
