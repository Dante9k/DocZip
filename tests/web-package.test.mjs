import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import path from 'node:path';
import yauzl from 'yauzl';
import { createWebArchive } from '../scripts/lib/web-package.mjs';

test('web release includes only the explicit manifest, excluding leftover private files', async () => {
  await mkdir('test-results', { recursive: true });
  const root = await mkdtemp(path.resolve('test-results', 'package-'));
  await mkdir(path.join(root, 'dist'));
  await writeFile(path.join(root, 'dist/index.html'), '<h1>DocZip</h1>');
  await writeFile(path.join(root, 'leftover.docx'), 'synthetic confidential marker');
  const archive = root + '.zip';
  await createWebArchive(root, ['dist/index.html'], archive);
  const zip = await new Promise((resolve, reject) =>
    yauzl.open(archive, { lazyEntries: true }, (error, value) =>
      error ? reject(error) : resolve(value),
    ),
  );
  const names = await new Promise((resolve, reject) => {
    const paths = [];
    zip.on('error', reject);
    zip.on('end', () => resolve(paths));
    zip.on('entry', (entry) => {
      paths.push(entry.fileName);
      zip.readEntry();
    });
    zip.readEntry();
  });
  assert.deepEqual(names, [path.basename(root) + '/dist/index.html']);
  await assert.rejects(createWebArchive(root, ['../outside.txt'], archive), /Unsafe/);
});
