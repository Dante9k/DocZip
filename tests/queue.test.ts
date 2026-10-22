import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { TaskQueue, type Runner } from '../src/main/queue';
import type { QueueState, Result, Settings } from '../src/shared/types';

let root: string;
const tick = () => new Promise((resolve) => setTimeout(resolve, 10));
async function until(fn: () => boolean) {
  for (let i = 0; i < 300; i++) {
    if (fn()) return;
    await tick();
  }
  throw new Error('Timed out waiting for queue');
}
before(async () => {
  await mkdir('test-results', { recursive: true });
  root = await mkdtemp(path.resolve('test-results', 'queue-'));
  for (const n of ['a', 'b', 'c', 'd']) await writeFile(path.join(root, `${n}.docx`), n);
});
after(async () => {
  await rm(root, { recursive: true, force: true });
});
const file = (n: string) => path.join(root, `${n}.docx`);
const result: Result = {
  outputPath: 'output.docx',
  originalSize: 10,
  outputSize: 5,
  imageCount: 1,
  changedImages: 1,
  warnings: [],
  unchanged: false,
  reason: 'ok',
};
function controlled() {
  let resolve!: (r: Result) => void, reject!: (e: Error) => void;
  let current = 0,
    peak = 0;
  const seen: { name: string; settings: Settings }[] = [];
  const runner: Runner = async (task, settings, signal) => {
    seen.push({ name: task.name, settings });
    current++;
    peak = Math.max(peak, current);
    try {
      return await new Promise<Result>((ok, fail) => {
        resolve = ok;
        reject = fail;
        signal.addEventListener('abort', () => fail(new Error('cancel')), { once: true });
      });
    } finally {
      current--;
    }
  };
  let state: QueueState;
  const q = new TaskQueue(
    { outputDir: root, preset: 'balanced' },
    runner,
    (value) => (state = value),
  );
  state = q.snapshot();
  return {
    q,
    state: () => state,
    seen,
    finish: () => resolve(result),
    fail: () => reject(new Error('bad document')),
    peak: () => peak,
  };
}
test('strictly serial, append while running, pause after current, lock settings, resume after failure', async () => {
  const c = controlled();
  await c.q.add([file('a'), file('b')]);
  await c.q.start();
  await until(() => c.seen.length === 1);
  await c.q.add([file('c')]);
  await assert.rejects(c.q.configure({ preset: 'small' }), /修改设置/);
  c.q.pause();
  assert.equal(c.state().mode, 'pausing');
  c.finish();
  await until(() => c.state().mode === 'paused');
  assert.equal(c.seen.length, 1);
  await assert.rejects(c.q.configure({ preset: 'small' }), /修改设置/);
  await c.q.start();
  await until(() => c.seen.length === 2);
  c.fail();
  await until(() => c.seen.length === 3);
  assert.equal(c.state().tasks[1].status, 'failed');
  c.finish();
  await until(() => c.state().mode === 'idle');
  assert.equal(c.peak(), 1);
  assert.deepEqual(
    c.seen.map((x) => x.name),
    ['a.docx', 'b.docx', 'c.docx'],
  );
  assert.ok(c.seen.every((x) => x.settings.preset === 'balanced'));
});
test('duplicate rejection, waiting deletion, active cancellation, clear finished', async () => {
  const c = controlled();
  assert.equal((await c.q.add([file('a'), file('a')])).length, 1);
  await c.q.add([file('b'), file('c'), file('d')]);
  c.q.remove(c.state().tasks[1].id);
  assert.equal(c.state().tasks.length, 3);
  c.q.cancel(c.state().tasks[2].id);
  assert.equal(c.state().tasks[2].status, 'cancelled');
  await c.q.start();
  await until(() => c.seen.length === 1);
  c.q.cancel(c.state().tasks[0].id);
  await until(() => c.seen.length === 2);
  assert.equal(c.state().tasks[0].status, 'cancelled');
  c.q.clearFinished();
  assert.equal(c.state().tasks.length, 1);
  assert.equal(c.state().tasks[0].status, 'processing');
  c.finish();
  await until(() => c.state().mode === 'idle');
  c.q.clearFinished();
  assert.equal(c.state().tasks.length, 0);
});
test('invalid input does not start, and cancelling all paused work unlocks settings', async () => {
  const c = controlled();
  assert.equal((await c.q.add([root, path.join(root, 'missing.docx')])).length, 2);
  await c.q.add([file('a'), file('b')]);
  await c.q.start();
  c.q.pause();
  c.finish();
  await until(() => c.state().mode === 'paused');
  c.q.cancel(c.state().tasks[1].id);
  assert.equal(c.state().mode, 'idle');
  await c.q.configure({ preset: 'clear' });
  assert.equal(c.state().settings.preset, 'clear');
});
