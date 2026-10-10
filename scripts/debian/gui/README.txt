Debian GUI / AI Agent Bridge manual verification

VS Code starts from a user-owned application folder.
AI Agent Bridge is NOT installed automatically.

1. In VS Code, open Extensions.
2. Open the ... menu, choose "Install from VSIX...".
3. Select the newest Linux x64 VSIX in /packages.
4. Run "Developer: Reload Window".
5. Accept the reload after the automatic patch notification.
6. Check AI Agent Bridge Quick Access and the patch status commands.

Firefox is available for account sign-in. This environment has its own accounts,
settings and extension storage. Windows credentials are not mounted.

Desktop launchers:
- VS Code (user-owned): application files are writable by UID 1000.
- VS Code (system-owned): /opt/vscode-system belongs to root.
  Installations share extensions but use separate settings/profile directories.

To test migration without root from the system-owned window, run
"AI Agent Bridge: Prepare User VS Code (Linux, no root)".
For this Docker fixture, open the generated copy from a terminal with:
~/.local/bin/code-ai-agent-bridge --no-sandbox --disable-gpu ~/workspace
The extra sandbox flag is needed in this container and is not added by the
extension's production launcher.

Administrator patching: Debian has su, not sudo. Root's password starts locked.
To enable a manual test, run in your Windows terminal:
docker exec -it --user root ai-agent-bridge-debian-gui passwd root
Type the password directly there.
Install the 1.17.3 VSIX, reload the system-owned window, and choose
"Apply patches with administrator rights", then "Run su in Terminal".
Enter root's password in the Debian terminal. The extension generates su -c
correctly; do not replace sudo with su manually. Failed attempts can be retried.
Apply Patch in Quick Access reopens a failed attempt. Use Retry in Terminal
to repeat authorization, or Close Attempt to start a fresh workflow.
Recreating the container resets root's password; stopping/starting does not.

The host browser opens http://127.0.0.1:6080/vnc.html?autoconnect=true&resize=scale.
The Docker port should be bound to 127.0.0.1 only.
Use the noVNC clipboard panel to paste text. Alt+Shift switches US/Russian layout.
Files, settings and extensions under /home/node persist in the GUI Docker volume.
