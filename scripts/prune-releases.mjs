// Release retention for AI Agent Bridge.
//
// Keeps x.y.0 of the newest three release lines (1.20, 1.19, 1.18) and the two
// newest patches of the newest line (1.20.2, 1.20.5). Older releases and their
// tags are deleted. Tags that are not plain vX.Y.Z are never touched.
//
//   node scripts/prune-releases.mjs --github --current v1.20.2 [--dry-run]
//     GitHub releases and remote tags (CI, needs gh with GH_TOKEN and GH_REPO).
//   node scripts/prune-releases.mjs --local [--dry-run]
//     VSIX files in the repository root and local git tags.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const STABLE_LINES = 3;
export const PATCHES = 2;

export function parseTagVersion(value) {
  const match = /^v?(\d{1,6})\.(\d{1,6})\.(\d{1,6})$/.exec(String(value).trim());
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : undefined;
}

const versionText = version => version.join('.');

/**
 * Splits versions into keep and remove sets (as x.y.z strings). Unparseable
 * values are ignored. Protected versions are always kept.
 */
export function planRetention(values, { stableLines = STABLE_LINES, patches = PATCHES, protect = [] } = {}) {
  const versions = new Map();
  for (const value of values) {
    const version = parseTagVersion(value);
    if (version) { versions.set(versionText(version), version); }
  }
  const lines = [...new Set([...versions.values()].map(([major, minor]) => `${major}.${minor}`))]
    .map(line => line.split('.').map(Number))
    .sort((a, b) => b[0] - a[0] || b[1] - a[1]);
  const keep = new Set(protect.map(parseTagVersion).filter(Boolean).map(versionText));
  lines.slice(0, stableLines).forEach(([major, minor], index) => {
    const line = [...versions.values()].filter(v => v[0] === major && v[1] === minor);
    for (const v of line) { if (v[2] === 0) { keep.add(versionText(v)); } }
    if (index === 0) {
      line.filter(v => v[2] > 0).sort((a, b) => b[2] - a[2]).slice(0, patches).forEach(v => keep.add(versionText(v)));
    }
  });
  const order = (a, b) => { const x = versions.get(a) ?? parseTagVersion(a), y = versions.get(b) ?? parseTagVersion(b); return y[0] - x[0] || y[1] - x[1] || y[2] - x[2]; };
  return {
    keep: [...keep].filter(v => versions.has(v)).sort(order),
    remove: [...versions.keys()].filter(v => !keep.has(v)).sort(order),
  };
}

/** llama-vscode-chat-1.20.2.vsix (local build) or llama-vscode-chat-v1.20.2-win32-x64.vsix (release asset). */
export function vsixVersion(name) {
  const match = /^llama-vscode-chat-v?(\d+\.\d+\.\d+)(?:-[a-z0-9]+-[a-z0-9]+)?\.vsix$/.exec(name);
  return match?.[1];
}

function run(command, args, options = {}) {
  return execFileSync(command, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'], ...options });
}

function printPlan(label, plan) {
  console.log(`${label}: keep ${plan.keep.map(v => `v${v}`).join(' ') || 'none'}`);
  console.log(`${label}: remove ${plan.remove.map(v => `v${v}`).join(' ') || 'none'}`);
}

function pruneGitHub(current, dryRun) {
  if (!parseTagVersion(current ?? '')) { throw new Error('--current vX.Y.Z is required for --github.'); }
  const releases = JSON.parse(run('gh', ['release', 'list', '--limit', '1000', '--json', 'tagName,isDraft']));
  const published = releases.filter(r => !r.isDraft).map(r => r.tagName);
  // Only prune after the current release exists, so a failed publish never deletes the previous ones.
  if (!published.includes(current)) { throw new Error(`Release ${current} is not published; nothing was deleted.`); }
  const tags = run('gh', ['api', '--paginate', 'repos/{owner}/{repo}/git/matching-refs/tags/v', '--jq', '.[].ref'])
    .split(/\r?\n/).filter(Boolean).map(ref => ref.replace(/^refs\/tags\//, ''));
  const plan = planRetention([...published, ...tags], { protect: [current] });
  printPlan('GitHub', plan);
  const remove = new Set(plan.remove);
  const tagOf = list => new Map(list.filter(tag => parseTagVersion(tag)).map(tag => [versionText(parseTagVersion(tag)), tag]));
  const releaseTags = tagOf(published), gitTags = tagOf(tags);
  for (const version of remove) {
    const release = releaseTags.get(version), tag = gitTags.get(version);
    if (release) {
      console.log(`${dryRun ? 'would delete' : 'deleting'} release and tag ${release}`);
      if (!dryRun) { run('gh', ['release', 'delete', release, '--yes', '--cleanup-tag']); }
    } else if (tag) {
      console.log(`${dryRun ? 'would delete' : 'deleting'} tag ${tag}`);
      if (!dryRun) { run('gh', ['api', '-X', 'DELETE', `repos/{owner}/{repo}/git/refs/tags/${tag}`]); }
    }
  }
}

function pruneLocal(root, dryRun) {
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const tags = run('git', ['tag', '--list', 'v*'], { cwd: root }).split(/\r?\n/).filter(Boolean);
  const files = fs.readdirSync(root).filter(name => vsixVersion(name));
  const plan = planRetention([...tags, ...files.map(vsixVersion), manifest.version], { protect: [manifest.version] });
  printPlan('Local', plan);
  const remove = new Set(plan.remove);
  for (const name of files.filter(name => remove.has(vsixVersion(name)))) {
    console.log(`${dryRun ? 'would delete' : 'deleting'} ${name}`);
    if (!dryRun) { fs.rmSync(path.join(root, name), { force: true }); }
  }
  const doomed = tags.filter(tag => parseTagVersion(tag) && remove.has(versionText(parseTagVersion(tag))));
  if (doomed.length) {
    console.log(`${dryRun ? 'would delete' : 'deleting'} local tags ${doomed.join(' ')}`);
    if (!dryRun) { run('git', ['tag', '-d', ...doomed], { cwd: root }); }
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2), dryRun = args.includes('--dry-run');
  const currentIndex = args.indexOf('--current');
  try {
    if (args.includes('--github')) { pruneGitHub(currentIndex >= 0 ? args[currentIndex + 1] : undefined, dryRun); }
    else if (args.includes('--local')) { pruneLocal(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'), dryRun); }
    else { throw new Error('Use --github --current vX.Y.Z or --local, optionally with --dry-run.'); }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
