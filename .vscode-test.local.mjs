import { defineConfig } from '@vscode/test-cli';
import os from 'node:os';
import path from 'node:path';

// Local-only config: run the tests against the installed VS Code so the
// real-bundle Copilot Chat patch tests exercise the bundle actually in use
// (1.136.1 / Copilot Chat 0.64.1). CI keeps the pinned download in
// `.vscode-test.mjs`.
export default defineConfig({
  files: 'out/test/**/*.test.js',
  useInstallation: {
    fromMachine: true,
  },
  launchArgs: [
    `--user-data-dir=${path.resolve('.vscode-test', `user-data-${os.userInfo().username}-${Date.now()}`)}`
  ],
  mocha: {
    ui: 'tdd',
    timeout: 20000,
    color: true
  }
});
