import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inspectContent, inspectPath, isPrivateCommitEmail } from '../scripts/lib/privacy.mjs';

test('privacy diagnostics identify credentials and local data without echoing values', () => {
  const secret = ['gh', 'p_', 'A'.repeat(36)].join('');
  const report = inspectContent('example.ts', Buffer.from('const value = "' + secret + '"'));
  assert.equal(report[0].category, 'credential token');
  assert.ok(!JSON.stringify(report).includes(secret));
  assert.equal(inspectPath('notes/private.docx'), 'document or runtime data');
  assert.equal(inspectPath('.env.local'), 'credential file');
  assert.equal(inspectPath('test-results/report.json'), 'local or generated data');
  assert.equal(inspectPath('src/core/compress.ts'), undefined);
});

test('privacy checks distinguish patch names from contact information and inspect commit emails', () => {
  const patch = ['patches/app-builder-lib', '26.15.3.patch'].join('@');
  assert.deepEqual(inspectContent('pnpm-workspace.yaml', Buffer.from(patch)), []);
  const address = ['person', 'private.invalid'].join('@');
  assert.equal(
    inspectContent('settings.ts', Buffer.from(address))[0].category,
    'contact address requires review',
  );
  assert.equal(isPrivateCommitEmail(address), false);
  assert.equal(isPrivateCommitEmail('123+example@users.noreply.github.com'), true);
});
