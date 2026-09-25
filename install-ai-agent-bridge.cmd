@echo off
setlocal EnableExtensions
rem AI Agent Bridge installer for VS Code.
rem The VS Code installer rejects vsix files opened from a network share
rem ("Extract: UNC host ... access is not allowed"), so this script copies
rem the vsix next to itself to the local temp folder and installs from there.
rem Drop the .vsix next to this script and run it: the newest version in the
rem folder is installed, so this file needs no edit on a version bump. Set
rem PRIMARY_VSIX below only to force one specific file.

set "PRIMARY_VSIX="
set "VSIX="
if defined PRIMARY_VSIX if exist "%PRIMARY_VSIX%" set "VSIX=%PRIMARY_VSIX%"
if not defined VSIX (
    rem Compared as versions, not as names: a plain sort puts 1.16.9 after
    rem 1.16.10 and would install the older one.
    for /f "usebackq delims=" %%F in (`powershell -NoProfile -ExecutionPolicy Bypass -Command "$best = $null; $seen = [version]'0.0.0'; foreach ($file in Get-ChildItem -LiteralPath '%~dp0' -Filter 'llama-vscode-chat-*.vsix' -File) { $version = [version]($file.BaseName -replace 'llama-vscode-chat-v?', ''); if ($version -gt $seen) { $seen = $version; $best = $file } }; if ($best) { $best.FullName }"`) do set "VSIX=%%F"
)
if not defined VSIX (
    echo ERROR: llama-vscode-chat-*.vsix not found next to this script: %~dp0
    pause
    exit /b 1
)
echo Using: %VSIX%

set "TARGET=%TEMP%\llama-vscode-chat.vsix"
copy /Y "%VSIX%" "%TARGET%" >nul
if errorlevel 1 (
    echo ERROR: could not copy the vsix to %TARGET%
    pause
    exit /b 1
)

set "CODE="
if exist "%LOCALAPPDATA%\Programs\Microsoft VS Code\bin\code.cmd" set "CODE=%LOCALAPPDATA%\Programs\Microsoft VS Code\bin\code.cmd"
if not defined CODE if exist "%ProgramFiles%\Microsoft VS Code\bin\code.cmd" set "CODE=%ProgramFiles%\Microsoft VS Code\bin\code.cmd"
if not defined CODE (
    for /f "delims=" %%F in ("'where code.cmd 2>nul'") do if not defined CODE set "CODE=%%F"
)
if not defined CODE (
    echo ERROR: VS Code not found. Install it and try again.
    pause
    exit /b 1
)

echo Installing AI Agent Bridge...
call "%CODE%" --install-extension "%TARGET%" --force
if errorlevel 1 (
    echo.
    echo Installation failed. See the message above.
    pause
    exit /b 1
)
echo.
echo Done. If VS Code is running, reload the window: Ctrl+Shift+P ^> Developer: Reload Window.
pause
