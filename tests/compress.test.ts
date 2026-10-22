import { after, before, test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import { compressDocx, validateOutputDir, friendlyError } from '../src/core/compress';
import { LIMITS, hash } from '../src/core/archive';
import { parts, photo, transparentPng, readZip, writeZip } from './fixtures';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import { Writable } from 'node:stream';

let root: string, outputDir: string, jpg: Buffer, png: Buffer;
before(async () => {
  await mkdir('test-results', { recursive: true });
  root = await mkdtemp(path.resolve('test-results', 'core-'));
  outputDir = path.join(root, '输出 文件夹');
  await mkdir(outputDir);
  jpg = await photo();
  png = await transparentPng();
});
after(async () => {
  if (root) await rm(root, { recursive: true, force: true });
});
const source = (name: string) => path.join(root, `${name}.docx`);

test('compress photos and transparent PNG; all layout, headers, footers and attachments remain byte-identical', async () => {
  const inputPath = source('布局 测试');
  const originalParts = parts({ 'photo.jpg': jpg, 'alpha.png': png });
  await writeZip(inputPath, originalParts);
  const originalHash = hash(await readFile(inputPath));
  const stages: string[] = [];
  const result = await compressDocx({
    inputPath,
    outputDir,
    preset: 'balanced',
    onProgress: (p) => stages.push(p.stage),
  });
  assert.equal(result.unchanged, false);
  assert.equal(result.changedImages, 2, JSON.stringify(result.warnings));
  assert.equal(result.warnings.length, 0);
  assert.ok(result.outputSize < result.originalSize);
  assert.equal(path.basename(result.outputPath), '布局 测试_light.docx');
  assert.equal(hash(await readFile(inputPath)), originalHash);
  const output = await readZip(result.outputPath);
  assert.equal(output.size, originalParts.size);
  for (const [name, data] of originalParts)
    if (!name.startsWith('word/media/')) assert.deepEqual(output.get(name), data, name);
  const jpegMeta = await sharp(output.get('word/media/photo.jpg')!).metadata();
  const pngMeta = await sharp(output.get('word/media/alpha.png')!).metadata();
  assert.equal(jpegMeta.width, 2400);
  assert.equal(jpegMeta.height, 1600);
  assert.equal(jpegMeta.orientation, 6);
  assert.equal(jpegMeta.density, 144);
  assert.equal(pngMeta.hasAlpha, true);
  assert.equal(pngMeta.width, 2400);
  assert.ok(stages.includes('检查文档') && stages.includes('写入和校验'));
});

test('all presets keep originals and generate progressively smaller photos', async () => {
  const inputPath = source('预设');
  await writeZip(inputPath, parts({ 'p.jpg': jpg }));
  const sizes: number[] = [];
  for (const preset of ['clear', 'balanced', 'small'] as const) {
    const result = await compressDocx({ inputPath, outputDir, preset });
    sizes.push(result.outputSize);
    const image = (await readZip(result.outputPath)).get('word/media/p.jpg')!;
    assert.equal(
      (await sharp(image).metadata()).width,
      { clear: 3200, balanced: 2400, small: 1600 }[preset],
    );
  }
  assert.ok(sizes[0] > sizes[1] && sizes[1] > sizes[2]);
});

test('no images produce an exact copy, filenames never overwrite existing output', async () => {
  const inputPath = source('纯文字');
  await writeZip(inputPath, parts());
  const results = await Promise.all(
    [1, 2, 3].map(() => compressDocx({ inputPath, outputDir, preset: 'balanced' })),
  );
  assert.deepEqual(
    results.map((r) => path.basename(r.outputPath)).sort(),
    ['纯文字_light.docx', '纯文字_light_1.docx', '纯文字_light_2.docx'].sort(),
  );
  for (const result of results) {
    assert.equal(result.unchanged, true);
    assert.equal(result.imageCount, 0);
    assert.deepEqual(await readFile(result.outputPath), await readFile(inputPath));
  }
});

test('GIF and unreadable picture are retained and reported, other images still compress', async () => {
  const gif = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');
  const invalid = Buffer.from('not a PNG');
  const inputPath = source('混合格式');
  await writeZip(inputPath, parts({ 'p.jpg': jpg, 'a.gif': gif, 'broken.png': invalid }));
  const result = await compressDocx({ inputPath, outputDir, preset: 'balanced' });
  assert.equal(result.changedImages, 1);
  assert.equal(result.warnings.length, 2);
  const out = await readZip(result.outputPath);
  assert.deepEqual(out.get('word/media/a.gif'), gif);
  assert.deepEqual(out.get('word/media/broken.png'), invalid);
});

test('small optimized PNG remains lossless and is never enlarged', async () => {
  const picture = await sharp({
    create: { width: 80, height: 40, channels: 4, background: '#36ad8f88' },
  })
    .png({ compressionLevel: 9 })
    .toBuffer();
  const inputPath = source('截图');
  await writeZip(inputPath, parts({ 'p.png': picture }), true);
  const result = await compressDocx({ inputPath, outputDir, preset: 'small' });
  assert.ok(result.outputSize <= result.originalSize);
  const out = (await readZip(result.outputPath)).get('word/media/p.png')!;
  assert.deepEqual(await sharp(out).raw().toBuffer(), await sharp(picture).raw().toBuffer());
});

test('digital signature, encrypted and non-DOCX input fail without output', async () => {
  const inputPath = source('签名');
  const signed = parts();
  signed.set('_xmlsignatures/sig1.xml', Buffer.from('<Signature/>'));
  await writeZip(inputPath, signed);
  await assert.rejects(compressDocx({ inputPath, outputDir, preset: 'balanced' }), /数字签名/);
  const encrypted = source('加密');
  await writeFile(encrypted, Buffer.from('d0cf11e0a1b11ae1', 'hex'));
  await assert.rejects(
    compressDocx({ inputPath: encrypted, outputDir, preset: 'balanced' }),
    /加密/,
  );
  const wrong = path.join(root, 'x.doc');
  await writeFile(wrong, 'x');
  await assert.rejects(compressDocx({ inputPath: wrong, outputDir, preset: 'balanced' }), /只支持/);
});

test('broken XML, dangling relationships, ZIP CRC corruption are rejected', async () => {
  const badXml = parts();
  badXml.set('word/document.xml', Buffer.from('<w:document>'));
  await writeZip(source('坏XML'), badXml);
  await assert.rejects(
    compressDocx({ inputPath: source('坏XML'), outputDir, preset: 'balanced' }),
    /XML/,
  );
  const broken = parts({ 'x.jpg': jpg });
  broken.delete('word/media/x.jpg');
  await writeZip(source('坏引用'), broken);
  await assert.rejects(
    compressDocx({ inputPath: source('坏引用'), outputDir, preset: 'balanced' }),
    /不存在/,
  );
  const crcFile = source('坏CRC');
  await writeZip(crcFile, parts());
  const buffer = await readFile(crcFile);
  const needle = Buffer.from('This embedded attachment');
  const index = buffer.indexOf(needle);
  assert.ok(index > 0);
  buffer[index] ^= 1;
  await writeFile(crcFile, buffer);
  await assert.rejects(
    compressDocx({ inputPath: crcFile, outputDir, preset: 'balanced' }),
    /校验失败/,
  );
});

test('cancellation during image work removes partial files and leaves original unchanged', async () => {
  const inputPath = source('取消');
  await writeZip(inputPath, parts({ 'p.jpg': jpg }));
  const original = hash(await readFile(inputPath));
  const controller = new AbortController();
  await assert.rejects(
    compressDocx({
      inputPath,
      outputDir,
      preset: 'balanced',
      signal: controller.signal,
      onProgress: (p) => {
        if (p.stage.startsWith('处理图片')) controller.abort();
      },
    }),
    /取消|aborted/,
  );
  assert.equal(hash(await readFile(inputPath)), original);
  assert.equal(
    (await readdir(outputDir)).filter((n) => n.startsWith('.doczip-') || n.startsWith('取消_light'))
      .length,
    0,
  );
});

test('invalid output, original modified during work, and package size limits are handled', async () => {
  await assert.rejects(validateOutputDir(path.join(root, 'missing')), /ENOENT/);
  const inputPath = source('改变的原件');
  await writeZip(inputPath, parts());
  let altered = false;
  await assert.rejects(
    compressDocx({
      inputPath,
      outputDir,
      preset: 'balanced',
      onProgress: (p) => {
        if (p.stage === '写入和校验' && !altered) {
          altered = true;
          // This updates size deterministically while still leaving a readable ZIP.
          require('node:fs').appendFileSync(inputPath, 'changed');
        }
      },
    }),
    /发生变化/,
  );
  await writeZip(inputPath, parts());
  const old = LIMITS.entries;
  LIMITS.entries = 2;
  try {
    await assert.rejects(compressDocx({ inputPath, outputDir, preset: 'balanced' }), /上限/);
  } finally {
    LIMITS.entries = old;
  }
  assert.match(
    friendlyError(Object.assign(new Error('write failed'), { code: 'ENOSPC' })),
    /磁盘空间/,
  );
  assert.match(friendlyError(Object.assign(new Error('no access'), { code: 'EACCES' })), /权限/);
  assert.equal(
    (await readdir(outputDir)).some((n) => n.startsWith('.doczip-')),
    false,
  );
});

test('injected disk-full write and directory permission errors leave no output or temporary files', async () => {
  const inputPath = source('写入异常');
  await writeZip(inputPath, parts({ 'p.jpg': jpg }));
  const initial = hash(await readFile(inputPath));
  const createStream = mock.method(
    fs,
    'createWriteStream',
    () =>
      new Writable({
        write(_chunk, _encoding, callback) {
          callback(Object.assign(new Error('disk full'), { code: 'ENOSPC' }));
        },
      }),
  );
  try {
    await assert.rejects(compressDocx({ inputPath, outputDir, preset: 'balanced' }), {
      code: 'ENOSPC',
    });
  } finally {
    createStream.mock.restore();
  }
  const open = mock.method(fsp, 'open', async () => {
    throw Object.assign(new Error('no permission'), { code: 'EACCES' });
  });
  try {
    await assert.rejects(compressDocx({ inputPath, outputDir, preset: 'balanced' }), {
      code: 'EACCES',
    });
  } finally {
    open.mock.restore();
  }
  assert.equal(hash(await readFile(inputPath)), initial);
  assert.equal(
    (await readdir(outputDir)).filter(
      (n) => n.startsWith('.doczip-') || n.startsWith('写入异常_light'),
    ).length,
    0,
  );
});
