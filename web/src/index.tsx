import React, { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserQueue, type BrowserTask } from './queue';
import { PRESETS, type Preset } from './types';
import './base.css';
import './web.css';

const queue = new BrowserQueue();
type IconName = 'file' | 'folder' | 'upload' | 'check' | 'close' | 'play' | 'pause' | 'download' | 'shield' | 'arrow';
function Icon({ name, size = 18 }: { name: IconName; size?: number }) {
  const paths: Record<IconName, React.ReactNode> = {
    file: <><path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><path d="M14 3v6h6M8 13h8M8 17h5"/></>,
    folder: <path d="M3 7V5a1 1 0 0 1 1-1h5l2 3h9a1 1 0 0 1 1 1v11a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V7z"/>,
    upload: <><path d="M12 16V3m-5 5 5-5 5 5M4 15v5h16v-5"/></>,
    check: <path d="m5 12 4 4L19 6"/>,
    close: <path d="m6 6 12 12M6 18 18 6"/>,
    play: <path d="m8 4 12 8-12 8z"/>,
    pause: <path d="M8 5v14M16 5v14"/>,
    download: <><path d="M12 3v12m-5-5 5 5 5-5M4 16v5h16v-5"/></>,
    shield: <><path d="m12 3 8 3v6c0 5-8 9-8 9s-8-4-8-9V6z"/><path d="m8 12 3 3 5-6"/></>,
    arrow: <path d="M4 12h16m-6-6 6 6-6 6"/>,
  };
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name]}</svg>;
}
const bytes = (n: number) => n < 1024 ? n + ' B' : n < 1024 * 1024 ? (n / 1024).toFixed(1) + ' KB' : (n / 1024 / 1024).toFixed(1) + ' MB';
function App() {
  const [state, setState] = useState(queue.snapshot());
  const [dragging, setDragging] = useState(false);
  const [detail, setDetail] = useState<string>();
  const [bundling, setBundling] = useState(false);
  const [confirmClear, setConfirmClear] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const dragDepth = useRef(0);
  useEffect(() => queue.subscribe(setState), []);
  useEffect(() => {
    const leave = (event: BeforeUnloadEvent) => {
      if (state.mode !== 'idle' || state.tasks.some(t => t.result && !t.savedToFolder)) { event.preventDefault(); event.returnValue = ''; }
    };
    addEventListener('beforeunload', leave);
    return () => removeEventListener('beforeunload', leave);
  }, [state]);
  useEffect(() => {
    if (!detail && !confirmClear) return;
    const escape = (e: KeyboardEvent) => { if (e.key === 'Escape') { setDetail(undefined); setConfirmClear(false); } };
    addEventListener('keydown', escape); return () => removeEventListener('keydown', escape);
  }, [detail, confirmClear]);
  const action = async (fn: () => Promise<unknown>) => {
    try { await fn(); } catch (e) { queue.notice([(e as Error).message || '操作失败，请重试。']); }
  };
  const waiting = state.tasks.filter(t => t.status === 'waiting').length;
  const completed = state.tasks.filter(t => ['completed', 'unchanged'].includes(t.status)).length;
  const ended = state.tasks.filter(t => !['waiting', 'processing'].includes(t.status)).length;
  const results = state.tasks.filter(t => t.result);
  const saving = results.reduce((sum, t) => sum + t.result!.originalSize - t.result!.outputSize, 0);
  const locked = state.mode !== 'idle';
  const canStart = waiting > 0 && (state.outputMode === 'download' || !!state.folderName);
  const selected = state.tasks.find(t => t.id === detail);
  const stateLabel = { idle: '准备就绪', running: '正在处理', pausing: '当前文件完成后暂停', paused: '队列已暂停' }[state.mode];
  const bundle = async () => { setBundling(true); try { await action(() => queue.downloadAll()); } finally { setBundling(false); } };
  return <div className="app web-app" onDragOver={e => e.preventDefault()} onDrop={e => e.preventDefault()}>
    <header className="topbar"><div className="brand"><img src="./icon.svg" width="37" height="37" alt=""/><strong>DocZip<span className="brand-dot">.</span></strong><span className="web-badge">WEB</span><span className="brand-divider"/><span className="brand-caption">Word 图片压缩</span></div><span className="local-badge"><span/>浏览器本地处理 · 文件不上传</span></header>
    <main>
      <div className="heading"><div><p className="eyebrow">LESS SIZE. SAME LAYOUT.</p><h1>文档轻一点，排版照旧。</h1><p className="intro">打开网页就能用。批量压缩 Word 图片，保留位置与显示尺寸。</p></div><div className="web-privacy"><Icon name="shield" size={29}/><span>你的文档<br/><b>始终留在你的设备</b></span></div></div>
      <section className="settings panel" aria-label="压缩设置">
        <div className="output-setting"><div className="setting-title"><label><span className="step">01</span>保存方式</label><div className="mode-switch" role="group" aria-label="保存方式">
          {queue.supportsFolder && <button disabled={locked} aria-pressed={state.outputMode === 'folder'} className={state.outputMode === 'folder' ? 'chosen' : ''} onClick={() => queue.configure(undefined, 'folder')}>选择文件夹</button>}
          <button disabled={locked} aria-pressed={state.outputMode === 'download'} className={state.outputMode === 'download' ? 'chosen' : ''} onClick={() => queue.configure(undefined, 'download')}>下载结果</button>
        </div></div>
          {state.outputMode === 'folder' ? <button className="folder-picker" disabled={locked} onClick={() => action(() => queue.chooseFolder())}><Icon name="folder"/><span>{state.folderName || '选择本机的保存文件夹'}</span><span className="folder-change">{locked ? '已锁定' : '选择'}<Icon name="arrow" size={13}/></span></button> : <div className="download-mode"><Icon name="download"/><span>完成后逐个下载，或打包下载全部结果</span><span className="format-tag">DOCX</span></div>}
          <small>{state.outputMode === 'folder' ? '原文件名 + _light.docx · 检测到重名自动编号' : '结果保存在本页 · 离开或刷新前请先下载'}</small>
        </div>
        <div className="preset-setting"><label><span className="step">02</span>压缩档位</label><div className="presets" role="group" aria-label="压缩档位">
          {Object.entries(PRESETS).map(([key, p]) => <button key={key} disabled={locked} aria-pressed={state.preset === key} className={state.preset === key ? 'selected' : ''} onClick={() => queue.configure(key as Preset)} title={'JPEG 质量 ' + p.quality + '，像素长边 ' + p.maxSide}>{p.label}{key === 'balanced' && <span className="recommend">推荐</span>}</button>)}
        </div><small>{locked ? '本轮设置已固定，任务结束后可修改' : PRESETS[state.preset].description}</small></div>
      </section>
      <input ref={fileInput} type="file" accept=".docx" multiple hidden aria-label="添加 DOCX 文件" onChange={e => { queue.add(Array.from(e.target.files ?? [])); e.target.value = ''; }}/>
      <section className={'dropzone ' + (dragging ? 'dragging' : '')} aria-label="拖入 DOCX 文件"
        onDragEnter={e => { e.preventDefault(); dragDepth.current++; setDragging(true); }}
        onDragLeave={() => { if (--dragDepth.current <= 0) { dragDepth.current = 0; setDragging(false); } }}
        onDrop={e => { e.preventDefault(); dragDepth.current = 0; setDragging(false); queue.add(Array.from(e.dataTransfer.files)); }}>
        <div className="drop-icon"><Icon name="upload" size={27}/></div><div className="drop-copy"><h2>{dragging ? '松开鼠标，添加到任务列表' : '把 Word 文件拖到这里'}</h2><p>支持多个 .docx 文件 · 每个文件独立排队 · 单个文件不超过 200 MB</p></div><button className="secondary add-button" onClick={() => fileInput.current?.click()}>添加文件<Icon name="arrow" size={17}/></button>
      </section>
      {!!state.notice.length && <div className="notice" role="alert"><div>{state.notice.map((n, i) => <p key={i}>{n}</p>)}</div><button className="icon-button" aria-label="关闭提示" onClick={() => queue.notice([])}><Icon name="close"/></button></div>}
      <section className="queue panel" aria-label="任务列表"><div className="queue-header"><h2>任务列表 <span className="count">{String(state.tasks.length).padStart(2, '0')}</span></h2><div className="queue-tools"><span className={'queue-indicator ' + (state.mode === 'running' ? 'live' : '')}/><span>{stateLabel}</span><span className="separator">/</span><button className="text-button" disabled={!ended} onClick={() => { if (results.some(t => !t.savedToFolder)) setConfirmClear(true); else queue.clear(); }}>清除已结束</button></div></div>
        {!state.tasks.length ? <div className="empty"><div className="empty-files"><Icon name="file" size={32}/><span><Icon name="check" size={12}/></span></div><h3>下一份轻巧文档，从这里开始</h3><p>添加文件、选择压缩档位，然后点击「开始压缩」。</p><div className="empty-tags"><span>保留原件</span><span>逐个处理</span><span>排版数据校验</span></div></div> : <div className="task-scroll"><div className="table-head"><span>文件名称</span><span>文件大小</span><span>处理状态</span><span>操作</span></div>
          {state.tasks.map((task, i) => <TaskRow key={task.id} task={task} index={i} details={() => setDetail(task.id)} download={() => action(() => queue.download(task.id))}/>)}
        </div>}
        <div className="queue-footer"><div className="summary"><span>已完成 <b>{completed}</b> / {state.tasks.length}</span><span className="separator">·</span><span>节省空间 <b className="saved">{bytes(saving)}</b></span></div><div className="run-actions">
          {state.mode === 'running' || state.mode === 'pausing' ? <button className="secondary" disabled={state.mode === 'pausing'} onClick={() => queue.pause()}><Icon name="pause" size={16}/>{state.mode === 'pausing' ? '等待暂停' : '暂停队列'}</button> : <button className="primary" disabled={!canStart} onClick={() => queue.start()}><Icon name="play" size={15}/>{state.mode === 'paused' ? '继续压缩' : '开始压缩'}{waiting > 0 && <span className="button-count">{waiting}</span>}</button>}
        </div></div>
      </section>
      <footer className="footnote"><span><Icon name="shield" size={15}/>原件始终保留 · 仅压缩嵌入的 JPEG / PNG</span><button className="text-button" disabled={!results.length || bundling || locked} onClick={bundle}><Icon name="download" size={15}/>{bundling ? '正在打包…' : '打包下载全部结果'}<Icon name="arrow" size={14}/></button></footer>
      <p className="browser-note">建议使用最新版 Chrome 或 Edge。网页版单图上限 1,600 万像素；更大的图片会保留原样。文件夹访问由浏览器授权。</p>
    </main>
    {(selected || confirmClear) && <div className="modal-backdrop" onClick={() => { setDetail(undefined); setConfirmClear(false); }}><section className="detail-dialog" role="dialog" aria-modal="true" aria-label={selected ? '任务详情' : '清除任务'} onClick={e => e.stopPropagation()}>
      <div className="detail-header"><h2>{selected ? '任务详情' : '清除已结束任务？'}</h2><button className="icon-button" aria-label="关闭详情" autoFocus onClick={() => { setDetail(undefined); setConfirmClear(false); }}><Icon name="close"/></button></div>
      {confirmClear ? <><p className="result-reason">清除后，本页中的结果将被释放。请确认已下载需要的文件；已经保存到文件夹的文件不受影响。</p><div className="dialog-actions"><button className="secondary" onClick={() => setConfirmClear(false)}>保留任务</button><button className="primary" onClick={() => { queue.clear(); setConfirmClear(false); }}>确认清除</button></div></> : selected && <>
        <h3>{selected.name}</h3>{selected.result && <><p className="result-reason">{selected.result.reason}</p><div className="detail-stat"><span>{bytes(selected.result.originalSize)} <Icon name="arrow" size={15}/> {bytes(selected.result.outputSize)}</span><span>压缩图片 {selected.result.changedImages} / {selected.result.imageCount}</span></div><label>{selected.savedToFolder ? '已保存到文件夹' : '输出文件名'}</label><p className="path">{selected.outputName}</p>
          {!!selected.result.warnings.length && <><h4>以下图片已保留原样</h4><ul>{selected.result.warnings.map((w, i) => <li key={i}>{w}</li>)}</ul></>}
          <button className="secondary" onClick={() => action(() => queue.download(selected.id))}><Icon name="download"/>下载文件</button></>}{selected.error && <p className="error-text">{selected.error}</p>}</>}
    </section></div>}
  </div>;
}
function TaskRow({ task, index, details, download }: { task: BrowserTask; index: number; details: () => void; download: () => void }) {
  const labels = { waiting: '等待处理', processing: task.progress.stage, completed: task.result?.warnings.length ? '完成，有跳过项' : (task.savedToFolder ? '压缩完成 · 已保存' : '压缩完成'), unchanged: task.savedToFolder ? '无需压缩 · 已保存' : '无需压缩', failed: task.result ? '保存失败，可下载' : '处理失败', cancelled: '已取消' };
  const ratio = task.result ? Math.round((1 - task.result.outputSize / task.result.originalSize) * 100) : 0;
  return <div className={'task-row ' + task.status}>
    <div className="task-name"><span className="task-number">{String(index + 1).padStart(2, '0')}</span><div className="file-icon"><Icon name="file" size={21}/></div><div className="task-name-text"><strong title={task.name}>{task.name}</strong><small>{task.error || task.result?.reason || 'Word 文档 · DOCX'}</small></div></div>
    <div className="task-size">{task.result ? <><strong>{bytes(task.result.outputSize)}</strong><small>{bytes(task.file.size)}{ratio > 0 && <em>−{ratio}%</em>}</small></> : bytes(task.file.size)}</div>
    <div className="task-status"><span className="status-label"><span className="status-dot"/>{labels[task.status]}</span>{task.status === 'processing' && <div className="progress-track"><span style={{ width: task.progress.percent + '%' }}/><small>{task.progress.percent}%</small></div>}</div>
    <div className="task-actions">{task.status === 'waiting' ? <button className="icon-button" aria-label={'删除 ' + task.name} onClick={() => queue.remove(task.id)}><Icon name="close" size={16}/></button> : task.status === 'processing' ? <button className="text-button" onClick={() => queue.cancel(task.id)}>取消</button> : task.status !== 'cancelled' && <>{task.result && <button className="icon-button" aria-label={'下载 ' + task.name} onClick={download}><Icon name="download" size={16}/></button>}<button className="text-button" onClick={details}>详情</button></>}</div>
  </div>;
}
createRoot(document.getElementById('root')!).render(<App/>);
