import { compressDocx } from './compress';
import type { Preset } from './types';
self.onmessage = async (event: MessageEvent<{ file: File; preset: Preset }>) => {
  try {
    const result = await compressDocx(event.data.file, event.data.preset, progress => self.postMessage({ type: 'progress', progress }));
    self.postMessage({ type: 'result', result });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const reason = /File format is not recognized|End of central directory|Invalid (signature|CRC|uncompressed size)|overlapping|unexpected end/i.test(message)
      ? '文档包损坏或不是有效的 DOCX，请用 Word 检查并重新保存。'
      : message;
    self.postMessage({ type: 'error', error: reason });
  }
};
