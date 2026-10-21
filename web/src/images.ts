import jpeg from 'jpeg-js';
import UPNG from 'upng-js';

const PIXEL_LIMIT = 16_000_000;
export function concat(arrays: Uint8Array[]) {
  const out = new Uint8Array(arrays.reduce((size, a) => size + a.length, 0));
  let offset = 0;
  for (const a of arrays) { out.set(a, offset); offset += a.length; }
  return out;
}
const crcTable = Uint32Array.from({ length: 256 }, (_, n) => {
  for (let k = 0; k < 8; k++) n = (n >>> 1) ^ ((n & 1) ? 0xedb88320 : 0);
  return n >>> 0;
});
function crc(data: Uint8Array) {
  let value = -1;
  for (const b of data) value = crcTable[(value ^ b) & 255] ^ (value >>> 8);
  return (value ^ -1) >>> 0;
}
function dimensions(width: number, height: number) {
  if (!width || !height || width * height > PIXEL_LIMIT) throw new Error('超过网页版 1,600 万像素上限');
}
function resize(data: Uint8Array, width: number, height: number, maxSide: number) {
  const ratio = Math.min(1, maxSide / Math.max(width, height));
  if (ratio === 1) return { data, width, height };
  const canvas = new OffscreenCanvas(width, height);
  const context = canvas.getContext('2d');
  if (!context) throw new Error('浏览器不支持图片处理');
  context.putImageData(new ImageData(new Uint8ClampedArray(data), width, height), 0, 0);
  const w = Math.max(1, Math.round(width * ratio)), h = Math.max(1, Math.round(height * ratio));
  const target = new OffscreenCanvas(w, h);
  const targetContext = target.getContext('2d')!;
  targetContext.imageSmoothingEnabled = true;
  targetContext.imageSmoothingQuality = 'high';
  targetContext.drawImage(canvas, 0, 0, w, h);
  const resized = targetContext.getImageData(0, 0, w, h).data;
  canvas.width = canvas.height = 1;
  target.width = target.height = 1;
  return { data: new Uint8Array(resized.buffer), width: w, height: h };
}
type Segment = { marker: number; data: Uint8Array };
function jpegSegments(data: Uint8Array) {
  if (data[0] !== 255 || data[1] !== 216) throw new Error('JPEG 文件头无效');
  const segments: Segment[] = [];
  let offset = 2;
  while (offset < data.length) {
    if (data[offset] !== 255) throw new Error('JPEG 结构无效');
    const start = offset++;
    while (data[offset] === 255) offset++;
    const marker = data[offset++];
    if (marker === 0xda || marker === 0xd9) return { segments, tail: data.subarray(start) };
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    const size = (data[offset] << 8) | data[offset + 1];
    if (size < 2 || offset + size > data.length) throw new Error('JPEG 部件不完整');
    segments.push({ marker, data: data.subarray(start, offset + size) });
    offset += size;
  }
  throw new Error('JPEG 缺少图像数据');
}
const isMetadata = (marker: number) => (marker >= 0xe0 && marker <= 0xef) || marker === 0xfe;
function compressJpeg(input: Uint8Array, quality: number, maxSide: number) {
  const original = jpegSegments(input);
  const frame = original.segments.find(s => [0xc0, 0xc1, 0xc2].includes(s.marker));
  if (!frame) throw new Error('JPEG 编码方式暂不支持');
  const f = frame.data;
  dimensions((f[7] << 8) | f[8], (f[5] << 8) | f[6]);
  if (f[4] !== 8 || f[9] !== 3) throw new Error('灰度、CMYK 或高位深 JPEG 保留原样');
  const adobe = original.segments.find(s => s.marker === 0xee);
  if (adobe && adobe.data[15] !== 1) throw new Error('特殊色彩空间保留原样');
  // Decode raw samples without browser EXIF autorotation or ICC conversion.
  const raw = jpeg.decode(input, { useTArray: true, formatAsRGBA: true, tolerantDecoding: false, maxResolutionInMP: 16, maxMemoryUsageInMB: 300 });
  const resized = resize(raw.data, raw.width, raw.height, maxSide);
  const encoded = jpeg.encode(resized, quality).data;
  const generated = jpegSegments(encoded);
  return concat([
    new Uint8Array([255, 216]),
    ...original.segments.filter(s => isMetadata(s.marker)).map(s => s.data),
    ...generated.segments.filter(s => !isMetadata(s.marker)).map(s => s.data),
    generated.tail,
  ]);
}
type Chunk = { name: string; data: Uint8Array };
function pngChunks(bytes: Uint8Array): Chunk[] {
  const signature = [137, 80, 78, 71, 13, 10, 26, 10];
  if (!signature.every((v, i) => bytes[i] === v)) throw new Error('PNG 文件头无效');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const chunks: Chunk[] = [];
  for (let i = 8; i < bytes.length;) {
    if (i + 12 > bytes.length) throw new Error('PNG 部件不完整');
    const length = view.getUint32(i);
    const end = i + length + 12;
    if (end > bytes.length) throw new Error('PNG 部件长度无效');
    if (crc(bytes.subarray(i + 4, end - 4)) !== view.getUint32(end - 4)) throw new Error('PNG 校验失败');
    chunks.push({ name: String.fromCharCode(...bytes.subarray(i + 4, i + 8)), data: bytes.subarray(i, end) });
    i = end;
  }
  if (chunks[0]?.name !== 'IHDR' || chunks.at(-1)?.name !== 'IEND') throw new Error('PNG 结构无效');
  return chunks;
}
function compressPng(input: Uint8Array, maxSide: number) {
  const chunks = pngChunks(input);
  const ihdr = new DataView(chunks[0].data.buffer, chunks[0].data.byteOffset);
  dimensions(ihdr.getUint32(8), ihdr.getUint32(12));
  if (chunks.some(c => c.name === 'acTL')) throw new Error('动画 PNG 保留原样');
  if (chunks[0].data[16] !== 8) throw new Error('非 8 位 PNG 保留原样');
  if (![2, 3, 6].includes(chunks[0].data[17])) throw new Error('灰度 PNG 保留原样');
  const original = UPNG.decode(input.slice().buffer);
  const raw = new Uint8Array(UPNG.toRGBA8(original)[0]);
  const resized = resize(raw, original.width, original.height, maxSide);
  // Palette quantisation is disabled; keep RGBA samples lossless at the selected dimensions.
  const encoded = new Uint8Array(UPNG.encode([resized.data.slice().buffer], resized.width, resized.height, 0, undefined, true));
  const generated = pngChunks(encoded);
  const preserve = new Set(['cHRM', 'gAMA', 'iCCP', 'sRGB', 'pHYs', 'eXIf', 'tEXt', 'zTXt', 'iTXt']);
  return concat([encoded.subarray(0, 8), generated[0].data,
    ...chunks.filter(c => preserve.has(c.name)).map(c => c.data),
    ...generated.slice(1).filter(c => !preserve.has(c.name)).map(c => c.data)]);
}
export function compressImage(input: Uint8Array, type: string, quality: number, maxSide: number) {
  if (input.length > 48 * 1024 * 1024) throw new Error('超过网页版单张图片 48 MB 上限');
  return type === 'image/jpeg' ? compressJpeg(input, quality, maxSide) : compressPng(input, maxSide);
}
