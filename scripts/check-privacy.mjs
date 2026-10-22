import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { inspectContent, inspectPath, isPrivateCommitEmail } from './lib/privacy.mjs';

const git = (args, options = {}) =>
  execFileSync('git', args, { maxBuffer: 64 * 1024 * 1024, ...options });
const findings = [];
const inspect = (source, path, bytes) => {
  const category = inspectPath(path);
  if (category) findings.push({ source, path, category });
  for (const finding of inspectContent(path, bytes)) findings.push({ source, path, ...finding });
};

// Read actual working-tree files, including staged modifications, without following
// ignored caches or opening any user's input documents.
const paths = git(['ls-files', '-z']).toString().split('\0').filter(Boolean);
for (const path of paths) {
  try {
    inspect('working tree', path, await readFile(path));
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
}

const objects = new Map();
for (const line of git(['-c', 'core.quotepath=false', 'rev-list', '--objects', '--all'])
  .toString()
  .trim()
  .split('\n')) {
  const [oid, ...parts] = line.split(' ');
  if (parts.length) objects.set(oid, parts.join(' '));
}
const batch = git(['cat-file', '--batch'], { input: [...objects.keys()].join('\n') + '\n' });
let offset = 0,
  blobs = 0;
while (offset < batch.length) {
  const newline = batch.indexOf(10, offset);
  const [oid, type, sizeText] = batch.subarray(offset, newline).toString().split(' ');
  const size = Number(sizeText);
  if (newline < 0 || !Number.isInteger(size)) throw new Error('Cannot inspect Git object');
  const bytes = batch.subarray(newline + 1, newline + 1 + size);
  if (type === 'blob') {
    blobs++;
    inspect('Git history', objects.get(oid), bytes);
  }
  offset = newline + 1 + size + 1;
}
const commits = git(['log', '--all', '--format=%H%x09%ae%x09%ce'])
  .toString()
  .trim()
  .split('\n')
  .filter(Boolean);
for (const row of commits) {
  const [commit, author, committer] = row.split('\t');
  if (!isPrivateCommitEmail(author) || !isPrivateCommitEmail(committer))
    findings.push({
      source: 'Git history',
      path: commit.slice(0, 12),
      category: 'non-private commit email',
    });
}

// Diagnostic output deliberately contains only locations and categories, never
// matched values, source lines, account names, or input document content.
console.log(
  JSON.stringify(
    { files: paths.length, historyBlobs: blobs, commits: commits.length, findings },
    null,
    2,
  ),
);
if (findings.length) process.exitCode = 1;
