import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import yauzl from 'yauzl';
import sharp from 'sharp';

const out = path.resolve('test-results/web');
const input = path.resolve('test-results/desktop/input');
await mkdir(out, { recursive: true });
const browser = await chromium.launch({
  executablePath:
    process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  headless: true,
});
const errors = [],
  requests = [],
  checks = [];
const context = await browser.newContext({
  viewport: { width: 1280, height: 900 },
  acceptDownloads: true,
});
const page = await context.newPage();
page.on('pageerror', (e) => errors.push(String(e)));
context.on('request', (r) => requests.push({ method: r.method(), url: r.url() }));
const file = (n) => path.join(input, n);
const row = (n) => page.locator('.task-row').filter({ has: page.getByText(n, { exact: true }) });
async function upload(...names) {
  await page.locator('input[type=file]').setInputFiles(names.map(file));
}
async function download(locator, name) {
  const pending = page.waitForEvent('download');
  await locator.click();
  const result = await pending;
  await result.saveAs(path.join(out, name));
  return result.suggestedFilename();
}
async function zipEntries(filePath) {
  const zip = await new Promise((resolve, reject) =>
    yauzl.open(filePath, { lazyEntries: true }, (e, z) => (e ? reject(e) : resolve(z))),
  );
  const entries = new Map();
  return new Promise((resolve, reject) => {
    zip.on('error', reject);
    zip.on('end', () => resolve(entries));
    zip.on('entry', (e) => {
      if (e.fileName.endsWith('/')) return zip.readEntry();
      zip.openReadStream(e, (error, stream) => {
        if (error) return reject(error);
        const parts = [];
        stream.on('data', (b) => parts.push(b));
        stream.on('error', reject);
        stream.on('end', () => {
          entries.set(e.fileName, Buffer.concat(parts));
          zip.readEntry();
        });
      });
    });
    zip.readEntry();
  });
}
try {
  await page.goto('http://127.0.0.1:4173');
  await page.getByRole('heading', { name: '文档轻一点，排版照旧。' }).waitFor();
  assert.equal(
    await page.getByRole('button', { name: '开始压缩', exact: true }).isDisabled(),
    true,
  );
  await page.getByRole('button', { name: '下载结果', exact: true }).click();
  await page.screenshot({ path: path.join(out, 'empty.png') });
  await upload('项目报告 含图片.docx', '损坏文档.docx');
  await upload('项目报告 含图片.docx');
  assert.equal(await page.locator('.task-row').count(), 2);
  await page.getByRole('button', { name: '关闭提示' }).click();
  await page.getByRole('button', { name: /开始压缩/ }).click();
  await page.getByRole('button', { name: '暂停队列', exact: true }).click();
  await upload('会议纪要.docx');
  await page.getByText('队列已暂停', { exact: true }).waitFor({ timeout: 180_000 });
  assert.equal(await page.locator('.task-row.processing').count(), 0);
  assert.equal(await page.locator('.task-row.waiting').count(), 2);
  assert.equal(
    await page.getByRole('button', { name: '清晰优先', exact: true }).isDisabled(),
    true,
  );
  const firstText = await row('项目报告 含图片.docx').innerText();
  console.log('Photo result:', firstText);
  assert.match(await row('项目报告 含图片.docx').getAttribute('class'), /completed/);
  await page.getByRole('button', { name: /继续压缩/ }).click();
  await row('会议纪要.docx')
    .locator('.status-label')
    .filter({ hasText: '无需压缩' })
    .waitFor({ timeout: 60_000 });
  assert.match(await row('损坏文档.docx').getAttribute('class'), /failed/);
  checks.push(
    'serial queue, duplicate prevention, append, pause/resume, settings locked, failure continues',
  );
  await download(
    page.getByRole('button', { name: '下载 项目报告 含图片.docx', exact: true }),
    'photo.docx',
  );
  await download(
    page.getByRole('button', { name: '下载 会议纪要.docx', exact: true }),
    'text.docx',
  );
  assert.deepEqual(
    await readFile(path.join(out, 'text.docx')),
    await readFile(file('会议纪要.docx')),
  );
  const original = await zipEntries(file('项目报告 含图片.docx'));
  const result = await zipEntries(path.join(out, 'photo.docx'));
  assert.deepEqual([...result.keys()].sort(), [...original.keys()].sort());
  let changed = 0;
  for (const [name, data] of original) {
    if (!/word\/media\/.*\.(jpg|jpeg|png)$/i.test(name))
      assert.deepEqual(result.get(name), data, name);
    else {
      const oldMeta = await sharp(data).metadata(),
        newMeta = await sharp(result.get(name)).metadata();
      assert.equal(newMeta.format, oldMeta.format);
      assert.equal(newMeta.orientation || 1, oldMeta.orientation || 1);
      assert.equal(newMeta.density, oldMeta.density);
      assert.deepEqual(newMeta.icc, oldMeta.icc);
      assert.equal(newMeta.hasAlpha, oldMeta.hasAlpha);
      assert.ok(Math.max(newMeta.width, newMeta.height) <= 2400);
      assert.ok(result.get(name).length <= data.length);
      if (!result.get(name).equals(data)) changed++;
    }
  }
  assert.equal(changed, 2);
  checks.push(
    'all non-image parts byte-identical, JPEG orientation/density/ICC preserved, PNG transparency, both images smaller, no-image exact copy',
  );
  await download(page.getByRole('button', { name: /打包下载全部结果/ }), 'all.zip');
  assert.equal((await zipEntries(path.join(out, 'all.zip'))).size, 2);
  await page.screenshot({ path: path.join(out, 'results.png') });
  await row('项目报告 含图片.docx').getByRole('button', { name: '详情' }).click();
  await page.screenshot({ path: path.join(out, 'details.png') });
  await page.getByRole('button', { name: '关闭详情' }).click();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: path.join(out, 'mobile.png'), fullPage: true });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.getByRole('button', { name: '清除已结束', exact: true }).click();
  await page.getByRole('button', { name: '确认清除', exact: true }).click();
  await upload('项目报告 含图片.docx', '会议纪要.docx');
  await page.getByRole('button', { name: /开始压缩/ }).click();
  await page.getByRole('button', { name: '取消', exact: true }).click();
  await row('会议纪要.docx').locator('.status-label').filter({ hasText: '无需压缩' }).waitFor();
  assert.match(await row('项目报告 含图片.docx').getAttribute('class'), /cancelled/);
  checks.push(
    'ZIP download, clear with confirmation, cancel active and continue, mobile no horizontal overflow',
  );
  // Exercise actual browser file-system streams with OPFS, substituting only the native picker.
  const folderPage = await context.newPage();
  folderPage.on('pageerror', (e) => errors.push(String(e)));
  await folderPage.addInitScript(() => {
    window.showDirectoryPicker = async () => {
      const root = await navigator.storage.getDirectory();
      const folder = await root.getDirectoryHandle('DocZip-test', { create: true });
      for await (const name of folder.keys()) await folder.removeEntry(name);
      const handle = await folder.getFileHandle('会议纪要_light.docx', { create: true });
      const writer = await handle.createWritable();
      await writer.write('existing file');
      await writer.close();
      return folder;
    };
  });
  await folderPage.goto('http://127.0.0.1:4173');
  await folderPage.getByRole('button', { name: /选择本机的保存文件夹/ }).click();
  await folderPage.locator('input[type=file]').setInputFiles(file('会议纪要.docx'));
  await folderPage.getByRole('button', { name: /开始压缩/ }).click();
  await folderPage.getByText('无需压缩 · 已保存', { exact: true }).waitFor({ timeout: 30_000 });
  const saved = await folderPage.evaluate(async () => {
    const root = await navigator.storage.getDirectory(),
      dir = await root.getDirectoryHandle('DocZip-test');
    const existing = await (await dir.getFileHandle('会议纪要_light.docx')).getFile();
    const output = await (await dir.getFileHandle('会议纪要_light_1.docx')).getFile();
    return {
      existing: await existing.text(),
      bytes: Array.from(new Uint8Array(await output.arrayBuffer())),
    };
  });
  assert.equal(saved.existing, 'existing file');
  assert.deepEqual(Buffer.from(saved.bytes), await readFile(file('会议纪要.docx')));
  await folderPage.screenshot({ path: path.join(out, 'folder.png') });
  checks.push('folder save with real writable streams, collision numbering without overwrite');
  const fallback = await context.newPage();
  await fallback.addInitScript(() => {
    delete window.showDirectoryPicker;
  });
  await fallback.goto('http://127.0.0.1:4173');
  assert.equal(await fallback.getByRole('button', { name: '选择文件夹', exact: true }).count(), 0);
  assert.equal(
    await fallback
      .getByRole('button', { name: '下载结果', exact: true })
      .getAttribute('aria-pressed'),
    'true',
  );
  checks.push('unsupported folder API automatically uses downloads');
  assert.deepEqual(errors, []);
  assert.ok(
    requests.every((r) => r.method === 'GET' && r.url.startsWith('http://127.0.0.1:4173/')),
    JSON.stringify(requests),
  );
  checks.push('no document upload, no external network requests, no page errors');
  const sizes = {
    input: (await readFile(file('项目报告 含图片.docx'))).length,
    output: (await readFile(path.join(out, 'photo.docx'))).length,
  };
  await writeFile(
    path.join(out, 'report.json'),
    JSON.stringify({ checks, sizes, requests, errors }, null, 2),
  );
  console.log(JSON.stringify({ checks, sizes }, null, 2));
} catch (error) {
  await page.screenshot({ path: path.join(out, 'failure.png'), fullPage: true }).catch(() => {});
  console.error(await page.locator('body').innerText());
  throw error;
} finally {
  await browser.close();
}
