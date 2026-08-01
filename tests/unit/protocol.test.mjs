import test from 'node:test';
import assert from 'node:assert/strict';

import {
  BLOCK_OVERHEAD,
  FRAME_BLOCK,
  FRAME_MANIFEST,
  decodeFrame,
  encodeBlock,
  encodeManifest,
} from '../../src/core/protocol.js';
import { crc32, formatCrc } from '../../src/core/crc32.js';

const manifest = {
  streamId: 0xbeef,
  payloadLength: 123456,
  payloadCrc: 0xdeadbeef,
  blockSize: 200,
  blockCount: 618,
  compressed: true,
  binary: true,
  name: 'secret-key.asc',
  mime: 'application/pgp-keys',
};

test('CRC-32 matches known values', () => {
  const encoder = new TextEncoder();
  assert.equal(crc32(new Uint8Array(0)), 0);
  assert.equal(crc32(encoder.encode('123456789')), 0xcbf43926);
  assert.equal(crc32(encoder.encode('The quick brown fox jumps over the lazy dog')), 0x414fa339);
  assert.equal(formatCrc(0xcbf43926), 'CBF43926');
});

test('CRC-32 can be computed incrementally', () => {
  const encoder = new TextEncoder();
  const whole = encoder.encode('123456789');
  const running = crc32(whole.subarray(5), crc32(whole.subarray(0, 5)));
  assert.equal(running, crc32(whole));
});

test('manifest frames round-trip', () => {
  const frame = decodeFrame(encodeManifest(manifest));
  assert.ok(frame);
  assert.equal(frame.type, FRAME_MANIFEST);
  for (const key of Object.keys(manifest)) {
    assert.deepEqual(frame[key], manifest[key], `field ${key}`);
  }
});

test('manifest handles empty and non-ASCII names', () => {
  for (const name of ['', 'Ünïcødé — файл.txt', 'x'.repeat(80)]) {
    const frame = decodeFrame(encodeManifest({ ...manifest, name, mime: '' }));
    assert.ok(frame, `failed for name ${JSON.stringify(name)}`);
    assert.equal(frame.name, name);
    assert.equal(frame.mime, '');
  }
});

test('block frames round-trip and report their overhead honestly', () => {
  const block = Uint8Array.from({ length: 180 }, (_, i) => (i * 37) & 0xff);
  const encoded = encodeBlock(0x1234, 987654321, 618, block);
  assert.equal(encoded.length, block.length + BLOCK_OVERHEAD);

  const frame = decodeFrame(encoded);
  assert.ok(frame);
  assert.equal(frame.type, FRAME_BLOCK);
  assert.equal(frame.streamId, 0x1234);
  assert.equal(frame.seed, 987654321);
  assert.equal(frame.blockCount, 618);
  assert.deepEqual(Uint8Array.from(frame.block), block);
});

test('rejects frames that are not ours', () => {
  const encoder = new TextEncoder();
  assert.equal(decodeFrame(encoder.encode('https://example.com')), null);
  assert.equal(decodeFrame(new Uint8Array(0)), null);
  assert.equal(decodeFrame(new Uint8Array([0x51])), null);
  assert.equal(decodeFrame(encoder.encode('1|20|hello')), null, 'v1 frames must not parse');
});

test('rejects frames with a corrupted checksum', () => {
  const encoded = encodeBlock(1, 2, 3, new Uint8Array(64));
  for (const position of [5, 11, 40, encoded.length - 5]) {
    const damaged = encoded.slice();
    damaged[position] ^= 0x01;
    assert.equal(decodeFrame(damaged), null, `flip at ${position} slipped through`);
  }
});

test('rejects a frame from a future protocol version', () => {
  const encoded = encodeManifest(manifest);
  const future = encoded.slice();
  future[2] = (2 << 4) | FRAME_MANIFEST;
  assert.equal(decodeFrame(future), null);
});

test('rejects a manifest whose declared lengths run past the frame', () => {
  const encoded = encodeManifest(manifest);
  const damaged = encoded.slice();
  damaged[18] = 0xff; // name length far beyond the frame
  // Repair the checksum so only the length check can reject it.
  const view = new DataView(damaged.buffer);
  view.setUint32(damaged.length - 4, crc32(damaged.subarray(0, damaged.length - 4)));
  assert.equal(decodeFrame(damaged), null);
});
