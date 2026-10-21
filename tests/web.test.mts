import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import { compressDocx } from '../web/src/compress';
import { parts, photo, readZip, writeZip } from './fixtures';

const root = path.resolve('test-results/web-core');
async function fixture(name: string, entries = parts()) {
  await mkdir(root, { recursive: true });
  const file = path.join(root, name + '.docx');
  await writeZip(file, entries);
  return new File([await readFile(file)], name + '.docx');
}
const compress = (file: File) => compressDocx(file, 'balanced', () => {});
test('web JPEG/PNG encoding preserves layout bytes, ICC, EXIF direction, density and exact PNG pixels', async () => {
  const jpg = await photo(960, 640);
  const png = await sharp({ create: { width: 320, height: 200, channels: 4, background: '#317a5588' } }).png({ compressionLevel: 0 }).toBuffer();
  const before = parts({ 'p.jpg': jpg, 'a.png': png });
  const source = await fixture('图片', before);
  const result = await compress(source);
  assert.equal(result.changedImages, 2, JSON.stringify(result.warnings));
  assert.ok(result.outputSize < source.size);
  const output = path.join(root, '图片_output.docx');
  await writeFile(output, Buffer.from(await result.blob.arrayBuffer()));
  const after = await readZip(output);
  for (const [name, value] of before) if (!name.startsWith('word/media/')) assert.deepEqual(after.get(name), value, name);
  const oldMeta = await sharp(jpg).metadata(), meta = await sharp(after.get('word/media/p.jpg')!).metadata();
  assert.equal(meta.orientation, oldMeta.orientation);
  assert.equal(meta.density, oldMeta.density);
  assert.deepEqual(meta.icc, oldMeta.icc);
  assert.equal(meta.width, oldMeta.width);
  assert.equal(meta.height, oldMeta.height);
  assert.deepEqual(await sharp(after.get('word/media/a.png')!).raw().toBuffer(), await sharp(png).raw().toBuffer());
});
test('web no-image and fully skipped packages return original bytes with reasons', async () => {
  const plain = await fixture('文字');
  const a = await compress(plain);
  assert.equal(a.unchanged, true);
  assert.deepEqual(await a.blob.arrayBuffer(), await plain.arrayBuffer());
  const bad = Buffer.from('bad PNG');
  const gif = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');
  const mixed = await fixture('全部跳过', parts({ 'bad.png': bad, 'g.gif': gif }));
  const b = await compress(mixed);
  assert.equal(b.warnings.length, 2);
  assert.equal(b.unchanged, true);
  assert.deepEqual(await b.blob.arrayBuffer(), await mixed.arrayBuffer());
});
test('web rejects signatures, encrypted DOCX, corrupt XML, missing references, CRC corruption', async () => {
  const signed = parts(); signed.set('_xmlsignatures/sig1.xml', Buffer.from('<Signature/>'));
  await assert.rejects(compress(await fixture('签名', signed)), /签名/);
  await assert.rejects(compress(new File([Buffer.from('d0cf11e0a1b11ae1', 'hex')], '加密.docx')), /加密/);
  const broken = parts(); broken.set('word/document.xml', Buffer.from('<w:document>'));
  await assert.rejects(compress(await fixture('损坏XML', broken)), /XML/);
  const missing = parts({ 'p.png': Buffer.from('x') }); missing.delete('word/media/p.png');
  await assert.rejects(compress(await fixture('缺少引用', missing)), /不存在/);
  const input = await fixture('CRC');
  const bytes = Buffer.from(await input.arrayBuffer());
  const index = bytes.indexOf(Buffer.from('This embedded attachment')); assert.ok(index > 0); bytes[index] ^= 1;
  await assert.rejects(compress(new File([bytes], 'CRC.docx')), /signature|CRC|校验/i);
});
test('web rejects oversized pixel buffers before decoding and leaves original image intact', async () => {
  const large = await sharp({ create: { width: 5000, height: 4000, channels: 3, background: '#fff' } }).png().toBuffer();
  const file = await fixture('像素上限', parts({ 'p.png': large }));
  const result = await compress(file);
  assert.equal(result.unchanged, true);
  assert.match(result.warnings[0], /像素上限/);
  assert.deepEqual(await result.blob.arrayBuffer(), await file.arrayBuffer());
});
