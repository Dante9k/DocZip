import sharp from 'sharp';
import yazl from 'yazl';
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream, constants } from 'node:fs';
import { copyFile, link, mkdir, mkdtemp, open, rm, stat, unlink } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import { Transform, Readable } from 'node:stream';
import path from 'node:path';
import { Archive, checkAbort, crcUpdate, hash, inspectPackage, LIMITS } from './archive';
import { PRESETS, type Preset, type Progress, type Result } from '../shared/types';

sharp.cache({ memory: 32, files: 0, items: 16 });
sharp.concurrency(1);

export type CompressOptions = {
  inputPath: string;
  outputDir: string;
  preset: Preset;
  signal?: AbortSignal;
  onProgress?: (progress: Progress) => void;
  tempDir?: string;
};
export async function validateOutputDir(directory: string) {
  if (!path.isAbsolute(directory)) throw new Error('请先选择输出文件夹。');
  if (!(await stat(directory)).isDirectory()) throw new Error('输出位置不是文件夹。');
  const probe = path.join(directory, `.doczip-write-${randomUUID()}`);
  const handle = await open(probe, 'wx');
  await handle.close();
  await unlink(probe);
}
export function friendlyError(error: unknown): string {
  const e = error as NodeJS.ErrnoException;
  const codes: Record<string, string> = {
    EACCES: '没有读取文件或写入输出目录的权限。',
    EPERM: '文件被占用或没有操作权限，请关闭占用文件的程序后重试。',
    ENOSPC: '磁盘空间不足，请释放空间或更换输出目录。',
    ENOENT: '文件或输出目录不存在，可能已被移动或删除。',
    EBUSY: '文件正在被其他程序占用，请稍后重试。',
  };
  return codes[e?.code ?? ''] ?? e?.message ?? String(error);
}
async function digestFile(file: string, signal?: AbortSignal) {
  const h = createHash('sha256');
  for await (const chunk of createReadStream(file)) {
    checkAbort(signal);
    h.update(chunk);
  }
  return h.digest('hex');
}
/** Link provides an atomic, no-overwrite commit on NTFS. FAT/exFAT uses COPYFILE_EXCL. */
async function commit(temp: string, outputDir: string, input: string, signal?: AbortSignal) {
  const base = path.basename(input, path.extname(input));
  for (let index = 0; index < 100_000; index++) {
    checkAbort(signal);
    const target = path.join(outputDir, `${base}_light${index ? `_${index}` : ''}.docx`);
    try {
      try {
        await link(temp, target);
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (!['EXDEV', 'ENOTSUP', 'ENOSYS', 'EPERM', 'EINVAL'].includes(code ?? '')) throw error;
        await copyFile(temp, target, constants.COPYFILE_EXCL);
      }
      return target;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
  }
  throw new Error('输出文件重名过多，请更换目录。');
}

export async function compressDocx(options: CompressOptions): Promise<Result> {
  const { inputPath, outputDir, preset, signal, onProgress = () => {} } = options;
  if (path.extname(inputPath).toLowerCase() !== '.docx') throw new Error('只支持 .docx 文件。');
  if (!Object.hasOwn(PRESETS, preset)) throw new Error('无效的压缩档位。');
  checkAbort(signal);
  await validateOutputDir(outputDir);
  const original = await stat(inputPath);
  if (!original.isFile()) throw new Error('输入必须是文件。');
  const head = await open(inputPath, 'r');
  try {
    const magic = Buffer.alloc(8);
    await head.read(magic, 0, 8, 0);
    if (magic.toString('hex') === 'd0cf11e0a1b11ae1')
      throw new Error('此文件可能已加密，或属于旧版 DOC 格式；请先另存为未加密的 DOCX。');
  } finally {
    await head.close();
  }
  const tempDir = options.tempDir ?? (await mkdtemp(path.join(outputDir, '.doczip-')));
  if (
    path.dirname(path.resolve(tempDir)) !== path.resolve(outputDir) ||
    !path.basename(tempDir).startsWith('.doczip-')
  )
    throw new Error('临时目录必须位于输出文件夹内，并使用 DocZip 专用名称。');
  await mkdir(tempDir, { recursive: true });
  let archive: Archive | undefined;
  let resultArchive: Archive | undefined;
  let zip: yazl.ZipFile | undefined;
  let writing: Promise<void> | undefined;
  const tempFile = path.join(tempDir, 'result.tmp');
  try {
    onProgress({ percent: 2, stage: '检查文档' });
    archive = await Archive.open(inputPath);
    const images = await inspectPackage(archive, signal);
    const expected = new Map<string, string>();
    const warnings: string[] = [];
    let changedImages = 0,
      imageIndex = 0;
    const config = PRESETS[preset];
    zip = new yazl.ZipFile();
    zip.on('error', (error) => (zip!.outputStream as Readable).destroy(error));
    writing = pipeline(zip.outputStream, createWriteStream(tempFile, { flags: 'wx' }), { signal });
    // Observe immediately, including failures while Sharp is working.
    let writeError: unknown;
    void writing.catch((error) => {
      writeError = error;
    });
    for (const entry of archive.entries) {
      checkAbort(signal);
      if (writeError) throw writeError;
      const name = entry.fileName;
      if (name.endsWith('/')) {
        zip.addEmptyDirectory(name, { mtime: entry.getLastModDate() });
        continue;
      }
      if (images.has(name)) {
        imageIndex++;
        onProgress({
          percent: 8 + Math.round((65 * imageIndex) / images.size),
          stage: `处理图片 ${imageIndex} / ${images.size}`,
        });
      }
      const type = images.get(name);
      const supported =
        (type === 'image/jpeg' && /\.(jpe?g|jfif)$/i.test(name)) ||
        (type === 'image/png' && /\.png$/i.test(name));
      if (supported && entry.uncompressedSize <= LIMITS.imageBytes) {
        // Corrupt ZIP data must fail the document, not become an image warning.
        const data = await archive.read(entry, LIMITS.imageBytes, signal);
        let replacement: Buffer = data;
        try {
          const img = sharp(data, { limitInputPixels: LIMITS.pixels, failOn: 'warning' });
          const metadata = await img.metadata();
          if ((metadata.pages ?? 1) > 1) throw new Error('动画或多页图片保持原样');
          if (
            !['jpeg', 'png'].includes(metadata.format ?? '') ||
            (type === 'image/jpeg' && metadata.format !== 'jpeg') ||
            (type === 'image/png' && metadata.format !== 'png')
          )
            throw new Error('实际图片格式与声明不一致');
          if (metadata.depth !== 'uchar') throw new Error('高位深图片保持原样');
          const encoder = img
            .keepMetadata()
            .resize({
              width: config.maxSide,
              height: config.maxSide,
              fit: 'inside',
              withoutEnlargement: true,
            })
            .timeout({ seconds: 30 });
          const candidate = await (
            metadata.format === 'jpeg'
              ? encoder.jpeg({ quality: config.quality, chromaSubsampling: '4:4:4' })
              : encoder.png({ compressionLevel: 9, adaptiveFiltering: true, palette: false })
          ).toBuffer();
          checkAbort(signal);
          const checked = await sharp(candidate, { limitInputPixels: LIMITS.pixels }).metadata();
          if (
            checked.format !== metadata.format ||
            checked.hasAlpha !== metadata.hasAlpha ||
            (checked.orientation ?? 1) !== (metadata.orientation ?? 1) ||
            checked.density !== metadata.density ||
            (metadata.icc && !checked.icc?.equals(metadata.icc))
          )
            throw new Error('图片格式、透明度或元数据校验不一致');
          if (candidate.length < data.length) {
            replacement = candidate;
            changedImages++;
          }
        } catch (error) {
          checkAbort(signal);
          warnings.push(`${path.posix.basename(name)}：${friendlyError(error)}，已保留原图。`);
        }
        expected.set(name, hash(replacement));
        // Wait until this buffer is consumed before decoding another picture.
        const consumed = new Promise<void>((resolve, reject) => {
          const source = Readable.from([replacement]);
          source.on('end', resolve);
          source.on('error', reject);
          zip!.addReadStream(source, name, { mtime: entry.getLastModDate(), compress: false });
        });
        await Promise.race([consumed, writing]);
      } else {
        if (images.has(name))
          warnings.push(
            `${path.posix.basename(name)}：${supported ? '图片超过 64 MB 上限' : '此图片格式暂不压缩'}，已保留原图。`,
          );
        const input = await archive.stream(entry);
        const digest = createHash('sha256');
        let crc = -1,
          length = 0;
        const checked = new Transform({
          transform(chunk: Buffer, _encoding, callback) {
            try {
              checkAbort(signal);
              length += chunk.length;
              crc = crcUpdate(crc, chunk);
              digest.update(chunk);
              callback(null, chunk);
            } catch (error) {
              callback(error as Error);
            }
          },
          flush(callback) {
            if (length !== entry.uncompressedSize || (crc ^ -1) >>> 0 !== entry.crc32)
              callback(new Error(`文档部件校验失败：${name}`));
            else {
              expected.set(name, digest.digest('hex'));
              callback();
            }
          },
        });
        const transferred = pipeline(input, checked, { signal });
        void transferred.catch(() => {});
        zip.addReadStream(checked, name, {
          mtime: entry.getLastModDate(),
          compress: entry.compressionMethod !== 0,
        });
        await Promise.race([transferred, writing]);
      }
    }
    onProgress({ percent: 78, stage: '写入和校验' });
    zip.end();
    await writing;
    checkAbort(signal);
    resultArchive = await Archive.open(tempFile);
    if (resultArchive.entries.length !== archive.entries.length)
      throw new Error('输出文档的部件数量校验失败。');
    let verified = 0;
    for (const entry of resultArchive.entries) {
      checkAbort(signal);
      if (entry.fileName.endsWith('/')) continue;
      const digest = createHash('sha256');
      let crc = -1;
      for await (const chunk of await resultArchive.stream(entry)) {
        checkAbort(signal);
        digest.update(chunk);
        crc = crcUpdate(crc, chunk);
      }
      if (digest.digest('hex') !== expected.get(entry.fileName) || (crc ^ -1) >>> 0 !== entry.crc32)
        throw new Error(`输出文档内容校验失败：${entry.fileName}`);
      onProgress({
        percent: 80 + Math.round((15 * ++verified) / resultArchive.entries.length),
        stage: '写入和校验',
      });
    }
    resultArchive.close();
    resultArchive = undefined;
    archive.close();
    archive = undefined;
    let outputSize = (await stat(tempFile)).size;
    const unchanged = changedImages === 0 || outputSize >= original.size;
    let reason = '图片压缩完成，排版数据已校验。';
    if (unchanged) {
      reason =
        images.size === 0
          ? '未发现可处理的嵌入图片，已输出原文件副本。'
          : changedImages === 0
            ? '图片已足够小或无法进一步压缩，已输出原文件副本。'
            : '压缩后总体积未减小，已输出原文件副本。';
      await copyFile(inputPath, tempFile);
      if ((await digestFile(inputPath, signal)) !== (await digestFile(tempFile, signal)))
        throw new Error('原件副本校验失败。');
      outputSize = original.size;
      changedImages = 0;
    }
    const latest = await stat(inputPath);
    if (latest.size !== original.size || latest.mtimeMs !== original.mtimeMs)
      throw new Error('原文件在处理期间发生变化，请关闭编辑程序后重新添加。');
    checkAbort(signal);
    const sync = await open(tempFile, 'r+');
    try {
      await sync.sync();
    } finally {
      await sync.close();
    }
    const outputPath = await commit(tempFile, outputDir, inputPath, signal);
    onProgress({ percent: 100, stage: unchanged ? '无需压缩' : '完成' });
    return {
      outputPath,
      originalSize: original.size,
      outputSize,
      changedImages,
      imageCount: images.size,
      warnings,
      unchanged,
      reason,
    };
  } finally {
    (zip?.outputStream as Readable | undefined)?.destroy();
    if (writing) await writing.catch(() => {});
    resultArchive?.close();
    archive?.close();
    await rm(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}
