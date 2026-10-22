import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createWebArchive } from './lib/web-package.mjs';
if (process.platform !== 'win32' || process.arch !== 'x64')
  throw new Error('请在 Windows x64 环境打包本地网页版。');
const { version } = JSON.parse(await readFile('web/package.json', 'utf8'));
if (!/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(version)) throw new Error('版本号无效');
const root = path.resolve(`release/DocZip-Web-${version}-Windows-x64`);
await mkdir(path.join(root, 'dist'), { recursive: true });
await mkdir(path.join(root, 'scripts'), { recursive: true });
await mkdir(path.join(root, 'runtime'), { recursive: true });
const files = [
  'index.html',
  'index.js',
  'index.css',
  'worker.js',
  'icon.svg',
  'index.js.LEGAL.txt',
  'worker.js.LEGAL.txt',
  'THIRD-PARTY-NOTICES.txt',
];
for (const name of files)
  await copyFile(path.join('web/dist', name), path.join(root, 'dist', name));
await copyFile('web/scripts/serve.mjs', path.join(root, 'scripts/serve.mjs'));
await writeFile(
  path.join(root, 'start.cmd'),
  (await readFile('web/start.cmd', 'utf8')).replace(/\r?\n/g, '\r\n'),
);
await copyFile('web/README.md', path.join(root, '使用说明.md'));
await copyFile('web/NODE-LICENSE.txt', path.join(root, 'runtime/LICENSE.txt'));
await copyFile(process.execPath, path.join(root, 'runtime/node.exe'));
const archive = root + '.zip';
await createWebArchive(
  root,
  [
    ...files.map((name) => 'dist/' + name),
    'scripts/serve.mjs',
    'start.cmd',
    '使用说明.md',
    'runtime/LICENSE.txt',
    'runtime/node.exe',
  ],
  archive,
);
console.log('Local web package: ' + archive);
