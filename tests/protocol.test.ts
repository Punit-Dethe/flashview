import test from 'node:test';
import assert from 'node:assert/strict';
import {
  decodeRangePacket, encodeRangePacket, MAX_PDF_BYTES, MAX_RANGE_BYTES,
} from '../src/shared/protocol';

test('round-trip binary packet preserves range offset and PDF bytes', () => {
  const original = Uint8Array.from([37, 80, 68, 70, 45, 1, 2, 255]);
  const packet = encodeRangePacket(
    { type: 'range.data', requestId: 'abcdef123456', fileId: 'pdf123456', begin: 65_536 },
    original,
  );
  const result = decodeRangePacket(packet);
  assert.deepEqual(result.header, {
    type: 'range.data', requestId: 'abcdef123456', fileId: 'pdf123456', begin: 65_536,
  });
  assert.deepEqual(result.bytes, original);
});

test('binary packets reject truncation and invalid headers', () => {
  assert.throws(() => decodeRangePacket(new ArrayBuffer(0)), /Truncated/);
  assert.throws(() => decodeRangePacket(Uint8Array.from([255, 255, 1]).buffer), /Invalid/);
  const invalid = new TextEncoder().encode(JSON.stringify({
    type: 'range.data', requestId: 'x', fileId: 'y', begin: -1,
  }));
  const frame = new Uint8Array(2 + invalid.length);
  new DataView(frame.buffer).setUint16(0, invalid.length);
  frame.set(invalid, 2);
  assert.throws(() => decodeRangePacket(frame.buffer), /Invalid/);
});

test('range size is smaller than supported PDF size', () => {
  assert.equal(MAX_RANGE_BYTES, 256 * 1024);
  assert.equal(MAX_PDF_BYTES, 50 * 1024 * 1024);
});
