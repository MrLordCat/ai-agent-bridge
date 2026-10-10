#!/usr/bin/env bash
set -Eeuo pipefail

if [[ "$(id -u)" == "0" ]]; then
    echo "Run the GUI as the node user (UID 1000)." >&2
    exit 1
fi
mkdir -p "$XDG_RUNTIME_DIR" "$HOME/gui-logs" "$HOME/workspace"
chmod 700 "$XDG_RUNTIME_DIR"
if [[ -z "${DBUS_SESSION_BUS_ADDRESS:-}" ]]; then
    exec dbus-run-session -- "$0" "$@"
fi

resolution="${GUI_RESOLUTION:-1440x900}"
[[ "$resolution" =~ ^[0-9]{3,4}x[0-9]{3,4}$ ]] || { echo "Invalid GUI_RESOLUTION." >&2; exit 1; }

pids=()
cleanup() {
    if (( ${#pids[@]} )); then
        kill "${pids[@]}" 2>/dev/null || true
        wait 2>/dev/null || true
    fi
}
trap cleanup EXIT
trap 'exit 0' TERM INT

# Block on Xvfb's readiness event instead of guessing a startup delay.
ready="$XDG_RUNTIME_DIR/display-ready"
rm -f "$ready"
mkfifo -m 600 "$ready"
Xvfb "$DISPLAY" -screen 0 "${resolution}x24" -ac -nolisten tcp \
    -displayfd 3 3>"$ready" >"$HOME/gui-logs/xvfb.log" 2>&1 &
pids+=("$!")
read -r display_number < "$ready"
rm -f "$ready"

xfce4-session >"$HOME/gui-logs/desktop.log" 2>&1 &
pids+=("$!")
x11vnc -display "$DISPLAY" -rfbport 5900 -localhost -forever -shared -nopw \
    >"$HOME/gui-logs/vnc.log" 2>&1 &
pids+=("$!")
websockify --web=/usr/share/novnc 0.0.0.0:6080 127.0.0.1:5900 \
    >"$HOME/gui-logs/novnc.log" 2>&1 &
pids+=("$!")

setxkbmap -layout us,ru -option grp:alt_shift_toggle || true
code --skip-welcome --skip-release-notes "$HOME/workspace" >"$HOME/gui-logs/code.log" 2>&1 &
echo "Debian GUI ready; desktop UID $(id -u). noVNC listens on port 6080."
wait -n "${pids[@]}"
