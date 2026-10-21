import { compressDocx, friendlyError } from '../core/compress';
import type { Settings } from '../shared/types';

const controller = new AbortController();
let started = false;
process.parentPort.on('message', async ({ data }: { data: { type: string; inputPath: string; tempDir: string; settings: Settings } }) => {
  if (data.type === 'cancel') { controller.abort(); return; }
  if (data.type !== 'start' || started) return;
  started = true;
  try {
    const result = await compressDocx({
      inputPath: data.inputPath, tempDir: data.tempDir, ...data.settings, signal: controller.signal,
      onProgress: progress => process.parentPort.postMessage({ type: 'progress', progress }),
    });
    process.parentPort.postMessage({ type: 'result', result });
  } catch (error) { process.parentPort.postMessage({ type: 'error', error: friendlyError(error) }); }
  setTimeout(() => process.exit(0), 20);
});
