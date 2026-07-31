/**
 * Validates the hand-written QR encoder against jsQR, an entirely independent
 * decoder implementation. If a capacity table entry, a mask pattern or the
 * interleaving order were wrong, the round trip would fail here.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { encodeBytes, toMatrix, byteCapacity } from '../../src/qr/encoder.js';
import {
  ECC_BLOCK_COUNT,
  ECC_CODEWORDS_PER_BLOCK,
  ECC_LEVELS,
  alignmentPositions,
  dataCodewords,
  rawCodewords,
} from '../../src/qr/tables.js';
import jsQR, { rasterise } from '../helpers/jsqr.mjs';

/** Deterministic pseudo-random bytes so failures are reproducible. */
function bytes(length, seed = 1) {
  let state = seed >>> 0;
  const out = new Uint8Array(length);
  for (let i = 0; i < length; i++) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    out[i] = (state >>> 24) & 0xff;
  }
  return out;
}

function roundTrip(payload, options) {
  const symbol = encodeBytes(payload, options);
  const image = rasterise(toMatrix(symbol, 4), 4);
  const result = jsQR(image.data, image.width, image.height);
  assert.ok(result, `decoder found no symbol (version ${symbol.version}-${symbol.ecc})`);
  return { symbol, decoded: Uint8Array.from(result.binaryData) };
}

test('round-trips a payload at every version and ECC level', () => {
  for (let version = 1; version <= 40; version++) {
    for (const ecc of ECC_LEVELS) {
      // Fill the symbol exactly: this exercises the padding, block splitting
      // and interleaving paths at their boundaries.
      const payload = bytes(byteCapacity(version, ecc), version * 4 + ECC_LEVELS.indexOf(ecc));
      const { symbol, decoded } = roundTrip(payload, {
        ecc,
        minVersion: version,
        maxVersion: version,
        boostEcc: false,
      });
      assert.equal(symbol.version, version);
      assert.equal(symbol.ecc, ecc);
      assert.deepEqual(decoded, payload, `payload mismatch at version ${version}-${ecc}`);
    }
  }
});

test('round-trips payloads that leave partial padding', () => {
  for (let version = 1; version <= 40; version += 3) {
    for (const ecc of ECC_LEVELS) {
      const capacity = byteCapacity(version, ecc);
      for (const length of [1, Math.floor(capacity / 2), capacity - 1]) {
        if (length < 1) continue;
        const payload = bytes(length, length + version);
        const { decoded } = roundTrip(payload, {
          ecc,
          minVersion: version,
          maxVersion: version,
          boostEcc: false,
        });
        assert.deepEqual(decoded, payload, `mismatch at ${version}-${ecc} len=${length}`);
      }
    }
  }
});

test('round-trips with every mask pattern forced', () => {
  const payload = bytes(300, 7);
  for (let mask = 0; mask < 8; mask++) {
    const { symbol, decoded } = roundTrip(payload, { ecc: 'M', mask, boostEcc: false });
    assert.equal(symbol.mask, mask);
    assert.deepEqual(decoded, payload);
  }
});

test('handles payloads containing every byte value', () => {
  const payload = new Uint8Array(256);
  for (let i = 0; i < 256; i++) payload[i] = i;
  const { decoded } = roundTrip(payload, { ecc: 'Q' });
  assert.deepEqual(decoded, payload);
});

test('selects the smallest version that fits', () => {
  const symbol = encodeBytes(bytes(byteCapacity(5, 'M')), { ecc: 'M', boostEcc: false });
  assert.equal(symbol.version, 5);
  const next = encodeBytes(bytes(byteCapacity(5, 'M') + 1), { ecc: 'M', boostEcc: false });
  assert.equal(next.version, 6);
});

test('boosts error correction when the payload leaves room', () => {
  // A payload that fits version 10 at level H also fits at L, so requesting L
  // should silently upgrade rather than waste the spare capacity.
  const payload = bytes(byteCapacity(10, 'H'));
  const symbol = encodeBytes(payload, { ecc: 'L', minVersion: 10, maxVersion: 10 });
  assert.equal(symbol.ecc, 'H');
});

test('rejects payloads larger than the version range allows', () => {
  assert.throws(
    () => encodeBytes(bytes(byteCapacity(3, 'L') + 1), { ecc: 'L', maxVersion: 3 }),
    /exceeds capacity/,
  );
});

test('data capacities match the published tables', () => {
  // Spot checks straight out of ISO/IEC 18004 table 7, in data codewords.
  const expected = {
    1: { L: 19, M: 16, Q: 13, H: 9 },
    2: { L: 34, M: 28, Q: 22, H: 16 },
    7: { L: 156, M: 124, Q: 88, H: 66 },
    10: { L: 274, M: 216, Q: 154, H: 122 },
    40: { L: 2956, M: 2334, Q: 1666, H: 1276 },
  };
  for (const [version, levels] of Object.entries(expected)) {
    for (const [ecc, count] of Object.entries(levels)) {
      assert.equal(dataCodewords(Number(version), ecc), count, `version ${version}-${ecc}`);
    }
  }
  // Raw codewords must always split cleanly into the declared block count.
  for (let version = 1; version <= 40; version++) {
    for (const ecc of ECC_LEVELS) {
      const blocks = ECC_BLOCK_COUNT[ECC_LEVELS.indexOf(ecc)][version];
      const perBlock = ECC_CODEWORDS_PER_BLOCK[ECC_LEVELS.indexOf(ecc)][version];
      const shortLen = Math.floor(rawCodewords(version) / blocks);
      assert.ok(shortLen - perBlock >= 1, `no room for data at ${version}-${ecc}`);
      assert.ok(rawCodewords(version) - blocks * shortLen < blocks);
    }
  }
});

test('alignment patterns follow the standard positions', () => {
  assert.deepEqual(alignmentPositions(1), []);
  assert.deepEqual(alignmentPositions(2), [6, 18]);
  assert.deepEqual(alignmentPositions(7), [6, 22, 38]);
  // Version 23 is where the vendored decoder had a transcription error; see
  // src/vendor/PATCHES.md. Centres are evenly spaced 24 apart.
  assert.deepEqual(alignmentPositions(23), [6, 30, 54, 78, 102]);
  assert.deepEqual(alignmentPositions(32), [6, 34, 60, 86, 112, 138]);
  assert.deepEqual(alignmentPositions(40), [6, 30, 58, 86, 114, 142, 170]);
});
