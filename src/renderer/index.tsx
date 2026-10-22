import React, { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { PRESETS, type DocZipAPI, type Preset, type QueueState, type Task } from '../shared/types';
import './style.css';

declare global {
  interface Window {
    doczip: DocZipAPI;
  }
}
type IconName =
  | 'file'
  | 'folder'
  | 'upload'
  | 'arrow'
  | 'check'
  | 'pause'
  | 'play'
  | 'close'
  | 'shield'
  | 'trash'
  | 'chevron';
function Icon({ name, size = 18 }: { name: IconName; size?: number }) {
  const paths: Record<IconName, React.ReactNode> = {
    file: (
      <>
        <path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z" />
        <path d="M14 3v6h6M8 13h8M8 17h5" />
      </>
    ),
    folder: (
      <path d="M3 7V5a1 1 0 0 1 1-1h5l2 3h9a1 1 0 0 1 1 1v11a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V7z" />
    ),
    upload: (
      <>
        <path d="M12 16V3m-5 5 5-5 5 5M4 15v5h16v-5" />
      </>
    ),
    arrow: (
      <>
        <path d="M4 12h16m-6-6 6 6-6 6" />
      </>
    ),
    check: <path d="m5 12 4 4L19 6" />,
    pause: (
      <>
        <path d="M8 5v14M16 5v14" />
      </>
    ),
    play: <path d="m8 4 12 8-12 8z" />,
    close: <path d="m6 6 12 12M6 18 18 6" />,
    shield: (
      <>
        <path d="m12 3 8 3v6c0 5-8 9-8 9s-8-4-8-9V6z" />
        <path d="m8 12 3 3 5-6" />
      </>
    ),
    trash: (
      <>
        <path d="M3 6h18M9 6V3h6v3M6 6l1 15h10l1-15M10 10v7M14 10v7" />
      </>
    ),
    chevron: <path d="m9 5 7 7-7 7" />,
  };
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {paths[name]}
    </svg>
  );
}
function bytes(n: number) {
  if (n === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const i = Math.min(3, Math.floor(Math.log(n) / Math.log(1024)));
  return `${(n / 1024 ** i).toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}
function App() {
  const [state, setState] = useState<QueueState>();
  const [notices, setNotices] = useState<string[]>([]);
  const [dragging, setDragging] = useState(false);
  const [detail, setDetail] = useState<string>();
  const dragDepth = useRef(0);
  const api = window.doczip;
  useEffect(() => {
    const stop = api.onState(setState);
    void api
      .getState()
      .then(setState)
      .catch((error) => setNotices([String(error)]));
    return stop;
  }, []);
  const action = async (fn: () => Promise<unknown>) => {
    try {
      const result = await fn();
      if (Array.isArray(result) && result.length) setNotices(result);
    } catch (error) {
      setNotices([
        String(error)
          .replace(/^Error: Error invoking remote method '[^']+': Error: /, '')
          .replace(/^Error: /, ''),
      ]);
    }
  };
  if (!state) return <div className="loading">正在打开 DocZip…</div>;
  const tasks = state.tasks;
  const locked = state.mode !== 'idle';
  const waiting = tasks.filter((t) => t.status === 'waiting').length;
  const active = tasks.findIndex((t) => t.status === 'processing');
  const finished = tasks.filter((t) => !['waiting', 'processing'].includes(t.status)).length;
  const success = tasks.filter((t) => t.result).length;
  const saving = tasks.reduce(
    (total, t) => total + (t.result ? t.result.originalSize - t.result.outputSize : 0),
    0,
  );
  const selection = tasks.find((t) => t.id === detail);
  const addFiles = () => action(() => api.pickFiles());
  const modes = {
    idle: '准备就绪',
    running: '正在处理',
    pausing: '当前文件完成后暂停',
    paused: '队列已暂停',
  };
  return (
    <div className="app" onDragOver={(e) => e.preventDefault()} onDrop={(e) => e.preventDefault()}>
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark">
            <Icon name="file" size={23} />
            <span />
          </span>
          <strong>
            DocZip<span className="brand-dot">.</span>
          </strong>
          <span className="brand-divider" />
          <span className="brand-caption">Word 图片压缩</span>
        </div>
        <span className="local-badge">
          <span />
          本地处理 · 文件不上传
        </span>
      </header>
      <main>
        <div className="heading">
          <div>
            <p className="eyebrow">LESS SIZE. SAME LAYOUT.</p>
            <h1>文档轻一点，排版照旧。</h1>
            <p className="intro">批量压缩 Word 中的图片，保留图片的位置与显示尺寸。</p>
          </div>
          <div className="version">
            DESKTOP <span>v1.0</span>
          </div>
        </div>
        <section className="settings panel" aria-label="压缩设置">
          <div className="output-setting">
            <label>
              <span className="step">01</span>保存到<span className="required">必选</span>
            </label>
            <button
              className={`folder-picker ${!state.settings.outputDir ? 'placeholder' : ''}`}
              disabled={locked}
              onClick={() => action(() => api.chooseOutput())}
              title={state.settings.outputDir || '选择输出文件夹'}
            >
              <Icon name="folder" />
              <span>{state.settings.outputDir || '选择输出文件夹'}</span>
              <span className="folder-change">
                {locked ? '已锁定' : '选择'}
                <Icon name="chevron" size={13} />
              </span>
            </button>
            <small>
              原文件名 + <code>_light.docx</code>
              <span className="separator">·</span>重名自动编号
            </small>
          </div>
          <div className="preset-setting">
            <label>
              <span className="step">02</span>压缩档位
            </label>
            <div className="presets" role="group" aria-label="压缩档位">
              {Object.entries(PRESETS).map(([key, preset]) => (
                <button
                  key={key}
                  disabled={locked}
                  aria-pressed={state.settings.preset === key}
                  className={state.settings.preset === key ? 'selected' : ''}
                  onClick={() => action(() => api.setPreset(key as Preset))}
                  title={`JPEG 质量 ${preset.quality}，像素长边上限 ${preset.maxSide}`}
                >
                  {preset.label}
                  {key === 'balanced' && <span className="recommend">推荐</span>}
                </button>
              ))}
            </div>
            <small>
              {locked
                ? '本轮设置已固定，任务结束后可修改'
                : PRESETS[state.settings.preset].description + ' · 文档中的显示尺寸不变'}
            </small>
          </div>
        </section>
        <section
          className={`dropzone ${dragging ? 'dragging' : ''}`}
          onDragEnter={(e) => {
            e.preventDefault();
            dragDepth.current++;
            setDragging(true);
          }}
          onDragLeave={(e) => {
            e.preventDefault();
            if (--dragDepth.current <= 0) {
              dragDepth.current = 0;
              setDragging(false);
            }
          }}
          onDrop={(e) => {
            e.preventDefault();
            dragDepth.current = 0;
            setDragging(false);
            void action(() => api.addDroppedFiles(Array.from(e.dataTransfer.files)));
          }}
          aria-label="拖入 DOCX 文件"
        >
          <div className="drop-icon">
            <Icon name="upload" size={26} />
          </div>
          <div className="drop-copy">
            <h2>{dragging ? '松开鼠标，添加到任务列表' : '把 Word 文件拖到这里'}</h2>
            <p>支持多个 .docx 文件，每个文件独立排队处理</p>
          </div>
          <button className="secondary add-button" onClick={addFiles}>
            添加文件
            <Icon name="arrow" size={17} />
          </button>
        </section>
        {notices.length > 0 && (
          <div className="notice" role="alert">
            <div>
              {notices.map((n, i) => (
                <p key={i}>{n}</p>
              ))}
            </div>
            <button className="icon-button" aria-label="关闭提示" onClick={() => setNotices([])}>
              <Icon name="close" />
            </button>
          </div>
        )}
        <section className="queue panel" aria-label="任务列表">
          <div className="queue-header">
            <h2>
              任务列表 <span className="count">{tasks.length.toString().padStart(2, '0')}</span>
            </h2>
            <div className="queue-tools">
              <span className={`queue-indicator ${state.mode === 'running' ? 'live' : ''}`} />
              <span>{modes[state.mode]}</span>
              <span className="separator">/</span>
              <button
                className="text-button"
                disabled={!finished}
                onClick={() => action(() => api.clearFinished())}
              >
                清除已结束
              </button>
            </div>
          </div>
          {tasks.length === 0 ? (
            <div className="empty">
              <div className="empty-files">
                <Icon name="file" size={31} />
                <span>
                  <Icon name="check" size={12} />
                </span>
              </div>
              <h3>下一份轻巧文档，从这里开始</h3>
              <p>添加文件、选择输出目录，然后点击「开始压缩」。</p>
              <div className="empty-tags">
                <span>保留原件</span>
                <span>逐个处理</span>
                <span>排版数据校验</span>
              </div>
            </div>
          ) : (
            <div className="task-scroll">
              <div className="table-head">
                <span>文件名称</span>
                <span>文件大小</span>
                <span>处理状态</span>
                <span>操作</span>
              </div>
              {tasks.map((task, index) => (
                <TaskRow
                  key={task.id}
                  task={task}
                  index={index}
                  onAction={action}
                  onDetail={() => setDetail(task.id)}
                />
              ))}
            </div>
          )}
          <div className="queue-footer">
            <div className="summary">
              <span>
                已完成 <b>{success}</b> / {tasks.length}
              </span>
              <span className="separator">·</span>
              <span>
                节省空间 <b className="saved">{bytes(saving)}</b>
              </span>
            </div>
            <div className="run-actions">
              {active >= 0 && (
                <span className="current-file">
                  当前 {active + 1} / {tasks.length}
                </span>
              )}
              {state.mode === 'running' || state.mode === 'pausing' ? (
                <button
                  className="secondary"
                  disabled={state.mode === 'pausing'}
                  onClick={() => action(() => api.pause())}
                >
                  <Icon name="pause" size={16} />
                  {state.mode === 'pausing' ? '等待暂停' : '暂停队列'}
                </button>
              ) : (
                <button
                  className="primary"
                  disabled={!waiting || !state.settings.outputDir}
                  onClick={() => action(() => api.start())}
                >
                  <Icon name="play" size={15} />
                  {state.mode === 'paused' ? '继续压缩' : '开始压缩'}
                  {waiting > 0 && <span className="button-count">{waiting}</span>}
                </button>
              )}
            </div>
          </div>
        </section>
        <footer className="footnote">
          <span>
            <Icon name="shield" size={15} />
            原件始终保留 · 仅处理嵌入的 JPEG / PNG 图片
          </span>
          <button
            className="text-button"
            disabled={!state.settings.outputDir}
            onClick={() => action(() => api.openOutput())}
          >
            <Icon name="folder" size={15} />
            打开输出目录
            <Icon name="arrow" size={14} />
          </button>
        </footer>
      </main>
      {selection && (
        <div className="modal-backdrop" onClick={() => setDetail(undefined)}>
          <section
            className="detail-dialog"
            role="dialog"
            aria-modal="true"
            aria-label="任务详情"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="detail-header">
              <h2>任务详情</h2>
              <button
                className="icon-button"
                aria-label="关闭详情"
                autoFocus
                onClick={() => setDetail(undefined)}
              >
                <Icon name="close" />
              </button>
            </div>
            <h3>{selection.name}</h3>
            <p className="path">{selection.inputPath}</p>
            {selection.result && (
              <>
                <p className="result-reason">{selection.result.reason}</p>
                <div className="detail-stat">
                  <span>
                    {bytes(selection.result.originalSize)} <Icon name="arrow" size={15} />{' '}
                    {bytes(selection.result.outputSize)}
                  </span>
                  <span>
                    压缩图片 {selection.result.changedImages} / {selection.result.imageCount}
                  </span>
                </div>
                <label>输出文件</label>
                <p className="path">{selection.result.outputPath}</p>
                {selection.result.warnings.length > 0 && (
                  <>
                    <h4>以下图片已保留原样</h4>
                    <ul>
                      {selection.result.warnings.map((w, i) => (
                        <li key={i}>{w}</li>
                      ))}
                    </ul>
                  </>
                )}
                <button
                  className="secondary"
                  onClick={() => action(() => api.showResult(selection.id))}
                >
                  <Icon name="folder" />
                  在文件夹中查看
                </button>
              </>
            )}
            {selection.error && <p className="error-text">{selection.error}</p>}
          </section>
        </div>
      )}
    </div>
  );
}
function TaskRow({
  task,
  index,
  onAction,
  onDetail,
}: {
  task: Task;
  index: number;
  onAction: (fn: () => Promise<unknown>) => void;
  onDetail: () => void;
}) {
  const label = {
    waiting: '等待处理',
    processing: task.progress.stage,
    completed: task.result?.warnings.length ? '完成，有跳过项' : '压缩完成',
    unchanged: '无需压缩',
    failed: '处理失败',
    cancelled: '已取消',
  }[task.status];
  const percent =
    task.result && task.result.originalSize > 0
      ? Math.round((1 - task.result.outputSize / task.result.originalSize) * 100)
      : 0;
  return (
    <div className={`task-row ${task.status}`}>
      <div className="task-name">
        <span className="task-number">{String(index + 1).padStart(2, '0')}</span>
        <div className="file-icon">
          <Icon name="file" size={21} />
        </div>
        <div className="task-name-text">
          <strong title={task.inputPath}>{task.name}</strong>
          <small>{task.error || (task.result ? task.result.reason : 'Word 文档 · DOCX')}</small>
        </div>
      </div>
      <div className="task-size">
        {task.result ? (
          <>
            <strong>{bytes(task.result.outputSize)}</strong>
            <small>
              {bytes(task.originalSize)}
              {percent > 0 && <em>−{percent}%</em>}
            </small>
          </>
        ) : (
          <span>{bytes(task.originalSize)}</span>
        )}
      </div>
      <div className="task-status">
        <span className="status-label">
          <span className="status-dot" />
          {label}
        </span>
        {task.status === 'processing' && (
          <div className="progress-track">
            <span style={{ width: `${task.progress.percent}%` }} />
            <small>{task.progress.percent}%</small>
          </div>
        )}
      </div>
      <div className="task-actions">
        {task.status === 'waiting' ? (
          <>
            <button
              className="icon-button"
              aria-label={`取消 ${task.name}`}
              onClick={() => onAction(() => window.doczip.cancel(task.id))}
            >
              <Icon name="close" size={16} />
            </button>
            <button
              className="icon-button"
              aria-label={`删除 ${task.name}`}
              onClick={() => onAction(() => window.doczip.remove(task.id))}
            >
              <Icon name="trash" size={16} />
            </button>
          </>
        ) : task.status === 'processing' ? (
          <button
            className="text-button"
            onClick={() => onAction(() => window.doczip.cancel(task.id))}
            disabled={task.progress.stage.startsWith('正在取消')}
          >
            取消
          </button>
        ) : (
          task.status !== 'cancelled' && (
            <button className="text-button" onClick={onDetail}>
              详情
              <Icon name="chevron" size={13} />
            </button>
          )
        )}
      </div>
    </div>
  );
}
createRoot(document.getElementById('root')!).render(<App />);
