import yauzl, { type Entry, type ZipFile } from 'yauzl';
import { createHash } from 'node:crypto';
import { XMLParser, XMLValidator } from 'fast-xml-parser';
import path from 'node:path';
import type { Readable } from 'node:stream';

export const LIMITS = {
  entries: 20_000,
  totalBytes: 1024 * 1024 * 1024,
  entryBytes: 256 * 1024 * 1024,
  imageBytes: 64 * 1024 * 1024,
  xmlBytes: 16 * 1024 * 1024,
  pixels: 40_000_000,
};
export function checkAbort(signal?: AbortSignal) {
  if (signal?.aborted) throw new Error('任务已取消');
}
export const hash = (data: Buffer) => createHash('sha256').update(data).digest('hex');
const crcTable = Uint32Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (c & 1 ? 0xedb88320 : 0);
  return c >>> 0;
});
export function crcUpdate(crc: number, data: Buffer) {
  for (const b of data) crc = crcTable[(crc ^ b) & 255] ^ (crc >>> 8);
  return crc;
}
export class Archive {
  constructor(
    public zip: ZipFile,
    public entries: Entry[],
  ) {}

  static async open(file: string): Promise<Archive> {
    const zip = await new Promise<ZipFile>((resolve, reject) => {
      yauzl.open(
        file,
        { lazyEntries: true, autoClose: false, strictFileNames: true, validateEntrySizes: true },
        (error, zip) =>
          error
            ? reject(new Error('无法读取 DOCX：文件损坏、被加密或不是有效的 ZIP 包。'))
            : resolve(zip!),
      );
    });
    // A permanent listener prevents a late file descriptor error becoming unhandled.
    zip.on('error', () => {});
    try {
      const entries = await new Promise<Entry[]>((resolve, reject) => {
        const all: Entry[] = [];
        const seen = new Set<string>();
        let total = 0;
        zip.on('error', reject);
        zip.on('end', () => resolve(all));
        zip.on('entry', (entry: Entry) => {
          try {
            if (entry.generalPurposeBitFlag & 1) throw new Error('不支持加密文档。');
            const name = entry.fileName;
            if (
              name.startsWith('/') ||
              name.includes('\\') ||
              name.split('/').includes('..') ||
              name.includes('\0') ||
              seen.has(name.toLowerCase())
            )
              throw new Error('文档包包含重复或不安全的条目。');
            seen.add(name.toLowerCase());
            total += entry.uncompressedSize;
            if (
              all.length >= LIMITS.entries ||
              total > LIMITS.totalBytes ||
              entry.uncompressedSize > LIMITS.entryBytes
            )
              throw new Error(
                '文档超过安全处理上限（解压总量 1 GB、单个部件 256 MB、20,000 个部件）。',
              );
            if (![0, 8].includes(entry.compressionMethod))
              throw new Error('文档使用了不支持的 ZIP 压缩方式。');
            all.push(entry);
            zip.readEntry();
          } catch (error) {
            reject(error);
          }
        });
        zip.readEntry();
      });
      return new Archive(zip, entries);
    } catch (error) {
      zip.close();
      throw error;
    }
  }

  stream(entry: Entry): Promise<Readable> {
    return new Promise((resolve, reject) =>
      this.zip.openReadStream(entry, (error, stream) => (error ? reject(error) : resolve(stream!))),
    );
  }
  async read(entry: Entry, limit: number, signal?: AbortSignal) {
    if (entry.uncompressedSize > limit)
      throw new Error(`部件过大，无法安全读取：${entry.fileName}`);
    const stream = await this.stream(entry);
    const chunks: Buffer[] = [];
    let size = 0,
      crc = -1;
    for await (const chunk of stream) {
      checkAbort(signal);
      const buf = Buffer.from(chunk);
      size += buf.length;
      if (size > limit) throw new Error(`部件超过读取上限：${entry.fileName}`);
      crc = crcUpdate(crc, buf);
      chunks.push(buf);
    }
    if (size !== entry.uncompressedSize || (crc ^ -1) >>> 0 !== entry.crc32)
      throw new Error(`文档部件校验失败：${entry.fileName}`);
    return Buffer.concat(chunks);
  }
  close() {
    this.zip.close();
  }
}

const parser = new XMLParser({
  ignoreAttributes: false,
  removeNSPrefix: true,
  processEntities: false,
});
function xml(data: Buffer, name: string): any {
  // XML in a valid package can be UTF-8 or UTF-16.
  let value: string;
  if (data[0] === 0xff && data[1] === 0xfe) value = data.subarray(2).toString('utf16le');
  else if (data[0] === 0xfe && data[1] === 0xff)
    value = Buffer.from(data.subarray(2)).swap16().toString('utf16le');
  else value = data.toString('utf8');
  if (/<!DOCTYPE|<!ENTITY/i.test(value) || XMLValidator.validate(value) !== true)
    throw new Error(`XML 部件无效：${name}`);
  return parser.parse(value);
}
const many = (v: any): any[] => (v === undefined ? [] : Array.isArray(v) ? v : [v]);

