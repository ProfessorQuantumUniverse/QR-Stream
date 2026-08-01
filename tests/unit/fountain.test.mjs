import test from 'node:test';
import assert from 'node:assert/strict';

import { LtDecoder, LtEncoder, blocksForSeed } from '../../src/core/fountain.js';

function bytes(length, seed = 1) {
  let state = seed >>> 0;
  const out = new Uint8Array(length);
  for (let i = 0; i < length; i++) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    out[i] = (state >>> 24) & 0xff;
  }
  return out;
}

test('seeds below the block count map to plain source blocks', () => {
  for (const k of [1, 2, 7, 64, 1000]) {
    for (let seed = 0; seed < Math.min(k, 20); seed++) {
      assert.deepEqual(blocksForSeed(seed, k), [seed]);
    }
  }
});

test('block selection is deterministic and in range', () => {
  const k = 137;
  for (let seed = 0; seed < 2000; seed++) {
    const first = blocksForSeed(seed, k);
    assert.deepEqual(blocksForSeed(seed, k), first, `seed ${seed} is not deterministic`);
    assert.ok(first.length >= 1 && first.length <= k);
    assert.equal(new Set(first).size, first.length, `seed ${seed} repeats a block`);
    for (const index of first) assert.ok(index >= 0 && index < k);
  }
});

test('degree distribution keeps most packets sparse but reaches every block', () => {
  const k = 200;
  const counts = new Map();
  const touched = new Set();
  for (let seed = k; seed < k + 5000; seed++) {
    const indices = blocksForSeed(seed, k);
    counts.set(indices.length, (counts.get(indices.length) ?? 0) + 1);
    for (const index of indices) touched.add(index);
  }
  // Every source block must be reachable, or some payloads could never decode.
  assert.equal(touched.size, k);
  // A soliton distribution is dominated by low degrees; if it were not, peeling
  // would stall and the overhead assertions below would blow up.
  const degreeOne = counts.get(1) ?? 0;
  assert.ok(degreeOne > 5000 * 0.02, `too few degree-1 packets: ${degreeOne}`);
});

test('systematic prefix decodes with zero overhead when nothing is lost', () => {
  const payload = bytes(4096, 9);
  const encoder = new LtEncoder(payload, 128);
  const decoder = new LtDecoder(encoder.k, 128);

  for (let seed = 0; !decoder.complete; seed++) decoder.addPacket(seed, encoder.packet(seed));

  assert.equal(decoder.received, encoder.k);
  assert.deepEqual(decoder.assemble(payload.length), payload);
});

test('recovers the payload despite heavy, random frame loss', () => {
  // A deterministic "camera" that drops a fixed fraction of frames.
  for (const lossRate of [0.1, 0.3, 0.5, 0.7]) {
    const payload = bytes(8192, 42);
    const blockSize = 96;
    const encoder = new LtEncoder(payload, blockSize);
    const decoder = new LtDecoder(encoder.k, blockSize);

    let state = 12345;
    const drop = () => {
      state = (Math.imul(state, 1103515245) + 12345) >>> 0;
      return state / 4294967296 < lossRate;
    };

    let seed = 0;
    const limit = encoder.k * 200;
    while (!decoder.complete && seed < limit) {
      if (!drop()) decoder.addPacket(seed, encoder.packet(seed));
      seed++;
    }

    assert.ok(decoder.complete, `did not converge at ${lossRate * 100}% loss`);
    assert.deepEqual(decoder.assemble(payload.length), payload);
    // The point of a fountain code: overhead depends on the code, not on which
    // frames were lost.
    assert.ok(
      decoder.overhead < 1.6,
      `overhead ${decoder.overhead.toFixed(2)} too high at ${lossRate * 100}% loss`,
    );
  }
});

test('recovers when the receiver joins after the systematic pass', () => {
  // The worst realistic case: the camera starts filming long after the stream
  // began, so no uncoded block is ever seen.
  const payload = bytes(6000, 77);
  const blockSize = 100;
  const encoder = new LtEncoder(payload, blockSize);
  const decoder = new LtDecoder(encoder.k, blockSize);

  let seed = encoder.k * 3;
  const limit = seed + encoder.k * 200;
  while (!decoder.complete && seed < limit) {
    decoder.addPacket(seed, encoder.packet(seed));
    seed++;
  }

  assert.ok(decoder.complete, 'mid-stream join failed to converge');
  assert.deepEqual(decoder.assemble(payload.length), payload);
  assert.ok(decoder.overhead < 1.6, `overhead ${decoder.overhead.toFixed(2)} too high`);
});

test('average coding overhead stays modest across block counts', () => {
  for (const k of [4, 16, 64, 256, 1024]) {
    let totalOverhead = 0;
    const trials = 12;
    for (let trial = 0; trial < trials; trial++) {
      const blockSize = 64;
      const payload = bytes(k * blockSize, trial * 31 + 5);
      const encoder = new LtEncoder(payload, blockSize);
      const decoder = new LtDecoder(k, blockSize);
      // Start past the systematic prefix so this measures the code itself.
      let seed = k + trial * 7919;
      for (let attempt = 0; !decoder.complete && attempt < 400 * k + 400; attempt++) {
        decoder.addPacket(seed, encoder.packet(seed));
        seed++;
      }
      assert.ok(decoder.complete, `k=${k} trial=${trial} failed to converge`);
      totalOverhead += decoder.overhead;
    }
    const mean = totalOverhead / trials;
    assert.ok(mean < 1.75, `mean overhead for k=${k} was ${mean.toFixed(3)}`);
  }
});

test('ignores repeated packets and reports progress honestly', () => {
  const payload = bytes(1000, 3);
  const encoder = new LtEncoder(payload, 100);
  const decoder = new LtDecoder(encoder.k, 100);

  assert.equal(decoder.addPacket(0, encoder.packet(0)), true);
  assert.equal(decoder.addPacket(0, encoder.packet(0)), false, 'repeat counted as new');
  assert.equal(decoder.recovered, 1);
  assert.equal(decoder.progress, 1 / encoder.k);
  assert.equal(decoder.recoveredMask()[0], 1);
  assert.equal(decoder.recoveredMask()[1], 0);
});

test('handles a payload smaller than a single block', () => {
  const payload = bytes(5, 11);
  const encoder = new LtEncoder(payload, 256);
  assert.equal(encoder.k, 1);
  const decoder = new LtDecoder(1, 256);
  decoder.addPacket(0, encoder.packet(0));
  assert.ok(decoder.complete);
  assert.deepEqual(decoder.assemble(payload.length), payload);
});
