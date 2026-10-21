import { build } from 'esbuild';
import { copyFile, mkdir, readFile, writeFile, readdir } from 'node:fs/promises';
await mkdir('dist', { recursive: true });
const result = await build({
  entryPoints: { index: 'src/index.tsx', worker: 'src/worker.ts' },
  outdir: 'dist', bundle: true, platform: 'browser', format: 'esm',
  target: 'es2022', minify: true, legalComments: 'external', metafile: true,
  inject: ['src/browser-buffer.ts'],
  define: { 'process.env.NODE_ENV': '"production"' },
});
await copyFile('src/index.html', 'dist/index.html');
await copyFile('public/icon.svg', 'dist/icon.svg');
const packages = new Set(Object.keys(result.metafile.inputs).map(input => input.match(/node_modules\/((?:@[^/]+\/)?[^/]+)/)?.[1]).filter(Boolean));
let notices = 'DocZip Web third-party notices\n';
for (const name of [...packages].sort()) {
  const directory = 'node_modules/' + name;
  const manifest = JSON.parse(await readFile(directory + '/package.json', 'utf8'));
  notices += '\n' + name + '@' + manifest.version + '\n' + (manifest.license || '') + '\n';
  const licenses = (await readdir(directory)).filter(file => /^(licen[sc]e|copying)(\.[^.]+)?$/i.test(file));
  for (const license of licenses) notices += await readFile(directory + '/' + license, 'utf8') + '\n';
}
await writeFile('dist/THIRD-PARTY-NOTICES.txt', notices);
console.log('DocZip Web built: dist/');
