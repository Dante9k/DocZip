export const PRESETS = {
  clear: { label: '清晰优先', quality: 90, maxSide: 3200, description: '保留更多图片细节' },
  balanced: { label: '均衡', quality: 82, maxSide: 2400, description: '画质与体积之间的平衡' },
  small: { label: '体积优先', quality: 70, maxSide: 1600, description: '适合屏幕阅读与分享' },
} as const;

export type Preset = keyof typeof PRESETS;
export type Settings = { outputDir: string; preset: Preset };
export type Progress = { percent: number; stage: string };
export type Result = {
  outputPath: string;
  originalSize: number;
  outputSize: number;
  changedImages: number;
  imageCount: number;
  warnings: string[];
  unchanged: boolean;
  reason: string;
};
export type TaskStatus = 'waiting' | 'processing' | 'completed' | 'unchanged' | 'failed' | 'cancelled';
export type Task = {
  id: string;
  inputPath: string;
  name: string;
  originalSize: number;
  status: TaskStatus;
  progress: Progress;
  result?: Result;
  error?: string;
};
export type QueueState = {
  tasks: Task[];
  mode: 'idle' | 'running' | 'pausing' | 'paused';
  settings: Settings;
};
export type DocZipAPI = {
  getState(): Promise<QueueState>;
  chooseOutput(): Promise<QueueState>;
  setPreset(preset: Preset): Promise<QueueState>;
  pickFiles(): Promise<string[]>;
  addDroppedFiles(files: File[]): Promise<string[]>;
  start(): Promise<void>;
  pause(): Promise<void>;
  cancel(id: string): Promise<void>;
  remove(id: string): Promise<void>;
  clearFinished(): Promise<void>;
  openOutput(): Promise<void>;
  showResult(id: string): Promise<void>;
  onState(callback: (state: QueueState) => void): () => void;
};