/** Resolve an OPC relationship without ever extracting a path to disk. */
function relationshipTarget(relsName: string, target: string): string {
  if (/[?#]/.test(target)) target = target.split(/[?#]/)[0];
  let decoded: string;
  try {
    decoded = decodeURIComponent(target);
  } catch {
    throw new Error('文档包含无效的部件引用。');
  }
  if (!decoded || decoded.includes('\\') || /^[a-z]+:/i.test(decoded))
    throw new Error('文档包含无效的内部引用。');
  const ownerDir =
    relsName === '_rels/.rels' ? '' : path.posix.dirname(path.posix.dirname(relsName));
  const resolved = path.posix.normalize(
    decoded.startsWith('/') ? decoded.slice(1) : path.posix.join(ownerDir, decoded),
  );
  if (resolved.startsWith('../')) throw new Error('文档部件引用超出了包范围。');
  return resolved;
}

export async function inspectPackage(
  archive: Archive,
  signal?: AbortSignal,
): Promise<Map<string, string>> {
  const lookup = new Map(archive.entries.map((e) => [e.fileName, e]));
  if (archive.entries.some((e) => e.fileName.toLowerCase().startsWith('_xmlsignatures/')))
    throw new Error('此文档含数字签名，压缩会使签名失效，因此未处理。');
  const typesEntry = lookup.get('[Content_Types].xml');
  const rootEntry = lookup.get('_rels/.rels');
  if (!typesEntry || !rootEntry) throw new Error('文件不是有效的 DOCX 文档包。');
  const types = xml(
    await archive.read(typesEntry, LIMITS.xmlBytes, signal),
    typesEntry.fileName,
  ).Types;
  if (!types) throw new Error('缺少文档内容类型声明。');
  const defaults = new Map<string, string>(
    many(types.Default).map((t) => [
      String(t['@_Extension']).toLowerCase(),
      String(t['@_ContentType']),
    ]),
  );
  const overrides = new Map<string, string>(
    many(types.Override).map((t) => [
      decodeURIComponent(String(t['@_PartName'])).replace(/^\//, ''),
      String(t['@_ContentType']),
    ]),
  );
  const contentType = (name: string) =>
    overrides.get(name) ??
    defaults.get(path.posix.basename(name).split('.').pop()!.toLowerCase()) ??
    '';
  if ([...defaults.values(), ...overrides.values()].some((t) => /digital-signature/i.test(t)))
    throw new Error('此文档含数字签名，无法安全压缩。');
  let mainDocument = '';
  const images = new Map<string, string>();
  for (const entry of archive.entries) {
    checkAbort(signal);
    if (entry.fileName.endsWith('/')) continue;
    if (entry.fileName === '[Content_Types].xml') continue;
    const type = contentType(entry.fileName);
    if (!type) throw new Error(`文档部件缺少内容类型：${entry.fileName}`);
    if (
      type.endsWith('+xml') ||
      type === 'application/xml' ||
      type === 'text/xml' ||
      entry.fileName.endsWith('.rels')
    ) {
      const parsed = xml(await archive.read(entry, LIMITS.xmlBytes, signal), entry.fileName);
      if (!entry.fileName.endsWith('.rels')) continue;
      if (!Object.hasOwn(parsed, 'Relationships'))
        throw new Error(`文档关系部件无效：${entry.fileName}`);
      for (const rel of many(parsed.Relationships.Relationship)) {
        if (rel['@_TargetMode'] === 'External') continue;
        const target = relationshipTarget(entry.fileName, String(rel['@_Target'] ?? ''));
        if (!lookup.has(target)) throw new Error(`文档引用的部件不存在：${target}`);
        const kind = String(rel['@_Type']);
        if (entry.fileName === '_rels/.rels' && kind.endsWith('/officeDocument'))
          mainDocument = target;
        if (
          entry.fileName.startsWith('word/') &&
          kind.endsWith('/image') &&
          !target.startsWith('word/embeddings/')
        ) {
          images.set(target, contentType(target));
        }
      }
    }
  }
  if (
    !mainDocument ||
    contentType(mainDocument) !==
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml'
  )
    throw new Error('只支持普通 DOCX 文档，不支持模板或带宏文档。');
  const document = xml(
    await archive.read(lookup.get(mainDocument)!, LIMITS.xmlBytes, signal),
    mainDocument,
  );
  if (!Object.hasOwn(document, 'document')) throw new Error('DOCX 正文部件无效。');
  return images;
}
