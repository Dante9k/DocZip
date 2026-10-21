import { randomUUID } from 'node:crypto';
import { realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { friendlyError, validateOutputDir } from '../core/compress';
import { PRESETS, type QueueState, type Result, type Settings, type Task, type Progress } from '../shared/types';

export type Runner = (task: Task, settings: Settings, signal: AbortSignal, progress: (p: Progress) => void) => Promise<Result>;
export class TaskQueue {
  private state: QueueState;
  private active?: AbortController;
  private pumping = false;
  constructor(settings: Settings, private runner: Runner, private changed: (state: QueueState) => void,
    private saveSettings: (settings: Settings) => Promise<void> = async () => {}) {
    this.state = { tasks: [], settings: { ...settings }, mode: 'idle' };
  }
  snapshot(): QueueState { return structuredClone(this.state); }
  private emit() { this.changed(this.snapshot()); }
  get busy() { return this.state.mode !== 'idle'; }
  get processing() { return this.state.tasks.some(t => t.status === 'processing'); }
  async configure(patch: Partial<Settings>) {
    if (this.busy) throw new Error('请先完成或取消本轮任务，再修改设置。');
    const settings = { ...this.state.settings, ...patch };
    if (!Object.hasOwn(PRESETS, settings.preset)) throw new Error('无效的压缩档位。');
    if (patch.outputDir !== undefined) await validateOutputDir(settings.outputDir);
    if (this.busy) throw new Error('队列已经开始，设置保持不变。');
    // Reserve settings synchronously before persistence to prevent a batch starting with stale values.
    this.state.settings = settings;
    this.emit();
    await this.saveSettings(settings);
    return this.snapshot();
  }
  async add(paths: string[]) {
    const errors: string[] = [];
    for (const input of paths) {
      try {
        if (typeof input !== 'string' || !path.isAbsolute(input)) throw new Error('无效的文件路径。');
        if (path.extname(input).toLowerCase() !== '.docx') throw new Error('只支持 .docx 文件。');
        if (path.basename(input).startsWith('~$')) throw new Error('这是 Word 临时锁文件，请选择原文档。');
        const full = await realpath(input);
        const info = await stat(full);
        if (!info.isFile()) throw new Error('请添加文件，不支持文件夹。');
        if (this.state.tasks.some(t => t.inputPath.toLowerCase() === full.toLowerCase() && ['waiting', 'processing'].includes(t.status))) {
          errors.push(`${path.basename(input)}：已在队列中。`); continue;
        }
        this.state.tasks.push({
          id: randomUUID(), inputPath: full, name: path.basename(full), originalSize: info.size,
          status: 'waiting', progress: { percent: 0, stage: '等待处理' },
        });
      } catch (error) { errors.push(`${path.basename(String(input))}：${friendlyError(error)}`); }
    }
    this.emit();
    if (this.state.mode === 'running') void this.pump();
    return errors;
  }
  async start() {
    if (this.state.mode === 'running' || this.state.mode === 'pausing') return;
    if (!this.state.tasks.some(t => t.status === 'waiting')) { this.state.mode = 'idle'; this.emit(); return; }
    this.state.mode = 'running'; this.emit();
    try { await validateOutputDir(this.state.settings.outputDir); }
    catch (error) { this.state.mode = 'idle'; this.emit(); throw new Error(friendlyError(error)); }
    void this.pump();
  }
  pause() {
    if (this.state.mode === 'running') {
      this.state.mode = this.processing ? 'pausing' : 'paused';
      this.emit();
    }
  }
  cancel(id: string) {
    const task = this.state.tasks.find(t => t.id === id);
    if (task?.status === 'waiting') { task.status = 'cancelled'; task.progress.stage = '已取消'; }
    else if (task?.status === 'processing') {
      task.progress.stage = '正在取消并清理…';
      this.active?.abort();
    }
    this.settlePaused(); this.emit();
  }
  remove(id: string) {
    this.state.tasks = this.state.tasks.filter(t => t.id !== id || t.status !== 'waiting');
    this.settlePaused(); this.emit();
  }
  clearFinished() {
    this.state.tasks = this.state.tasks.filter(t => ['waiting', 'processing'].includes(t.status));
    this.emit();
  }
  shutdown() { this.state.mode = 'paused'; this.active?.abort(); }
  private settlePaused() {
    if (!this.processing && !this.state.tasks.some(t => t.status === 'waiting')) this.state.mode = 'idle';
  }
  private async pump() {
    if (this.pumping) return;
    this.pumping = true;
    const settings = { ...this.state.settings };
    try {
      while (this.state.mode === 'running') {
        const task = this.state.tasks.find(t => t.status === 'waiting');
        if (!task) { this.state.mode = 'idle'; break; }
        const controller = new AbortController();
        this.active = controller;
        task.status = 'processing'; task.progress = { percent: 0, stage: '检查文档' }; this.emit();
        try {
          const result = await this.runner(task, settings, controller.signal, progress => {
            if (!controller.signal.aborted) { task.progress = progress; this.emit(); }
          });
          // Once a result has been committed, a late cancel must not misreport it as cancelled.
          task.result = result;
          task.originalSize = result.originalSize;
          task.status = result.unchanged ? 'unchanged' : 'completed';
          task.progress = { percent: 100, stage: result.unchanged ? '无需压缩' : '完成' };
        } catch (error) {
          task.status = controller.signal.aborted ? 'cancelled' : 'failed';
          task.error = controller.signal.aborted ? undefined : friendlyError(error);
          task.progress.stage = controller.signal.aborted ? '已取消' : '处理失败';
        }
        this.active = undefined;
        // Pause can be requested while the runner promise is pending.
        if ((this.state.mode as QueueState['mode']) === 'pausing') this.state.mode = 'paused';
        this.emit();
      }
    } finally {
      this.pumping = false;
      this.settlePaused();
      this.emit();
    }
  }
}
