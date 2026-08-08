import { defineConfig } from '@vscode/test-cli';
import os from 'node:os';
import path from 'node:path';

export default defineConfig({
  files: 'out/test/**/*.test.js',
  // Pin to the VS Code version this extension is developed against. The
  // bundled copilot chat bundle shape changes between versions and the patch
  // patterns are only verified for 1.131.
  version: '1.131.0',
  launchArgs: [
    `--user-data-dir=${path.resolve('.vscode-test', `user-data-${os.userInfo().username}-${Date.now()}`)}`
  ],
  mocha: {
    ui: 'tdd',
    timeout: 20000,
    color: true
  }
});
