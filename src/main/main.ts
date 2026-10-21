import { app, BrowserWindow, dialog, ipcMain, shell, utilityProcess } from 'electron';
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { TaskQueue, type Runner } from './queue';
import { PRESETS, type Result, type Settings, type Preset } from '../shared/types';

// Isolated profile for automated desktop validation only.
if (process.env.DOCZIP_TEST_PROFILE) app.setPath('userData', path.resolve(process.env.DOCZIP_TEST_PROFILE));
let window: BrowserWindow | undefined;
let queue: TaskQueue;
let quitting = false;
const indexFile = path.resolve(__dirname, '../renderer/index.html');
const settingsPath = () => path.join(app.getPath('userData'), 'settings.json');
async function loadSettings(): Promise<Settings> {
  try {
    const value = JSON.parse(await readFile(settingsPath(), 'utf8'));
    return { outputDir: typeof value.outputDir === 'string' ? value.outputDir : '', preset: Object.hasOwn(PRESETS, value.preset) ? value.preset : 'balanced' };
  } catch { return { outputDir: '', preset: 'balanced' }; }
}
let saving = Promise.resolve();
function saveSettings(settings: Settings) {
  saving = saving.catch(() => {}).then(async () => {
    await mkdir(app.getPath('userData'), { recursive: true });
    await writeFile(`${settingsPath()}.tmp`, JSON.stringify(settings, null, 2));
    await rename(`${settingsPath()}.tmp`, settingsPath());
  });
  return saving;
}

const run: Runner = async (task, settings, signal, onProgress) => {
  const tempDir = await mkdtemp(path.join(settings.outputDir, '.doczip-'));
  try {
    if (signal.aborted) throw new Error('任务已取消');
    return await new Promise<Result>((resolve, reject) => {
      const child = utilityProcess.fork(path.join(__dirname, 'worker.cjs'), [], { stdio: 'ignore', serviceName: 'DocZip 图片压缩' });
      let result: Result | undefined, error: string | undefined, timer: NodeJS.Timeout | undefined;
      const abort = () => {
        child.postMessage({ type: 'cancel' });
        timer = setTimeout(() => child.kill(), 40_000);
      };
      signal.addEventListener('abort', abort, { once: true });
      child.on('message', message => {
        if (message.type === 'progress') onProgress(message.progress);
        if (message.type === 'result') result = message.result;
        if (message.type === 'error') error = message.error;
      });
      child.once('exit', code => {
        signal.removeEventListener('abort', abort);
        clearTimeout(timer);
        if (result) resolve(result);
        else reject(new Error(error ?? (signal.aborted ? '任务已取消' : `压缩进程意外退出（${code}）。`)));
      });
      child.once('spawn', () => {
        child.postMessage({ type: 'start', inputPath: task.inputPath, tempDir, settings });
        if (signal.aborted) abort();
      });
    });
  } finally { await rm(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
};

function handle(channel: string, fn: (...args: any[]) => any) {
  ipcMain.handle(channel, (event, ...args) => {
    let trusted = false;
    try { trusted = event.senderFrame === window?.webContents.mainFrame && path.resolve(fileURLToPath(event.senderFrame!.url)) === indexFile; } catch { /* reject */ }
    if (!trusted) throw new Error('请求来源无效。');
    return fn(...args);
  });
}

async function boot() {
  queue = new TaskQueue(await loadSettings(), run, state => {
    if (window && !window.isDestroyed()) window.webContents.send('queue:state', state);
  }, saveSettings);
  handle('queue:get', () => queue.snapshot());
  handle('settings:output', async () => {
    if (queue.busy) throw new Error('本轮任务结束后才能修改输出目录。');
    const selected = await dialog.showOpenDialog(window!, { title: '选择压缩文件的输出目录', properties: ['openDirectory', 'createDirectory'] });
    return selected.canceled ? queue.snapshot() : queue.configure({ outputDir: selected.filePaths[0] });
  });
  handle('settings:preset', (preset: Preset) => queue.configure({ preset }));
  handle('files:pick', async () => {
    const selected = await dialog.showOpenDialog(window!, { title: '添加 Word 文档', properties: ['openFile', 'multiSelections'], filters: [{ name: 'Word 文档', extensions: ['docx'] }] });
    return selected.canceled ? [] : queue.add(selected.filePaths);
  });
  handle('files:add', (paths: unknown) => {
    if (!Array.isArray(paths) || paths.length > 1000 || !paths.every(p => typeof p === 'string')) throw new Error('每次最多添加 1,000 个文件。');
    return queue.add(paths);
  });
  handle('queue:start', () => queue.start());
  handle('queue:pause', () => queue.pause());
  handle('queue:cancel', (id: string) => queue.cancel(id));
  handle('queue:remove', (id: string) => queue.remove(id));
  handle('queue:clear', () => queue.clearFinished());
  handle('output:open', async () => {
    const dir = queue.snapshot().settings.outputDir;
    if (!dir) throw new Error('请先选择输出目录。');
    const error = await shell.openPath(dir);
    if (error) throw new Error(error);
  });
  handle('output:show', (id: string) => {
    const result = queue.snapshot().tasks.find(t => t.id === id)?.result;
    if (result) shell.showItemInFolder(result.outputPath);
  });
  window = new BrowserWindow({
    title: 'DocZip', width: 1180, height: 850, minWidth: 900, minHeight: 680,
    icon: path.join(__dirname, '../renderer/icon.png'),
    backgroundColor: '#f5f7f8', autoHideMenuBar: true, show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'), sandbox: true, contextIsolation: true, nodeIntegration: false,
      spellcheck: false,
    },
  });
  window.removeMenu();
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', event => event.preventDefault());
  window.webContents.session.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
  window.webContents.session.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*'] }, (_details, callback) => callback({ cancel: true }));
  window.on('close', event => {
    if (quitting || !queue.busy) return;
    event.preventDefault();
    void (async () => {
      const answer = await dialog.showMessageBox(window!, {
        type: 'question', title: '退出 DocZip？', message: '退出将取消当前任务并清空等待列表。',
        detail: '已经完成的文件会保留。当前任务正在清理时，窗口会稍后关闭。',
        buttons: ['继续处理', '退出'], defaultId: 0, cancelId: 0,
      });
      if (answer.response !== 1 || quitting) return;
      quitting = true;
      queue.shutdown();
      const timer = setInterval(() => {
        if (!queue.processing) { clearInterval(timer); window?.destroy(); app.quit(); }
      }, 100);
    })();
  });
  window.once('ready-to-show', () => window?.show());
  await window.loadFile(indexFile);
}
const ownsLock = app.requestSingleInstanceLock();
if (!ownsLock) app.quit();
else {
  app.on('second-instance', () => { if (window?.isMinimized()) window.restore(); window?.focus(); });
  app.whenReady().then(boot).catch(error => { dialog.showErrorBox('DocZip 启动失败', String(error)); app.quit(); });
  app.on('window-all-closed', () => app.quit());
}
