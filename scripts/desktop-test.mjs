import { _electron as electron } from 'playwright';
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import electronPath from 'electron';
import { setTimeout as delay } from 'node:timers/promises';

const dir = path.resolve('test-results', 'desktop');
const tag = process.env.DOCZIP_EXE ? 'packaged' : 'development';
const profile = path.join(dir, `profile-${tag}`);
const output = path.join(dir, `output-${tag}`);
await mkdir(profile, { recursive: true });
await mkdir(output, { recursive: true });
await writeFile(
  path.join(profile, 'settings.json'),
  JSON.stringify({ outputDir: '', preset: 'balanced' }),
);
const env = { ...process.env, DOCZIP_TEST_PROFILE: profile };
delete env.ELECTRON_RUN_AS_NODE;
const application = await electron.launch({
  executablePath: process.env.DOCZIP_EXE || electronPath,
  args: process.env.DOCZIP_EXE ? [] : ['.'],
  env,
  timeout: 30_000,
});
const errors = [];
const processHandle = application.process();
async function waitForState(page, predicate) {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const state = await page.evaluate(() => window.doczip.getState());
    if (predicate(state)) return state;
    await delay(100);
  }
  throw new Error('Timed out waiting for queue state');
}
try {
  const page = await application.firstWindow();
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.getByRole('heading', { name: '文档轻一点，排版照旧。' }).waitFor();
  assert.equal(await page.getByRole('button', { name: '开始压缩' }).isDisabled(), true);
  await page.screenshot({ path: path.join(dir, `${tag}-empty.png`) });
  // Use the real UI and IPC, substituting only native dialog selections.
  await application.evaluate(({ dialog }, outputDir) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [outputDir] });
  }, output);
  await page.getByRole('button', { name: '选择输出文件夹' }).click();
  await page.getByRole('button', { name: '体积优先' }).click();
  await page.getByRole('button', { name: /均衡/ }).click();
  const input = path.join(dir, 'input');
  const paths = ['项目报告 含图片.docx', '损坏文档.docx', '会议纪要.docx'].map((n) =>
    path.join(input, n),
  );
  // File-backed native file input makes the drop exercise webUtils.getPathForFile.
  await page.evaluate(() => {
    const input = document.createElement('input');
    input.type = 'file';
    input.id = 'smoke-upload';
    input.multiple = true;
    input.style.display = 'none';
    document.body.append(input);
  });
  await page.locator('#smoke-upload').setInputFiles(paths);
  await page.evaluate(() => {
    const transfer = new DataTransfer();
    for (const file of document.getElementById('smoke-upload').files) transfer.items.add(file);
    document
      .querySelector('.dropzone')
      .dispatchEvent(new DragEvent('drop', { dataTransfer: transfer, bubbles: true }));
  });
  await waitForState(page, (state) => state.tasks.length === 3);
  await page.getByRole('button', { name: /开始压缩/ }).click();
  const state = await waitForState(
    page,
    (state) =>
      state.mode === 'idle' &&
      state.tasks.every((t) => !['waiting', 'processing'].includes(t.status)),
  );
  assert.deepEqual(
    state.tasks.map((t) => t.status),
    ['completed', 'failed', 'unchanged'],
  );
  assert.equal(state.tasks[0].result.changedImages, 2);
  assert.equal(state.tasks[0].result.warnings.length, 0);
  assert.ok(state.tasks[0].result.outputSize < state.tasks[0].originalSize);
  assert.deepEqual(await readFile(paths[2]), await readFile(state.tasks[2].result.outputPath));
  assert.equal(await page.locator('.task-row').count(), 3);
  await page.screenshot({ path: path.join(dir, `${tag}-results.png`) });
  const browserWindow = await application.browserWindow(page);
  await browserWindow.evaluate((window) => window.setSize(900, 680));
  await delay(150);
  assert.equal(
    await page.locator('.queue-footer').evaluate((element) => {
      const box = element.getBoundingClientRect();
      return box.top >= 0 && box.bottom <= window.innerHeight;
    }),
    true,
    'Queue controls must remain visible at minimum window size',
  );
  await page.screenshot({ path: path.join(dir, `${tag}-small-window.png`) });
  await browserWindow.evaluate((window) => window.setSize(1180, 850));
  await page.getByRole('button', { name: '详情' }).first().click();
  await page.getByRole('dialog').waitFor();
  await page.screenshot({ path: path.join(dir, `${tag}-detail.png`) });
  await page.getByRole('button', { name: '关闭详情' }).click();
  // Check the second input path through the native file picker.
  await application.evaluate(
    ({ dialog }, files) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: files });
    },
    [paths[2]],
  );
  await page.getByRole('button', { name: '添加文件' }).click();
  await waitForState(page, (state) => state.tasks.length === 4);
  await page.getByRole('button', { name: '删除 会议纪要.docx' }).click();
  await page.getByRole('button', { name: '清除已结束' }).click();
  await page.getByRole('heading', { name: '下一份轻巧文档，从这里开始' }).waitFor();
  const settings = JSON.parse(await readFile(path.join(profile, 'settings.json'), 'utf8'));
  assert.equal(settings.outputDir, output);
  assert.equal(settings.preset, 'balanced');
  assert.deepEqual(errors, []);
  await writeFile(
    path.join(dir, `${tag}-report.json`),
    JSON.stringify({ errors, state, settings }, null, 2),
  );
  console.log(
    JSON.stringify(
      {
        mode: tag,
        tasks: state.tasks.map((t) => ({
          name: t.name,
          status: t.status,
          before: t.originalSize,
          after: t.result?.outputSize,
        })),
        errors,
      },
      null,
      2,
    ),
  );
} catch (error) {
  console.error('Desktop test failed:', error);
  const pages = application.windows();
  if (pages[0]) {
    await pages[0].screenshot({ path: path.join(dir, `${tag}-failure.png`) }).catch(() => {});
    console.error(
      await pages[0].evaluate(() => document.body.innerText).catch(() => 'No page text'),
    );
  }
  process.exitCode = 1;
} finally {
  // app.quit can trigger the normal unsaved-queue dialog after a failed assertion.
  await application
    .evaluate(({ app }) => {
      setTimeout(() => app.exit(0), 50);
    })
    .catch(() => {});
  await delay(500);
  processHandle.kill();
  process.exit(process.exitCode ?? 0);
}
