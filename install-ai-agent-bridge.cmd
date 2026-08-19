@echo off
setlocal EnableExtensions
rem AI Agent Bridge installer for VS Code.
rem The VS Code installer rejects vsix files opened from a network share
rem ("Extract: UNC host ... access is not allowed"), so this script copies
rem the vsix next to itself to the local temp folder and installs from there.
rem Update PRIMARY_VSIX on every version bump (the file next to this script).

set "PRIMARY_VSIX=%~dp0llama-vscode-chat-1.15.0.vsix"
set "VSIX="
if exist "%PRIMARY_VSIX%" set "VSIX=%PRIMARY_VSIX%"
if not defined VSIX (
    for %%F in ("%~dp0llama-vscode-chat-1.*.vsix") do set "VSIX=%%~fF"
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
