import { defineConfig } from '@vscode/test-cli';

export default defineConfig({
  extensionDevelopmentPath: '/workspace',
  files: '../../out/test/**/*.test.js',
  version: '1.131.0',
  launchArgs: ['--no-sandbox', '--disable-gpu', '--user-data-dir=/home/node/debian-unit-profile'],
  mocha: { ui: 'tdd', timeout: 20000, color: false },
});