import {
  ZipReader,
  ZipWriter,
  BlobReader,
  BlobWriter,
  Uint8ArrayReader,
  configure,
  type Entry,
} from '@zip.js/zip.js/lib/zip-core-external.js';
import { XMLParser, XMLValidator } from 'fast-xml-parser';
import { compressImage, concat } from './images';
import { PRESETS, type Preset, type Progress, type CompressionResult } from './types';

configure({ useWebWorkers: false, useCompressionStream: true });
const MB = 1024 * 1024;
const parser = new XMLParser({
  ignoreAttributes: false,
  removeNSPrefix: true,
  processEntities: true,
});
const array = (value: any): any[] =>
  value === undefined ? [] : Array.isArray(value) ? value : [value];
function xml(data: Uint8Array, name: string) {
  const encoding =
    data[0] === 255 && data[1] === 254
      ? 'utf-16le'
      : data[0] === 254 && data[1] === 255
        ? 'utf-16be'
        : 'utf-8';
  const text = new TextDecoder(encoding, { fatal: true }).decode(data);
  if (/<!DOCTYPE|<!ENTITY/i.test(text) || XMLValidator.validate(text) !== true)
    throw new Error('XML 部件无效：' + name);
  return parser.parse(text);
}
async function read(entry: Entry, limit = 64 * MB): Promise<Uint8Array> {
  if (entry.directory) return new Uint8Array();
  if (entry.uncompressedSize > limit) throw new Error('部件超过安全读取上限：' + entry.filename);
  const chunks: Uint8Array[] = [];
  let count = 0;
  await entry.getData(
    new WritableStream({
      write(data) {
        count += data.length;
        if (count > limit || count > entry.uncompressedSize)
          throw new Error('文档部件的实际大小超出声明');
        chunks.push(data);
      },
    }),
    { checkSignature: true, checkOverlappingEntry: true },
  );
  if (count !== entry.uncompressedSize) throw new Error('文档部件大小校验失败');
  return concat(chunks);
}
async function digest(data: Uint8Array) {
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', data as BufferSource)))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}
function resolvePart(rels: string, target: string) {
  const path = decodeURIComponent(target.split(/[?#]/)[0]);
  const owner = rels === '_rels/.rels' ? [] : rels.split('/').slice(0, -2);
  const parts = path.startsWith('/') ? [] : owner;
  if (path.includes('\\') || /^[a-z]+:/i.test(path)) throw new Error('文档内部引用无效');
  for (const part of path.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') {
      if (!parts.length) throw new Error('文档引用超出包范围');
      parts.pop();
    } else parts.push(part);
  }
  return parts.join('/');
}
async function inspect(entries: Entry[]) {
  const names = new Set<string>();
  let total = 0;
  if (entries.length > 10_000) throw new Error('网页版最多处理 10,000 个文档部件');
  for (const e of entries) {
    total += e.uncompressedSize;
    if (total > 256 * MB || e.uncompressedSize > 64 * MB)
      throw new Error('文档过大：网页版解压总量上限 256 MB，单部件上限 64 MB，请使用桌面版');
    if (e.encrypted) throw new Error('不支持加密文档');
    if (
      /^\/|\\|\0/.test(e.filename) ||
      e.filename.split('/').includes('..') ||
      names.has(e.filename.toLowerCase())
    )
      throw new Error('文档包包含不安全或重复的文件名');
    names.add(e.filename.toLowerCase());
    if (e.filename.toLowerCase().startsWith('_xmlsignatures/'))
      throw new Error('文档含数字签名，压缩会使签名失效，因此未处理');
  }
  const lookup = new Map(entries.map((e) => [e.filename, e]));
  if (!lookup.has('[Content_Types].xml') || !lookup.has('_rels/.rels'))
    throw new Error('不是有效的 DOCX 文档');
  const types = xml(
    await read(lookup.get('[Content_Types].xml')!, 8 * MB),
    '[Content_Types].xml',
  ).Types;
  if (!types) throw new Error('文档内容类型声明无效');
  const defaults = new Map<string, string>(
    array(types.Default).map((t) => [
      String(t['@_Extension']).toLowerCase(),
      String(t['@_ContentType']),
    ]),
  );
  const overrides = new Map<string, string>(
    array(types.Override).map((t) => [
      decodeURIComponent(String(t['@_PartName'])).replace(/^\//, ''),
      String(t['@_ContentType']),
    ]),
  );
  const typeOf = (name: string) =>
    overrides.get(name) ?? defaults.get(name.split('.').at(-1)!.toLowerCase()) ?? '';
  if ([...defaults.values(), ...overrides.values()].some((t) => /digital-signature/i.test(t)))
    throw new Error('不处理包含数字签名的文档');
  const images = new Map<string, string>();
  let main = '';
  for (const e of entries) {
    if (e.directory || e.filename === '[Content_Types].xml') continue;
    const type = typeOf(e.filename);
    if (!type) throw new Error('部件缺少内容类型：' + e.filename);
    if (
      type.endsWith('+xml') ||
      ['application/xml', 'text/xml'].includes(type) ||
      e.filename.endsWith('.rels')
    ) {
      const parsed = xml(await read(e, 8 * MB), e.filename);
      if (!e.filename.endsWith('.rels')) continue;
      if (!Object.hasOwn(parsed, 'Relationships')) throw new Error('关系部件无效');
      for (const r of array(parsed.Relationships.Relationship)) {
        if (r['@_TargetMode'] === 'External') continue;
        const name = resolvePart(e.filename, String(r['@_Target'] ?? ''));
        if (!lookup.has(name)) throw new Error('文档引用的部件不存在：' + name);
        const kind = String(r['@_Type']);
        if (e.filename === '_rels/.rels' && kind.endsWith('/officeDocument')) main = name;
        if (
          e.filename.startsWith('word/') &&
          kind.endsWith('/image') &&
          !name.startsWith('word/embeddings/')
        )
          images.set(name, typeOf(name));
      }
    }
  }
  if (
    typeOf(main) !==
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml'
  )
    throw new Error('只支持普通 DOCX，不支持 DOC、模板或带宏文档');
  if (!Object.hasOwn(xml(await read(lookup.get(main)!, 8 * MB), main), 'document'))
    throw new Error('正文部件无效');
  return images;
}
export async function compressDocx(
  file: File,
  preset: Preset,
  progress: (p: Progress) => void,
): Promise<CompressionResult> {
  if (!/\.docx$/i.test(file.name)) throw new Error('只支持 .docx 文件');
  if (file.size > 200 * MB) throw new Error('网页版单文件上限为 200 MB，请使用桌面版');
  if (!Object.hasOwn(PRESETS, preset)) throw new Error('压缩档位无效');
  const magic = new Uint8Array(await file.slice(0, 8).arrayBuffer());
  if (magic[0] === 0xd0 && magic[1] === 0xcf)
    throw new Error('此文件可能已加密或属于旧版 DOC，请先另存为未加密的 DOCX');
  progress({ percent: 2, stage: '检查文档' });
  const source = new ZipReader(new BlobReader(file));
  let outputReader: ZipReader<Blob> | undefined;
  try {
    const entries = await source.getEntries();
    const images = await inspect(entries);
    const writer = new ZipWriter(
      new BlobWriter('application/vnd.openxmlformats-officedocument.wordprocessingml.document'),
    );
    const hashes = new Map<string, string>();
    const warnings: string[] = [];
    const config = PRESETS[preset];
    let changedImages = 0,
      imageIndex = 0;
    for (const e of entries) {
      let data = await read(e);
      const type = images.get(e.filename);
      if (type) {
        progress({
          percent: 8 + Math.round((62 * ++imageIndex) / images.size),
          stage: '处理图片 ' + imageIndex + ' / ' + images.size,
        });
        if (['image/jpeg', 'image/png'].includes(type)) {
          try {
            const compressed = compressImage(data, type, config.quality, config.maxSide);
            if (compressed.length < data.length) {
              data = compressed;
              changedImages++;
            }
          } catch (error) {
            warnings.push(
              e.filename.split('/').at(-1) +
                '：' +
                String(error instanceof Error ? error.message : error) +
                '，已保留原图。',
            );
          }
        } else warnings.push(e.filename.split('/').at(-1) + '：此格式暂不压缩，已保留原图。');
      }
      hashes.set(e.filename, await digest(data));
      await writer.add(e.filename, new Uint8ArrayReader(data), {
        directory: e.directory,
        level: type ? 0 : 6,
        lastModDate: e.lastModDate,
      });
    }
    progress({ percent: 75, stage: '写入和校验' });
    const candidate = await writer.close();
    outputReader = new ZipReader(new BlobReader(candidate));
    const outputEntries = await outputReader.getEntries();
    if (outputEntries.length !== entries.length) throw new Error('输出部件数量校验失败');
    for (let i = 0; i < outputEntries.length; i++) {
      const e = outputEntries[i];
      if ((await digest(await read(e))) !== hashes.get(e.filename))
        throw new Error('输出内容校验失败：' + e.filename);
      progress({
        percent: 80 + Math.round((19 * (i + 1)) / outputEntries.length),
        stage: '写入和校验',
      });
    }
    const unchanged = changedImages === 0 || candidate.size >= file.size;
    return {
      blob: unchanged ? file : candidate,
      originalSize: file.size,
      outputSize: unchanged ? file.size : candidate.size,
      imageCount: images.size,
      changedImages: unchanged ? 0 : changedImages,
      warnings,
      unchanged,
      reason: unchanged
        ? images.size
          ? '没有进一步减小体积，已保留原文件内容。'
          : '未发现嵌入图片，已保留原文件内容。'
        : '图片压缩完成，非图片内容已逐字节校验。',
    };
  } finally {
    await source.close();
    await outputReader?.close();
  }
}
