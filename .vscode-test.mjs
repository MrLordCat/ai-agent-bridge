import { defineConfig } from '@vscode/test-cli';
import os from 'node:os';
import path from 'node:path';

export default defineConfig({
  files: 'out/test/**/*.test.js',
  // The current stable VS Code; Copilot and agent-host patch patterns are version-specific.
  // `npm test -- --code-version 1.131.0` checks the minimum from engines.vscode.
  version: '1.143.1',
  launchArgs: [
    `--user-data-dir=${path.resolve('.vscode-test', `user-data-${os.userInfo().username}-${Date.now()}`)}`
  ],
  mocha: {
    ui: 'tdd',
    timeout: 20000,
    color: true
  }
});
