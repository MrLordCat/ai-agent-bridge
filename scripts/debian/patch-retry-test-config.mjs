import { defineConfig } from '@vscode/test-cli';

export default defineConfig({
  extensionDevelopmentPath: '/workspace',
  files: '../../out/test/patch-terminal.test.js',
  version: '1.141.0',
  launchArgs: ['--no-sandbox', '--disable-gpu', '--user-data-dir=/home/node/debian-patch-retry-profile'],
  mocha: { ui: 'tdd', timeout: 20000, color: false },
});
