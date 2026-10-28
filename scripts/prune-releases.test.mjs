import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planRetention, vsixVersion } from './prune-releases.mjs';

const current = ['v1.20.0', 'v1.19.0', 'v1.18.0', 'v1.17.3', 'v1.17.0', 'v1.16.6', 'v1.16.0', 'v1.9.0', 'v1.0.1', 'v1.0.0'];
test('keeps x.y.0 of three release lines and only the newest line patches', () => {
  const plan = planRetention([...current, 'v1.20.2']);
  assert.deepEqual(plan.keep, ['1.20.2', '1.20.0', '1.19.0', '1.18.0']);
  assert.deepEqual(plan.remove, ['1.17.3', '1.17.0', '1.16.6', '1.16.0', '1.9.0', '1.0.1', '1.0.0']);
});
test('a third patch of the line drops the oldest patch', () => {
  assert.deepEqual(planRetention(['v1.20.0', 'v1.20.2', 'v1.20.5', 'v1.20.6']).remove, ['1.20.2']);
});
test('a new line drops the patches of the previous line and its oldest stable line', () => {
  const plan = planRetention(['v1.21.0', 'v1.20.6', 'v1.20.5', 'v1.20.0', 'v1.19.0', 'v1.18.0']);
  assert.deepEqual(plan.keep, ['1.21.0', '1.20.0', '1.19.0']);
  assert.deepEqual(plan.remove, ['1.20.6', '1.20.5', '1.18.0']);
});
test('never removes a protected version and ignores other tags', () => {
  const plan = planRetention(['v1.20.0', 'v1.19.4', 'v1.19.0', 'v1.18.0', 'nightly', 'v2.0.0-beta.1'], { protect: ['v1.19.4'] });
  assert.ok(plan.keep.includes('1.19.4'));
  assert.deepEqual(plan.remove, []);
});
test('recognizes local and release VSIX names only', () => {
  assert.equal(vsixVersion('llama-vscode-chat-1.20.2.vsix'), '1.20.2');
  assert.equal(vsixVersion('llama-vscode-chat-v1.20.0-win32-x64.vsix'), '1.20.0');
  assert.equal(vsixVersion('other-1.20.0.vsix'), undefined);
});
