import sharp from 'sharp';
import { writeFile, mkdir } from 'node:fs/promises';
await mkdir('dist/renderer', { recursive: true });
const sizes = [16, 32, 48, 64, 128, 256];
const images = await Promise.all(sizes.map(size => sharp('assets/icon.svg').resize(size, size).png().toBuffer()));
const header = Buffer.alloc(6 + images.length * 16);
header.writeUInt16LE(1, 2); header.writeUInt16LE(images.length, 4);
let offset = header.length;
for (let i = 0; i < images.length; i++) {
  const base = 6 + i * 16;
  header[base] = sizes[i] % 256; header[base + 1] = sizes[i] % 256;
  header.writeUInt16LE(1, base + 4); header.writeUInt16LE(32, base + 6);
  header.writeUInt32LE(images[i].length, base + 8); header.writeUInt32LE(offset, base + 12);
  offset += images[i].length;
}
await writeFile('assets/icon.ico', Buffer.concat([header, ...images]));
await writeFile('dist/renderer/icon.png', images.at(-1));
