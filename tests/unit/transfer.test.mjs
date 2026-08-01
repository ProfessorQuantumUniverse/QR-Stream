/**
 * End-to-end tests of the whole pipeline, including real QR encoding and real
 * QR decoding through an independent decoder. These are the tests that would
 * catch an integration mistake no single-module test can see.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { createTransmission } from '../../src/core/transmit.js';
import { ReceiverSession } from '../../src/core/receive.js';
import { encodeBytes, toMatrix } from '../../src/qr/encoder.js';
import jsQR, { rasterise } from '../helpers/jsqr.mjs';

function bytes(length, seed = 1) {
  let state = seed >>> 0;
  const out = new Uint8Array(length);
  for (let i = 0; i < length; i++) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    out[i] = (state >>> 24) & 0xff;
  }
  return out;
}

/** A deterministic stand-in for a camera: encode to QR, decode back from pixels. */
function opticalRoundTrip(frameBytes, version, ecc) {
  const symbol = encodeBytes(frameBytes, {
    ecc,
    minVersion: version,
    maxVersion: version,
    boostEcc: true,
  });
  const image = rasterise(toMatrix(symbol, 4), 3);
  const result = jsQR(image.data, image.width, image.height);
  return result ? Uint8Array.from(result.binaryData) : null;
}

test('transfers text end to end through real QR symbols', async () => {
  const text = 'The quick brown fox jumps over the lazy dog. '.repeat(40);
  const transmission = await createTransmission({
    data: new TextEncoder().encode(text),
    name: 'note.txt',
    mime: 'text/plain',
    binary: false,
    version: 12,
    ecc: 'M',
  });

  const session = new ReceiverSession();
  let frames = 0;
  while (!session.ready && frames < 500) {
    const { bytes: frameBytes } = transmission.next();
    const scanned = opticalRoundTrip(frameBytes, transmission.version, transmission.ecc);
    assert.ok(scanned, `frame ${frames} failed to decode optically`);
    session.ingest(scanned);
    frames++;
  }

  assert.ok(session.ready, 'transfer did not complete');
  const result = await session.result();
  assert.equal(result.text, text);
  assert.equal(result.name, 'note.txt');
  assert.ok(result.verified);
});

test('transfers binary data end to end and preserves every byte', async () => {
  const payload = bytes(9000, 4242);
  const transmission = await createTransmission({
    data: payload,
    name: 'blob.bin',
    mime: 'application/octet-stream',
    binary: true,
    version: 20,
    ecc: 'M',
  });

  const session = new ReceiverSession();
  for (let i = 0; i < 400 && !session.ready; i++) {
    const scanned = opticalRoundTrip(
      transmission.next().bytes,
      transmission.version,
      transmission.ecc,
    );
    assert.ok(scanned, `frame ${i} failed to decode optically`);
    session.ingest(scanned);
  }

  assert.ok(session.ready, 'binary transfer did not complete');
  const result = await session.result();
  assert.deepEqual(result.bytes, payload);
  assert.equal(result.text, null);
  assert.equal(result.binary, true);
});

test('compresses compressible payloads and still verifies', async () => {
  const text = 'a'.repeat(20000);
  const transmission = await createTransmission({
    data: new TextEncoder().encode(text),
    name: 'repeat.txt',
    binary: false,
    version: 15,
    ecc: 'M',
  });

  assert.ok(transmission.manifest.compressed, 'highly repetitive text should compress');
  assert.ok(transmission.compressionRatio < 0.1);
  // The whole point: fewer blocks to send.
  assert.ok(transmission.blockCount < 10, `expected a handful of blocks, got ${transmission.blockCount}`);

  const session = new ReceiverSession();
  for (let i = 0; i < 200 && !session.ready; i++) session.ingest(transmission.next().bytes);
  const result = await session.result();
  assert.equal(result.text, text);
});

test('does not compress incompressible payloads', async () => {
  const transmission = await createTransmission({
    data: bytes(4000, 7),
    binary: true,
    version: 15,
  });
  assert.equal(transmission.manifest.compressed, false);
});

test('completes despite losing half the frames', async () => {
  const payload = bytes(12000, 99);
  const transmission = await createTransmission({
    data: payload,
    binary: true,
    version: 18,
    ecc: 'M',
  });

  const session = new ReceiverSession();
  let state = 777;
  const dropped = () => {
    state = (Math.imul(state, 1103515245) + 12345) >>> 0;
    return state / 4294967296 < 0.5;
  };

  let sent = 0;
  while (!session.ready && sent < 3000) {
    const frame = transmission.next();
    sent++;
    if (!dropped()) session.ingest(frame.bytes);
  }

  assert.ok(session.ready, 'did not converge with 50% loss');
  const result = await session.result();
  assert.deepEqual(result.bytes, payload);
});

test('a receiver joining mid-stream still completes', async () => {
  const payload = bytes(8000, 21);
  const transmission = await createTransmission({ data: payload, binary: true, version: 16 });

  // Burn through several full passes before the receiver looks at the screen.
  for (let i = 0; i < transmission.blockCount * 3; i++) transmission.next();

  const session = new ReceiverSession();
  for (let i = 0; i < 2000 && !session.ready; i++) session.ingest(transmission.next().bytes);

  assert.ok(session.ready, 'mid-stream join did not complete');
  assert.deepEqual((await session.result()).bytes, payload);
});

