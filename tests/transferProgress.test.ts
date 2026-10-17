import test from 'node:test';
import assert from 'node:assert/strict';
import { summarizeTransfers } from '../src/client/transferProgress';

const files = [
  { fileId: 'a', name: 'small.pdf', size: 100, status: 'approved' },
  { fileId: 'b', name: 'large.pdf', size: 900, status: 'approved' },
  { fileId: 'c', name: 'new.pdf', size: 200, status: 'announcing' },
] as const;

test('mixed-size PDFs show weighted bytes and never claim all done until every active file is cached', () => {
  const summary = summarizeTransfers(files, {
    a: { fileId: 'a', size: 100, bytes: 100, complete: true },
    b: { fileId: 'b', size: 900, bytes: 450, complete: false },
  });
  assert.equal(summary.ready, 1);
  assert.equal(summary.count, 3);
  assert.equal(summary.bytes, 550);
  assert.equal(summary.size, 1200);
  assert.ok(summary.percent > 45 && summary.percent < 46);
  assert.equal(summary.complete, false);
});

test('completed files and missing files are both counted correctly', () => {
  const progress = {
    a: { fileId: 'a', size: 100, bytes: 100, complete: true },
    b: { fileId: 'b', size: 900, bytes: 900, complete: true },
  };
  assert.equal(summarizeTransfers(files.slice(0, 2), progress).complete, true);
  assert.equal(summarizeTransfers(files, progress).complete, false);
  assert.equal(summarizeTransfers(files, progress).ready, 2);
});

test('invalid sizes and forged completion flags do not produce a false success', () => {
  const result = summarizeTransfers(files.slice(0, 2), {
    a: { fileId: 'a', size: 2, bytes: 100, complete: true },
    b: { fileId: 'b', size: 900, bytes: 899, complete: true },
  });
  assert.equal(result.ready, 0);
  assert.ok(result.percent < 100);
  assert.equal(result.complete, false);
});

test('stopped and rejected files leave the active batch rather than holding it forever', () => {
  const result = summarizeTransfers([
    { ...files[0], status: 'offline' },
    { ...files[1], status: 'rejected' },
    files[2],
  ], { c: { fileId: 'c', size: 200, bytes: 200, complete: true } });
  assert.equal(result.count, 1);
  assert.equal(result.ready, 1);
  assert.equal(result.complete, true);
  assert.equal(summarizeTransfers([{ ...files[0], status: 'offline' }], {}).complete, false);
});
