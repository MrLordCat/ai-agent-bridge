import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
assert.equal(process.platform, 'linux');
assert.equal(process.getuid(), 0, 'Run only in the disposable Debian test container');
const patch = require('/workspace/out/copilot-patch.js');
const terminal = require('/workspace/out/byok/workbench-terminal-patch.js');
const thinking = require('/workspace/out/byok/agent-host-thinking-patch.js');
const elevation = require('/workspace/out/patch-elevation.js');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-elevation-check-'));
fs.chmodSync(root, 0o755);
try {
  for (const version of ['1.131.0', '1.141.0']) {
    const appRoot = '/workspace/.vscode-test/vscode-linux-x64-' + version + '/resources/app';
    const source = patch.findCopilotBundles(appRoot, { wsl: false }).find(target => target.appRoot === appRoot);
    assert.ok(source?.workbenchPath, 'A real Copilot/workbench fixture is required');
    const directory = path.join(root, version);
    fs.mkdirSync(directory);
    const copyOriginal = (file, name, suffixes) => {
      const original = suffixes.map(suffix => file + suffix).find(candidate => fs.existsSync(candidate)) || file;
      const destination = path.join(directory, name);
      fs.copyFileSync(original, destination);
      return destination;
    };
    const workbenchPath = copyOriginal(source.workbenchPath, 'workbench.js', ['.llama-vscode-chat.bak', '.llama-vscode-chat.backup']);
    const agentPath = copyOriginal(thinking.agentHostBundlePathFromAppRoot(appRoot), 'agent.js', ['.llama-vscode-chat.bak', '.llama-vscode-chat.backup']);
    const bundlePath = copyOriginal(source.bundlePath, 'copilot.js', ['.llama-vscode-chat.backup']);
    const target = { ...source, bundlePath, workbenchPath };
    const originalWorkbench = fs.readFileSync(workbenchPath);
    const originalAgent = fs.readFileSync(agentPath);
    const jobs = [
      { modulePath: '/workspace/out/copilot-patch.js', operation: 'applyCopilotPatch', target },
      { modulePath: '/workspace/out/byok/workbench-terminal-patch.js', operation: 'applyWorkbenchTerminalPatch', target: workbenchPath },
      { modulePath: '/workspace/out/byok/agent-host-thinking-patch.js', operation: 'applyAgentHostThinkingPatch', target: agentPath },
    ];
    const run = selected => {
      const runner = elevation.createElevatedPatchRunner(selected);
      try {
        const command = elevation.terminalPatchCommand(process.execPath, runner.runnerPath, { method: 'su', executable: '/usr/bin/su' });
        const result = spawnSync('/bin/sh', ['-c', command], { encoding: 'utf8', timeout: 120000 });
        assert.equal(result.status, 0, result.stderr + result.stdout);
      } finally { fs.rmSync(runner.directory, { recursive: true, force: true }); }
    };
    const targetFile = path.join(directory, 'target.json');
    fs.writeFileSync(targetFile, JSON.stringify(target));
    const denied = spawnSync(process.execPath, ['-e', "const fs=require('node:fs');const target=JSON.parse(fs.readFileSync(" + JSON.stringify(targetFile) + ",'utf8'));fs.readFileSync(target.bundlePath);require('/workspace/out/copilot-patch.js').applyCopilotPatch(target)"], {
      uid: 1000, gid: 1000, cwd: '/', encoding: 'utf8',
    });
    assert.equal(denied.error, undefined, 'The unprivileged process must actually start');
    assert.notEqual(denied.status, 0, 'The ordinary user cannot patch the system fixture');
    assert.match(denied.stderr, /EACCES|permission denied/);
    run(jobs);
    const status = patch.getCopilotPatchStatus(target);
    assert.ok(status.applied && status.workbenchApplied);
    assert.ok(terminal.getWorkbenchTerminalPatchStatus(workbenchPath).applied);
    const agent = thinking.getAgentHostThinkingPatchStatus(agentPath);
    assert.ok(agent.applied || agent.nativeSupport);
    run(jobs);
    // New backups of user-owned Copilot remain writable by that user after root applies the patch.
    const userBundle = copyOriginal(source.bundlePath, 'user-copilot.js', ['.llama-vscode-chat.backup']);
    fs.chownSync(userBundle, 1000, 1000);
    const userTarget = { ...target, bundlePath: userBundle, workbenchPath: undefined };
    run([{ ...jobs[0], target: userTarget }]);
    assert.equal(fs.statSync(userBundle + '.llama-vscode-chat.backup').uid, 1000);
    assert.equal(fs.statSync(patch.getCopilotPatchStatus(userTarget).metadataPath).uid, 1000);
    run([{ ...jobs[0], target: userTarget, operation: 'restoreCopilotPatch' }]);
    // Restore in reverse order, as each backup captures the preceding patch's state.
    run([
      ...(agent.applied ? [{ ...jobs[2], operation: 'restoreAgentHostThinkingPatch' }] : []),
      { ...jobs[1], operation: 'restoreWorkbenchTerminalPatch' },
      { ...jobs[0], operation: 'restoreCopilotPatch' },
    ]);
    const restored = patch.getCopilotPatchStatus(target);
    assert.ok(!restored.applied && !restored.workbenchApplied);
    assert.ok(fs.readFileSync(workbenchPath).equals(originalWorkbench), 'Restore preserves the exact workbench bytes');
    assert.ok(fs.readFileSync(agentPath).equals(originalAgent), 'Restore preserves the exact agent-host bytes');
    console.log(JSON.stringify({ version, ordinaryWriteDenied: true, administratorApply: true,
      idempotent: true, userBackupOwnerPreserved: true, administratorRestore: true, actualSuCommand: true }));
  }
} finally { fs.rmSync(root, { recursive: true, force: true }); }
