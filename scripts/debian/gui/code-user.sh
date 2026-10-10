#!/usr/bin/env bash
set -e
# Container-only launcher: Electron sandbox namespaces are unavailable here.
exec "$HOME/apps/vscode/bin/code" --no-sandbox --disable-gpu \
    --user-data-dir="$HOME/.config/Code" --extensions-dir="$HOME/.vscode/extensions" "$@"
