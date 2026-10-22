import { build } from '../web/node_modules/esbuild/lib/main.js';
import { mkdir, writeFile, copyFile } from 'node:fs/promises';
await mkdir('web/dist/__qa', { recursive: true });
await build({
  entryPoints: ['scripts/web-qa.ts'],
  outfile: 'web/dist/qa.js',
  bundle: true,
  platform: 'browser',
  format: 'esm',
  target: 'es2022',
  inject: ['web/src/browser-buffer.ts'],
});
await writeFile(
  'web/dist/qa.html',
  '<!doctype html><meta charset="utf-8"><title>DocZip QA</title><h1>DocZip 浏览器测试</h1><pre style="white-space:pre-wrap;line-height:1.8"></pre><script type="module" src="qa.js"></script>',
);
for (const name of ['会议纪要.docx', '项目报告 含图片.docx'])
  await copyFile('test-results/desktop/input/' + name, 'web/dist/__qa/' + name);
