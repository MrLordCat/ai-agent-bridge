import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateRepositoryMetadata } from './check-repository.mjs';

const manifest = { version: '1.2.3' };
const lock = { version: '1.2.3', packages: { '': { version: '1.2.3' } } };
const readme = 'Current build: 1.2.3.';
test('accepts a consistent development build without release notes for that build', () => {
  assert.deepEqual(validateRepositoryMetadata(manifest, lock, readme), []);
});
test('rejects lockfile and README drift', () => {
  assert.equal(validateRepositoryMetadata(manifest, { ...lock, version: '1.2.2' }, 'old README').length, 2);
});
test('checks both the release tag and the release-notes version', () => {
  assert.equal(validateRepositoryMetadata(manifest, lock, readme, { tag: 'v1.2.2', notes: '# AI Agent Bridge 1.2.2' }).length, 2);
  assert.deepEqual(validateRepositoryMetadata(manifest, lock, readme, { tag: 'v1.2.3', notes: '# AI Agent Bridge 1.2.3\n\nChanges' }), []);
});