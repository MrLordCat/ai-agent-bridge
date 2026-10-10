import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const workspace = '/workspace', output = path.join(workspace, 'artifacts/debian');
assert.equal(process.platform, 'linux');
assert.equal(process.getuid(), 0, 'Use the Docker image: setup needs to prepare root-owned files');
fs.chownSync(workspace, 1000, 1000);
fs.mkdirSync(output, { recursive: true });
fs.chownSync(output, 1000, 1000);
const commonEnv = { ...process.env, HOME: '/home/node', USER: 'node', LOGNAME: 'node', DONT_PROMPT_WSL_INSTALL: '1' };

function run(label, command, args, env = {}) {
  const log = path.join(output, `${label}.log`), fd = fs.openSync(log, 'w');
  const result = spawnSync(command, args, {
    cwd: workspace, uid: 1000, gid: 1000, env: { ...commonEnv, ...env },
    stdio: ['ignore', fd, fd], timeout: 600000,
  });
  fs.closeSync(fd);
  const lines = fs.readFileSync(log, 'utf8').trim().split('\n');
  console.log(`${label}: ${result.status === 0 ? 'PASS' : 'FAIL'}`);
  console.log(lines.slice(-8).join('\n'));
  if (result.error || result.status !== 0) { throw result.error ?? new Error(`${label} exited ${result.status}; see ${log}`); }
}

run('compile', 'npm', ['run', 'compile']);
run('lint', 'npm', ['run', 'lint']);
if (!process.argv.includes('--install-only')) {
  run('unit-tests', 'xvfb-run', ['--auto-servernum', 'node_modules/.bin/vscode-test', '--config', 'scripts/debian/test-config.mjs']);
}
const version = require('../../package.json').version;
const vsix = path.join(workspace, `llama-vscode-chat-${version}-linux-x64.vsix`);
run('package', 'npm', ['run', 'package', '--', '--target', 'linux-x64', '--out', vsix]);
const patch = require('../../out/copilot-patch.js');
const versions = (process.env.DEBIAN_VSCODE_VERSIONS || '1.131.0,1.141.0').split(',');
const reports = [];

function ownedDirectory(dir) {
  fs.mkdirSync(dir, { recursive: true });
  fs.chownSync(dir, 1000, 1000);
}

