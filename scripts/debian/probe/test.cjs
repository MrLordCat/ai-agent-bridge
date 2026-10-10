const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vscode = require('vscode');

exports.run = async () => {
  const started = Date.now();
  let ext;
  while (!(ext = vscode.extensions.getExtension('mrlordcat.llama-vscode-chat')) && Date.now() - started < 10000) {
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  if (!ext) {
    console.log(JSON.stringify({ home: process.env.HOME, trusted: vscode.workspace.isTrusted,
      registered: vscode.extensions.all.filter(e => !e.id.startsWith('vscode.')).map(e => e.id) }));
  }
  assert.ok(ext, 'The bridge must be installed from VSIX');
  // Do not call ext.activate(), patch commands, or any installer script.
  while (!ext.isActive && Date.now() - started < 30000) {
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.ok(ext.isActive, 'The installed extension must activate automatically');
  const patch = require(path.join(ext.extensionPath, 'out/copilot-patch.js'));
  let statuses;
  while (Date.now() - started < 45000) {
    statuses = patch.findCopilotBundles(vscode.env.appRoot).map(target => patch.getCopilotPatchStatus(target));
    if (statuses.length && (process.env.DEBIAN_CHECK_READ_ONLY === '1' || statuses.every(s => s.applied && s.workbenchApplied))) { break; }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  // Let the startup timer finish even when writes are intentionally denied.
  if (process.env.DEBIAN_CHECK_READ_ONLY === '1') { await new Promise(resolve => setTimeout(resolve, 1500)); }
  statuses = patch.findCopilotBundles(vscode.env.appRoot).map(target => patch.getCopilotPatchStatus(target));
  const commands = await vscode.commands.getCommands(true);
  const terminalPatch = require(path.join(ext.extensionPath, 'out/byok/workbench-terminal-patch.js'));
  const agentPatch = require(path.join(ext.extensionPath, 'out/byok/agent-host-thinking-patch.js'));
  const terminalPatchStatus = terminalPatch.getWorkbenchTerminalPatchStatus(terminalPatch.findWorkbenchBundle(vscode.env.appRoot).bundlePath);
  const agentPatchStatus = agentPatch.getAgentHostThinkingPatchStatus(agentPatch.findAgentHostBundle(vscode.env.appRoot).bundlePath);
  const { CocoTerminalManager } = require(path.join(ext.extensionPath, 'out/coco/terminal-manager.js'));
  let terminal;
  const manager = new CocoTerminalManager({
    createTerminal: options => { terminal = vscode.window.createTerminal({ ...options, shellPath: '/bin/bash' }); return terminal; },
    onDidChangeTerminalShellIntegration: vscode.window.onDidChangeTerminalShellIntegration,
    onDidStartTerminalShellExecution: vscode.window.onDidStartTerminalShellExecution,
    onDidEndTerminalShellExecution: vscode.window.onDidEndTerminalShellExecution,
    onDidCloseTerminal: vscode.window.onDidCloseTerminal,
  });
  const cancellation = new vscode.CancellationTokenSource();
  let terminalReport;
  try {
    const first = await manager.run({ command: "bridge_state=COCO_LINUX_STATE; printf '%s\\n' COCO_LINUX_FINITE", cwd: '/workspace' }, cancellation.token);
    assert.equal(first.exitCode, 0); assert.match(first.output, /COCO_LINUX_FINITE/);
    const second = await manager.run({ command: "printf 'STATE:%s\\n' \"$bridge_state\"" }, cancellation.token);
    assert.equal(second.terminalId, first.terminalId); assert.match(second.output, /STATE:COCO_LINUX_STATE/);
    const pid = await terminal.processId;
    process.kill(pid, 0);
    await manager.run({ command: "read -r bridge_reply; printf 'REPLY:%s\\n' \"$bridge_reply\"; read -r bridge_hold", mode: 'async' }, cancellation.token);
    manager.send(first.terminalId, 'bridge-input');
    let captured = '';
    for (let attempt = 0; attempt < 5; attempt++) {
      captured = (await manager.read(first.terminalId, 1000)).output;
      if (captured.includes('REPLY:bridge-input')) { break; }
    }
    assert.match(captured, /REPLY:bridge-input/);
    manager.kill(first.terminalId);
    let exited = false;
    for (let attempt = 0; attempt < 30; attempt++) {
      try { process.kill(pid, 0); } catch (error) { if (error.code === 'ESRCH') { exited = true; break; } throw error; }
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.ok(exited, 'Closing a terminal must end its actual bash process');
    terminalReport = { shell: 'bash', output: true, reused: true, input: true, processExitedOnClose: exited };
  } finally { manager.dispose(); cancellation.dispose(); }
  const registry = JSON.parse(fs.readFileSync(path.join(process.env.HOME, '.vscode/extensions/extensions.json'), 'utf8'));
  const installed = registry.find(e => e.identifier?.id.toLowerCase() === 'mrlordcat.llama-vscode-chat');
  const report = {
    platform: process.platform, uid: process.getuid(), vscode: vscode.version,
    bridge: ext.packageJSON.version, source: installed?.metadata?.source,
    active: ext.isActive, appRoot: vscode.env.appRoot,
    autoPatch: vscode.workspace.getConfiguration('llamacpp').get('autoPatchCopilot'),
    applyCommandRegistered: commands.includes('llamacpp.applyCopilotPatch'),
    prepareUserCommandRegistered: commands.includes('llamacpp.prepareUserVsCode'),
    modelProviderRegistered: commands.includes('llamacpp.manage'),
    workbenchTerminalPatch: terminalPatchStatus,
    agentHostThinkingPatch: agentPatchStatus,
    terminal: terminalReport,
    targets: statuses.map(s => ({
      bundlePath: s.bundlePath, applied: s.applied, workbenchApplied: s.workbenchApplied,
      backupExists: s.backupExists, workbenchBackupExists: s.workbenchBackupExists, notices: s.notices,
    })),
  };
  fs.writeFileSync(process.env.DEBIAN_CHECK_REPORT, JSON.stringify(report, null, 2));
  assert.strictEqual(report.uid, 1000, 'VS Code must run without root privileges');
  assert.strictEqual(report.source, 'vsix');
  assert.strictEqual(report.autoPatch, true, 'Test the normal default');
  assert.ok(report.applyCommandRegistered && report.modelProviderRegistered);
  assert.ok(statuses.length, 'A real Copilot bundle must be found');
  if (process.env.DEBIAN_CHECK_READ_ONLY !== '1') {
    assert.ok(statuses.every(s => s.applied && s.workbenchApplied), 'Startup must apply both patch parts without a script');
    assert.ok(terminalPatchStatus.applied, 'Workbench terminal patch must be applied');
    assert.ok(agentPatchStatus.applied || agentPatchStatus.nativeSupport, 'Agent host thinking must be patched or supported natively');
  } else {
    assert.ok(statuses.every(s => !s.workbenchApplied), 'Read-only workbench must remain unchanged');
  }
};