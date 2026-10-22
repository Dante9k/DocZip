import {
  BlobReader,
  BlobWriter,
  ZipWriter,
  configure,
} from '@zip.js/zip.js/lib/zip-core-external.js';
import { PRESETS, type Task, type Preset, type CompressionResult } from './types';
configure({ useWebWorkers: false, useCompressionStream: true });
export type BrowserTask = Omit<Task, 'result'> & { result?: Omit<CompressionResult, 'blob'> };
export type State = {
  tasks: BrowserTask[];
  mode: 'idle' | 'running' | 'pausing' | 'paused';
  preset: Preset;
  outputMode: 'folder' | 'download';
  folderName: string;
  notice: string[];
};
type Folder = FileSystemDirectoryHandle & {
  requestPermission(options: { mode: string }): Promise<string>;
};
const cancelled = () => new Error('任务已取消');
export class BrowserQueue {
  private state: State;
  private listeners = new Set<(state: State) => void>();
  private folder?: Folder;
  private active?: AbortController;
  private pumping = false;
  private outputs = new Map<string, { blob?: Blob; handle?: FileSystemFileHandle }>();
  readonly supportsFolder = 'showDirectoryPicker' in window;
  constructor() {
    let preset: Preset = 'balanced';
    try {
      const saved = localStorage.getItem('doczip:preset');
      if (saved && Object.hasOwn(PRESETS, saved)) preset = saved as Preset;
    } catch {}
    this.state = {
      tasks: [],
      mode: 'idle',
      preset,
      outputMode: this.supportsFolder ? 'folder' : 'download',
      folderName: '',
      notice: [],
    };
  }
  snapshot() {
    return {
      ...this.state,
      tasks: this.state.tasks.map((t) => ({ ...t, progress: { ...t.progress } })),
    };
  }
  subscribe(listener: (state: State) => void) {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
  private emit() {
    for (const listener of this.listeners) listener(this.snapshot());
  }
  notice(messages: string[]) {
    this.state.notice = messages;
    this.emit();
  }
  configure(preset?: Preset, mode?: 'folder' | 'download') {
    if (this.state.mode !== 'idle') return;
    if (preset) {
      this.state.preset = preset;
      try {
        localStorage.setItem('doczip:preset', preset);
      } catch {}
    }
    if (mode) this.state.outputMode = mode;
    this.emit();
  }
  async chooseFolder() {
    if (this.state.mode !== 'idle') return;
    try {
      const folder = (await (window as any).showDirectoryPicker({
        id: 'doczip-output',
        mode: 'readwrite',
      })) as Folder;
      if (this.state.mode !== 'idle') return;
      this.folder = folder;
      this.state.folderName = folder.name;
      this.state.outputMode = 'folder';
      this.emit();
    } catch (error) {
      if ((error as Error).name !== 'AbortError')
        this.notice(['浏览器未允许访问文件夹，请切换到“下载结果”模式。']);
    }
  }
  add(files: File[]) {
    const errors: string[] = [];
    for (const file of files) {
      if (!/\.docx$/i.test(file.name) || file.name.startsWith('~$')) {
        errors.push(file.name + '：请选择普通 .docx 文档。');
        continue;
      }
      if (file.size > 200 * 1024 * 1024) {
        errors.push(file.name + '：超过网页版 200 MB 上限，请使用桌面版。');
        continue;
      }
      if (
        this.state.tasks.some(
          (t) =>
            ['waiting', 'processing'].includes(t.status) &&
            t.name === file.name &&
            t.file.size === file.size &&
            t.file.lastModified === file.lastModified,
        )
      ) {
        errors.push(file.name + '：已在等待或处理中。');
        continue;
      }
      this.state.tasks.push({
        id: crypto.randomUUID(),
        file,
        name: file.name,
        status: 'waiting',
        progress: { percent: 0, stage: '等待处理' },
      });
    }
    if (errors.length) this.state.notice = errors;
    this.emit();
    if (this.state.mode === 'running') void this.pump();
  }
  start() {
    if (['running', 'pausing'].includes(this.state.mode)) return;
    if (this.state.outputMode === 'folder' && !this.folder) {
      this.notice(['请先选择保存文件夹，或切换为下载结果。']);
      return;
    }
    if (!this.state.tasks.some((t) => t.status === 'waiting')) return;
    this.state.mode = 'running';
    this.emit();
    void this.pump();
  }
  pause() {
    if (this.state.mode === 'running') {
      this.state.mode = this.active ? 'pausing' : 'paused';
      this.emit();
    }
  }
  cancel(id: string) {
    const task = this.state.tasks.find((t) => t.id === id);
    if (task?.status === 'processing') {
      task.progress.stage = '正在取消…';
      this.active?.abort();
    }
    if (task?.status === 'waiting') {
      task.status = 'cancelled';
      task.progress.stage = '已取消';
    }
    this.settle();
    this.emit();
  }
  remove(id: string) {
    this.state.tasks = this.state.tasks.filter((t) => t.id !== id || t.status !== 'waiting');
    this.settle();
    this.emit();
  }
  clear() {
    for (const t of this.state.tasks)
      if (!['waiting', 'processing'].includes(t.status)) this.outputs.delete(t.id);
    this.state.tasks = this.state.tasks.filter((t) => ['waiting', 'processing'].includes(t.status));
    this.emit();
  }
  private settle() {
    if (!this.state.tasks.some((t) => ['waiting', 'processing'].includes(t.status)))
      this.state.mode = 'idle';
  }
  private runWorker(
    file: File,
    preset: Preset,
    signal: AbortSignal,
    task: BrowserTask,
  ): Promise<CompressionResult> {
    return new Promise((resolve, reject) => {
      const worker = new Worker(new URL('./worker.js', location.href), { type: 'module' });
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error('文档处理超过 3 分钟，请使用桌面版'));
      }, 180_000);
      const cleanup = () => {
        worker.terminate();
        clearTimeout(timer);
        signal.removeEventListener('abort', abort);
      };
      const abort = () => {
        cleanup();
        reject(cancelled());
      };
      signal.addEventListener('abort', abort, { once: true });
      worker.onerror = (event) => {
        cleanup();
        reject(new Error(event.message || '浏览器图片处理进程出错'));
      };
      worker.onmessage = ({ data }) => {
        if (data.type === 'progress') {
          task.progress = data.progress;
          this.emit();
        }
        if (data.type === 'result') {
          cleanup();
          resolve(data.result);
        }
        if (data.type === 'error') {
          cleanup();
          reject(new Error(data.error));
        }
      };
      if (signal.aborted) abort();
      else worker.postMessage({ file, preset });
    });
  }
  private async saveToFolder(blob: Blob, name: string, signal: AbortSignal) {
    const base = name.replace(/\.docx$/i, '') + '_light';
    for (let n = 0; n < 10_000; n++) {
      if (signal.aborted) throw cancelled();
      const target = base + (n ? '_' + n : '') + '.docx';
      try {
        await this.folder!.getFileHandle(target);
        continue;
      } catch (e) {
        if ((e as Error).name !== 'NotFoundError') throw e;
      }
      const handle = await this.folder!.getFileHandle(target, { create: true });
      // The browser API has no atomic create-exclusive operation. Recheck before opening a writer.
      if ((await handle.getFile()).size !== 0) continue;
      let writable: FileSystemWritableFileStream | undefined;
      const abort = () => {
        void writable?.abort().catch(() => {});
      };
      try {
        writable = await handle.createWritable({ mode: 'exclusive' } as any);
        signal.addEventListener('abort', abort, { once: true });
        if (signal.aborted) throw cancelled();
        await writable.write(blob);
        if (signal.aborted) throw cancelled();
        await writable.close();
        return { handle, name: target };
      } catch (error) {
        await writable?.abort().catch(() => {});
        // Remove only the empty placeholder, never a file another program populated.
        if ((await handle.getFile().catch(() => undefined))?.size === 0)
          await this.folder!.removeEntry(target).catch(() => {});
        throw error;
      } finally {
        signal.removeEventListener('abort', abort);
      }
    }
    throw new Error('重名文件过多，请选择其他文件夹');
  }
  private async pump() {
    if (this.pumping) return;
    this.pumping = true;
    const preset = this.state.preset;
    try {
      while (this.state.mode === 'running') {
        const task = this.state.tasks.find((t) => t.status === 'waiting');
        if (!task) {
          this.state.mode = 'idle';
          break;
        }
        const controller = new AbortController();
        this.active = controller;
        task.status = 'processing';
        task.progress = { percent: 0, stage: '检查文档' };
        this.emit();
        try {
          const { blob, ...result } = await this.runWorker(
            task.file,
            preset,
            controller.signal,
            task,
          );
          if (controller.signal.aborted) throw cancelled();
          task.result = result;
          task.outputName = task.name.replace(/\.docx$/i, '') + '_light.docx';
          this.outputs.set(task.id, { blob });
          if (this.state.outputMode === 'folder') {
            task.progress = { percent: 99, stage: '保存到文件夹' };
            this.emit();
            const saved = await this.saveToFolder(blob, task.name, controller.signal);
            task.outputName = saved.name;
            task.savedToFolder = true;
            this.outputs.set(task.id, { handle: saved.handle });
          } else {
            const names = new Set(
              this.state.tasks.filter((t) => t.id !== task.id && t.result).map((t) => t.outputName),
            );
            let n = 1;
            while (names.has(task.outputName))
              task.outputName = task.name.replace(/\.docx$/i, '') + '_light_' + n++ + '.docx';
          }
          task.status = result.unchanged ? 'unchanged' : 'completed';
          task.progress = { percent: 100, stage: task.savedToFolder ? '已保存' : '可下载' };
        } catch (error) {
          task.status = controller.signal.aborted ? 'cancelled' : 'failed';
          task.error = controller.signal.aborted
            ? undefined
            : ((error as Error).message || '处理失败') +
              (task.result ? '。压缩结果仍可下载。' : '');
          if (controller.signal.aborted) {
            this.outputs.delete(task.id);
            task.result = undefined;
          }
          task.progress.stage = controller.signal.aborted ? '已取消' : '处理失败';
        }
        this.active = undefined;
        if ((this.state.mode as string) === 'pausing') this.state.mode = 'paused';
        this.emit();
      }
    } finally {
      this.pumping = false;
      this.settle();
      this.emit();
    }
  }
  async download(id: string) {
    const output = this.outputs.get(id);
    const task = this.state.tasks.find((t) => t.id === id);
    if (!output || !task) return;
    const blob = output.blob ?? (await output.handle!.getFile());
    download(blob, task.outputName!);
  }
  async downloadAll() {
    const writer = new ZipWriter(new BlobWriter('application/zip'));
    const used = new Set<string>();
    for (const task of this.state.tasks.filter((t) => t.result)) {
      const output = this.outputs.get(task.id);
      if (!output) continue;
      const base = task.outputName!.replace(/\.docx$/i, '');
      let name = base + '.docx',
        n = 1;
      while (used.has(name)) name = base + '_' + n++ + '.docx';
      used.add(name);
      await writer.add(name, new BlobReader(output.blob ?? (await output.handle!.getFile())), {
        level: 0,
      });
    }
    download(await writer.close(), 'DocZip_压缩结果.zip');
  }
}
function download(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}
