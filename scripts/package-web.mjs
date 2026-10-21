import { copyFile, mkdir, readdir, readFile, writeFile, stat } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import yazl from 'yazl';
const root = path.resolve('release/DocZip-Web-1.0.0-Windows-x64');
await mkdir(path.join(root, 'dist'), { recursive: true });
await mkdir(path.join(root, 'scripts'), { recursive: true });
await mkdir(path.join(root, 'runtime'), { recursive: true });
const files = ['index.html', 'index.js', 'index.css', 'worker.js', 'icon.svg', 'index.js.LEGAL.txt', 'worker.js.LEGAL.txt', 'THIRD-PARTY-NOTICES.txt'];
for (const name of files) await copyFile(path.join('web/dist', name), path.join(root, 'dist', name));
await copyFile('web/scripts/serve.mjs', path.join(root, 'scripts/serve.mjs'));
await writeFile(path.join(root, 'start.cmd'), (await readFile('web/start.cmd', 'utf8')).replace(/\r?\n/g, '\r\n'));
await copyFile('web/README.md', path.join(root, '使用说明.md'));
await copyFile('web/NODE-LICENSE.txt', path.join(root, 'runtime/LICENSE.txt'));
await copyFile(process.execPath, path.join(root, 'runtime/node.exe'));
const zip = new yazl.ZipFile();
const archive = root + '.zip';
const done = pipeline(zip.outputStream, createWriteStream(archive));
async function add(dir) {
  for (const name of await readdir(dir)) {
    const file = path.join(dir, name);
    if ((await stat(file)).isDirectory()) await add(file);
    else zip.addFile(file, path.relative(path.dirname(root), file).replaceAll('\\', '/'));
  }
}
await add(root); zip.end(); await done;
console.log('Local web package: ' + archive);
