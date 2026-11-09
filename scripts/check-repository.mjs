import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export function validateRepositoryMetadata(manifest, lock, readme, release) {
  const errors = [];
  if (lock.version !== manifest.version || lock.packages?.['']?.version !== manifest.version) {
    errors.push('package.json and both package-lock.json versions must agree.');
  }
  if (!readme.includes(`Current build: ${manifest.version}.`)) {
    errors.push('README Current build must match package.json.');
  }
  if (release) {
    if (release.tag !== `v${manifest.version}`) { errors.push('Release tag must match package.json.'); }
    if (release.notes.split(/\r?\n/, 1)[0] !== `# AI Agent Bridge ${manifest.version}`) {
      errors.push('Update docs/RELEASE_NOTES.md for this version before creating the tag.');
    }
  }
  return errors;
}

/** UTF-8 re-read as Windows-1252 (PowerShell 5.1 Get-Content without -Encoding) grows on every rewrite. */
export function findMojibake(text) {
  const match = /[ÂÃâ][\u0080-¿ŒœŠšŸŽžƒˆ˜–—‘-„†-•…‰‹›€™]/.exec(text);
  return match ? text.slice(0, match.index).split('\n').length : 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const read = file => fs.readFileSync(path.join(root, file), 'utf8');
  const manifest = JSON.parse(read('package.json'));
  const errors = validateRepositoryMetadata(manifest, JSON.parse(read('package-lock.json')), read('README.md'),
    process.argv.includes('--release') ? { tag: process.env.RELEASE_TAG, notes: read('docs/RELEASE_NOTES.md') } : undefined);
  const garbledLine = findMojibake(read('package.json'));
  if (garbledLine) { errors.push(`package.json line ${garbledLine} contains mis-encoded text; read and write it as UTF-8.`); }
  if (errors.length) { console.error(errors.join('\n')); process.exitCode = 1; }
  else { console.log(`Repository metadata verified: ${manifest.version}`); }
}