test('ignores unrelated QR codes without disturbing the transfer', async () => {
  const payload = bytes(3000, 5);
  const transmission = await createTransmission({ data: payload, binary: true, version: 14 });
  const session = new ReceiverSession();
  const noise = new TextEncoder().encode('https://example.com/not-a-stream');

  for (let i = 0; i < 500 && !session.ready; i++) {
    assert.equal(session.ingest(noise).status, 'ignored');
    session.ingest(transmission.next().bytes);
  }

  assert.ok(session.ready);
  assert.ok(session.foreignFrames > 0);
  assert.deepEqual((await session.result()).bytes, payload);
});

test('starts over when a second, different stream appears', async () => {
  const first = await createTransmission({ data: bytes(2000, 1), binary: true, version: 14, streamId: 1 });
  const second = await createTransmission({ data: bytes(2000, 2), binary: true, version: 14, streamId: 2 });

  const session = new ReceiverSession();
  for (let i = 0; i < 4; i++) session.ingest(first.next().bytes);
  assert.equal(session.streamId, 1);
  assert.ok(session.recoveredBlocks > 0);

  // The camera pans to a different sender: everything collected so far is void.
  session.ingest(second.next().bytes);
  assert.equal(session.streamId, 2);

  for (let i = 0; i < 200 && !session.ready; i++) session.ingest(second.next().bytes);
  assert.ok(session.ready);
  assert.deepEqual((await session.result()).bytes, second.encoder.payload);
});

test('reports a checksum mismatch rather than returning wrong data', async () => {
  const transmission = await createTransmission({ data: bytes(1500, 8), binary: true, version: 14 });
  const session = new ReceiverSession();
  for (let i = 0; i < 200 && !session.complete; i++) session.ingest(transmission.next().bytes);

  // Corrupt a recovered block behind the decoder's back to simulate the one
  // failure mode Reed-Solomon cannot catch: a plausible but wrong decode.
  session.decoder.blocks[0][0] ^= 0xff;
  await assert.rejects(() => session.result(), /Checksum mismatch/);
});

test('shrinks the symbol when the payload is smaller than one frame', async () => {
  // A 40-byte payload does not need a version 24 symbol, and a sparse symbol is
  // far easier for a camera to read than a dense one.
  const transmission = await createTransmission({
    data: new TextEncoder().encode('short message'),
    name: 'note.txt',
    version: 24,
    ecc: 'M',
    compress: false,
  });

  assert.ok(transmission.version < 24, `stayed at version ${transmission.version}`);
  assert.equal(transmission.blockCount, 1);

  // The shrunken symbol must still hold both frame kinds.
  for (let i = 0; i < 3; i++) {
    const symbol = encodeBytes(transmission.next().bytes, {
      ecc: 'M',
      minVersion: transmission.version,
      maxVersion: transmission.version,
    });
    assert.equal(symbol.version, transmission.version);
  }

  const session = new ReceiverSession();
  for (let i = 0; i < 20 && !session.ready; i++) session.ingest(transmission.next().bytes);
  assert.equal((await session.result()).text, 'short message');
});

test('a large payload keeps the requested symbol density', async () => {
  const transmission = await createTransmission({
    data: bytes(20000, 3),
    binary: true,
    version: 18,
    ecc: 'M',
    compress: false,
  });
  assert.equal(transmission.version, 18);
});

test('trims an oversized filename rather than emitting an unreadable manifest', async () => {
  const name = `${'very-long-file-name-'.repeat(30)}.bin`;
  const transmission = await createTransmission({
    data: bytes(200, 2),
    name,
    mime: 'application/octet-stream',
    binary: true,
    version: 8,
    ecc: 'H',
    compress: false,
  });

  // Whatever the name became, every frame must fit the chosen symbol.
  for (let i = 0; i < 4; i++) {
    const symbol = encodeBytes(transmission.next().bytes, {
      ecc: 'H',
      minVersion: transmission.version,
      maxVersion: transmission.version,
    });
    assert.equal(symbol.version, transmission.version);
  }

  const session = new ReceiverSession();
  for (let i = 0; i < 40 && !session.ready; i++) session.ingest(transmission.next().bytes);
  assert.ok(session.ready, 'transfer with a long filename did not complete');
  const result = await session.result();
  assert.ok(result.name.length > 0);
  assert.ok(name.startsWith(result.name), 'the trimmed name is not a prefix of the original');
});

test('every frame fits the QR symbol it was sized for', async () => {
  for (const version of [8, 12, 16, 20, 25, 30]) {
    for (const ecc of ['L', 'M', 'Q', 'H']) {
      const transmission = await createTransmission({
        data: bytes(5000, version),
        binary: true,
        version,
        ecc,
        compress: false,
      });
      for (let i = 0; i < 5; i++) {
        const frame = transmission.next();
        // Must not need a larger symbol than the stream was planned around.
        const symbol = encodeBytes(frame.bytes, {
          ecc,
          minVersion: version,
          maxVersion: version,
        });
        assert.equal(symbol.version, version);
      }
    }
  }
});
