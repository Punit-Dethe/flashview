import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { PresentationGuest } from '../src/client/presentation';

test('presentation automatically retries a transient missing-page byte range', { timeout: 7000 }, async () => {
  const key = 'range-retry-' + crypto.randomUUID();
  const guest = new PresentationGuest(key);
  const host = new BroadcastChannel('flashview-present-' + key);
  let requests = 0;
  try {
    host.onmessage = event => {
      const msg = event.data as { type: string; id: string; begin: number };
      if (msg.type !== 'range') return;
      requests++;
      if (requests === 1) {
        // A lost student connection used to permanently break PDF.js.
        host.postMessage({ type: 'error', id: msg.id, message: 'Sender disconnected' });
      } else {
        host.postMessage({ type: 'data', id: msg.id, begin: msg.begin, bytes: Uint8Array.of(37, 80, 68, 70) });
      }
    };
    const data = await new Promise<Uint8Array>((resolve, reject) => {
      guest.requestRange('some-pdf', 0, 4, (_start, result) => resolve(result), reject);
    });
    assert.deepEqual(Array.from(data), [37, 80, 68, 70]);
    assert.equal(requests, 2, 'A transient error should be retried transparently');
  } finally {
    guest.close();
    host.close();
  }
});

test('cancelled presentations do not keep retrying lost ranges', { timeout: 6000 }, async () => {
  const key = 'range-cancel-' + crypto.randomUUID();
  const guest = new PresentationGuest(key);
  const host = new BroadcastChannel('flashview-present-' + key);
  let count = 0;
  let resolveFirst!: () => void;
  const first = new Promise<void>(resolve => { resolveFirst = resolve; });
  try {
    host.onmessage = event => {
      const msg = event.data as { type: string; id: string };
      if (msg.type === 'range') {
        count++;
        host.postMessage({ type: 'error', id: msg.id, message: 'Sender disconnected' });
        resolveFirst();
      }
    };
    const cancel = guest.requestRange('some-pdf', 0, 4, () => {}, () => {});
    await first;
    // Allow the error message to reach the guest before cancelling.
    await delay(30);
    cancel();
    await delay(900);
    assert.equal(count, 1, 'Cancelling a page must also cancel its scheduled reconnect retry');
  } finally {
    guest.close();
    host.close();
  }
});