for (const codeVersion of versions) {
  const downloadReport = path.join(output, `download-${codeVersion}.json`);
  run(`download-${codeVersion}`, 'node', ['scripts/debian/download.mjs', codeVersion, downloadReport]);
  const original = JSON.parse(fs.readFileSync(downloadReport)).executable;
  const systemInstall = `/opt/bridge-system-${codeVersion}`;
  if (!fs.existsSync(systemInstall)) { fs.cpSync(path.dirname(original), systemInstall, { recursive: true }); }
  const portableInstall = `/home/node/bridge-portable-${codeVersion}`;
  if (fs.existsSync(portableInstall)) { fs.rmSync(portableInstall, { recursive: true }); }
  run(`portable-copy-${codeVersion}`, 'cp', ['-R', systemInstall, portableInstall]);
  for (const scenario of ['user-owned', 'system-readonly', 'migrated-no-root']) {
    const readOnly = scenario === 'system-readonly';
    const label = `${codeVersion}-${scenario}`;
    const caseHome = path.join('/home/node', label);
    ownedDirectory(caseHome); ownedDirectory(path.join(caseHome, '.vscode'));
    ownedDirectory(path.join(caseHome, '.vscode/extensions')); ownedDirectory(path.join(caseHome, 'profile'));
    ownedDirectory(path.join(caseHome, 'profile/User'));
    fs.writeFileSync(path.join(caseHome, 'profile/User/settings.json'), JSON.stringify({
      'llamacpp.enableLocalServer': false, 'llamacpp.enableDeepSeek': false,
      'llamacpp.enableCodexSubscription': false, 'llamacpp.enableClaudeSubscription': false,
      'llamacpp.enableCoco': false, 'chat.agentHost.byokModels.enabled': true,
      'telemetry.telemetryLevel': 'off', 'update.mode': 'none', 'extensions.autoUpdate': false,
      'security.workspace.trust.enabled': false,
    }));
    let executable = path.join(portableInstall, path.basename(original));
    if (readOnly) {
      executable = path.join(systemInstall, path.basename(original));
      // Files are created by this root setup process. The extension runs as UID 1000.
    }
    let cli = path.join(path.dirname(executable), 'bin/code');
    let appRoot = path.join(path.dirname(executable), 'resources/app');
    let profileDir = path.join(caseHome, 'profile');
    let migration;
    if (scenario === 'migrated-no-root') {
      const sourceCli = path.join(systemInstall, 'bin/code');
      run(`install-source-${label}`, sourceCli, ['--install-extension', vsix, '--extensions-dir', path.join(caseHome, '.vscode/extensions'), '--user-data-dir', profileDir], { HOME: caseHome });
      const migrationReport = path.join(output, `${label}-migration.json`);
      run(`prepare-${label}`, 'node', ['scripts/debian/prepare-user.mjs', path.join(systemInstall, 'resources/app'), caseHome, migrationReport], { HOME: caseHome });
      migration = JSON.parse(fs.readFileSync(migrationReport));
      executable = migration.executable; appRoot = migration.appRoot;
      cli = migration.launcher; profileDir = migration.profileDir;
      ownedDirectory(path.join(profileDir, 'User'));
      fs.copyFileSync(path.join(caseHome, 'profile/User/settings.json'), path.join(profileDir, 'User/settings.json'));
      const pristine = patch.findCopilotBundles(path.join(systemInstall, 'resources/app'), { home: caseHome, wsl: false }).map(t => patch.getCopilotPatchStatus(t));
      assert.ok(pristine.every(s => !s.applied && !s.workbenchApplied), 'Preparation must not patch the system application');
    }
    const before = patch.findCopilotBundles(appRoot, { home: caseHome, wsl: false }).map(t => patch.getCopilotPatchStatus(t));
    assert.ok(before.length && before.every(s => !s.applied), 'Each install needs an unpatched baseline');
    const env = { HOME: caseHome, DEBIAN_CHECK_READ_ONLY: readOnly ? '1' : '0', DEBIAN_CHECK_REPORT: path.join(output, `${label}.json`) };
    run(`install-${label}`, cli, ['--install-extension', vsix, '--extensions-dir', path.join(caseHome, '.vscode/extensions'), '--user-data-dir', profileDir], env);
    run(`startup-${label}`, 'xvfb-run', ['--auto-servernum', executable, '--no-sandbox', '--disable-gpu',
      '--skip-welcome', '--skip-release-notes', '--extensions-dir', path.join(caseHome, '.vscode/extensions'),
      '--user-data-dir', profileDir, '--extensionDevelopmentPath=/workspace/scripts/debian/probe',
      workspace], env);
    if (fs.existsSync(`${env.DEBIAN_CHECK_REPORT}.failure.json`)) {
      throw new Error(JSON.parse(fs.readFileSync(`${env.DEBIAN_CHECK_REPORT}.failure.json`)).message);
    }
    const report = JSON.parse(fs.readFileSync(env.DEBIAN_CHECK_REPORT));
    report.scenario = scenario;
    if (migration) {
      assert.equal(report.appRoot, migration.appRoot, 'The migrated application must own the active window');
      assert.ok(report.prepareUserCommandRegistered);
      const originalStatus = patch.findCopilotBundles(path.join(systemInstall, 'resources/app'), { home: caseHome, wsl: false }).map(t => patch.getCopilotPatchStatus(t));
      assert.ok(originalStatus.every(s => !s.applied && !s.workbenchApplied), 'Startup must leave the system installation unmodified');
      report.migration = migration;
    }
    reports.push(report);
    console.log(JSON.stringify({ scenario: label, uid: report.uid, source: report.source, active: report.active,
      controls: report.targets.every(s => s.applied), workbench: report.targets.every(s => s.workbenchApplied), terminal: report.terminal }));
  }
}
fs.writeFileSync(path.join(output, 'summary.json'), JSON.stringify({ debian: '12', bridge: version, reports }, null, 2));
console.log(`Debian verification complete. Reports: ${output}`);