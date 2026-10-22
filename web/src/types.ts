export const PRESETS = {
  clear: {
    label: '清晰优先',
    quality: 90,
    maxSide: 3200,
    description: '保留更多细节，适合打印与归档',
  },
  balanced: {
    label: '均衡',
    quality: 82,
    maxSide: 2400,
    description: '画质与体积的平衡，适合日常使用',
  },
  small: {
    label: '体积优先',
    quality: 70,
    maxSide: 1600,
    description: '更小的文件，适合屏幕阅读与分享',
  },
} as const;
export type Preset = keyof typeof PRESETS;
export type Progress = { percent: number; stage: string };
export type CompressionResult = {
  blob: Blob;
  originalSize: number;
  outputSize: number;
  changedImages: number;
  imageCount: number;
  warnings: string[];
  unchanged: boolean;
  reason: string;
};
export type Task = {
  id: string;
  file: File;
  name: string;
  status: 'waiting' | 'processing' | 'completed' | 'unchanged' | 'failed' | 'cancelled';
  progress: Progress;
  result?: CompressionResult;
  error?: string;
  outputName?: string;
  savedToFolder?: boolean;
};
