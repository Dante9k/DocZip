import { build } from 'esbuild';
import { mkdir, copyFile } from 'node:fs/promises';
await import('./icon.mjs');

await mkdir('dist/renderer', { recursive: true });
await build({
  entryPoints: {
    main: 'src/main/main.ts',
    preload: 'src/main/preload.ts',
    worker: 'src/main/worker.ts',
  },
  outdir: 'dist/main',
  outExtension: { '.js': '.cjs' },
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node22',
  external: ['electron', 'sharp', 'yauzl', 'yazl', 'fast-xml-parser'],
  sourcemap: true,
});
await build({
  entryPoints: ['src/renderer/index.tsx'],
  outdir: 'dist/renderer',
  bundle: true,
  platform: 'browser',
  target: 'chrome134',
  minify: true,
  sourcemap: true,
  define: { 'process.env.NODE_ENV': '"production"' },
});
await copyFile('src/renderer/index.html', 'dist/renderer/index.html');
