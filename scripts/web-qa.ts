// Browser integration checks. Built only into the local test server, never shipped.
import { BrowserQueue } from '../web/src/queue';
import { ZipReader, BlobReader, Uint8ArrayWriter } from '../web/node_modules/@zip.js/zip.js/lib/zip-core-external.js';
import UPNG from '../web/node_modules/upng-js';
import jpeg from '../web/node_modules/jpeg-js';
const output = document.querySelector('pre')!;
const log = (message: string) => { output.textContent += message + '\n'; };
function check(value: unknown, message: string) { if (!value) throw new Error(message); }
const hash = async (blob: Blob) => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', await blob.arrayBuffer()))).join(',');
const fixture = async (name: string) => new File([await (await fetch('__qa/' + name)).blob()], name);
async function done(queue: BrowserQueue) {
  const deadline = Date.now() + 180_000;
  while (Date.now() < deadline) {
    if (queue.snapshot().mode === 'idle') return queue.snapshot();
    await new Promise(r => setTimeout(r, 40));
  }
  throw new Error('Queue timeout');
}
async function entries(blob: Blob) {
  const reader = new ZipReader(new BlobReader(blob));
  const result = new Map<string, Uint8Array>();
  try { for (const entry of await reader.getEntries()) if (!entry.directory) result.set(entry.filename, await entry.getData(new Uint8ArrayWriter(), { checkSignature: true })); }
  finally { await reader.close(); }
  return result;
}
async function run() {
  log('正在运行浏览器集成检查…');
  const text = await fixture('会议纪要.docx'), photo = await fixture('项目报告 含图片.docx');
  const root = await navigator.storage.getDirectory();
  const dirname = 'doczip-qa-' + crypto.randomUUID();
  const folder = await root.getDirectoryHandle(dirname, { create: true });
  try {
    (window as any).showDirectoryPicker = async () => folder;
    const old = await folder.getFileHandle('会议纪要_light.docx', { create: true });
    const w = await old.createWritable(); await w.write('existing content'); await w.close();
    const queue = new BrowserQueue();
    await queue.chooseFolder(); queue.add([text, text]);
    check(queue.snapshot().tasks.length === 1, 'Duplicate file was added');
    queue.start();
    const state = await done(queue);
    check(state.tasks[0].status === 'unchanged', JSON.stringify(state.tasks));
    check(state.tasks[0].outputName === '会议纪要_light_1.docx', 'Collision numbering failed');
    const saved = await (await folder.getFileHandle('会议纪要_light_1.docx')).getFile();
    check(await saved.text() !== 'existing content', 'Incorrect output');
    check(await (await old.getFile()).text() === 'existing content', 'Existing file overwritten');
    check(await hash(saved) === await hash(text), 'No-image document changed');
    log('PASS 文件夹事务写入、中文路径、重名编号、原件完整副本、重复任务过滤');
    const cancelled = new BrowserQueue(); await cancelled.chooseFolder();
    cancelled.add([photo, text]); cancelled.start();
    cancelled.cancel(cancelled.snapshot().tasks[0].id);
    const cancelledState = await done(cancelled);
    check(cancelledState.tasks[0].status === 'cancelled' && cancelledState.tasks[1].status === 'unchanged', 'Cancel did not continue');
    log('PASS 取消当前压缩后继续下一个任务');
    const downloadQueue = new BrowserQueue(); downloadQueue.configure(undefined, 'download');
    downloadQueue.add([photo, new File(['invalid'], '坏文件.docx'), text]);
    let maxActive = 0;
    downloadQueue.subscribe(state => { maxActive = Math.max(maxActive, state.tasks.filter(t => t.status === 'processing').length); });
    downloadQueue.start();
    const results = await done(downloadQueue);
    check(maxActive === 1, 'Queue not serial');
    check(results.tasks.map(t => t.status).join(',') === 'completed,failed,unchanged', JSON.stringify(results.tasks));
    const downloads: { blob: Blob; name: string }[] = [];
    const realClick = HTMLAnchorElement.prototype.click;
    // Observe generated download links without triggering native save prompts in an automated test.
    HTMLAnchorElement.prototype.click = function () { void fetch(this.href).then(r => r.blob()).then(blob => downloads.push({ blob, name: this.download })); };
    try {
      await downloadQueue.download(results.tasks[0].id);
      while (!downloads.length) await new Promise(r => setTimeout(r, 20));
      const before = await entries(photo), after = await entries(downloads[0].blob);
      check(before.size === after.size, 'Package entries changed');
      for (const [name, bytes] of before) {
        if (!name.startsWith('word/media/')) check(await hash(new Blob([bytes])) === await hash(new Blob([after.get(name)!])), 'Non-image part changed: ' + name);
      }
      const jpg = [...after.entries()].find(([name]) => name.endsWith('.jpg'))![1];
      const jpgMeta = jpeg.decode(jpg, { useTArray: true, formatAsRGBA: true });
      check(jpgMeta.width === 2400 && jpgMeta.height === 1600, 'JPEG resize dimensions incorrect');
      const png = [...after.entries()].find(([name]) => name.endsWith('.png'))![1];
      const pngMeta = UPNG.decode(png.slice().buffer);
      const alpha = new Uint8Array(UPNG.toRGBA8(pngMeta)[0]);
      check(pngMeta.width === 2400 && alpha.some((v, i) => i % 4 === 3 && v < 255), 'PNG alpha or resize incorrect');
      log('PASS 照片及透明 PNG 实际缩像素、非图片部件逐字节一致、串行压缩和失败后继续');
      log('大小：' + photo.size + ' → ' + downloads[0].blob.size + ' 字节');
      await downloadQueue.downloadAll();
      while (downloads.length < 2) await new Promise(r => setTimeout(r, 20));
      check((await entries(downloads[1].blob)).size === 2, 'Bundle output incorrect');
      log('PASS 单文件下载数据、打包下载数据与输出文件名');
    } finally { HTMLAnchorElement.prototype.click = realClick; }
    const denied = new BrowserQueue();
    let cleaned = false;
    (window as any).showDirectoryPicker = async () => ({ name: 'mock denied folder', getFileHandle: async (_name: string, options?: { create: boolean }) => {
      if (!options?.create) throw new DOMException('missing', 'NotFoundError');
      return { getFile: async () => new File([], 'empty'), createWritable: async () => { throw new DOMException('空间不足', 'QuotaExceededError'); } };
    }, removeEntry: async () => { cleaned = true; } });
    await denied.chooseFolder(); denied.add([text]); denied.start();
    const failed = await done(denied);
    check(failed.tasks[0].status === 'failed' && failed.tasks[0].result && cleaned, 'Failed write did not retain result/clean placeholder');
    log('PASS 写入失败保留下载结果并清理空占位文件');
    log('ALL CHECKS PASSED');
    document.title = 'DocZip QA PASSED';
  } finally { await root.removeEntry(dirname, { recursive: true }); }
}
run().catch(e => { log('FAIL ' + e.stack); document.title = 'DocZip QA FAILED'; });
