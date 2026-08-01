/**
 * A dependency-free QR code encoder for raw binary payloads.
 *
 * QR-Stream sends compressed, XOR-combined binary packets, so this encoder only
 * implements byte mode -- there is no point in alphanumeric or kanji segments
 * when every payload is high-entropy. Dropping the other modes keeps this small
 * enough to audit, which matters for a tool whose whole premise is that you can
 * trust it on an offline machine.
 *
 * Implements ISO/IEC 18004: versions 1-40, all four ECC levels, all eight data
 * masks with the standard penalty scoring.
 */

import { gfMul, rsGeneratorPoly, rsRemainder } from './galois.js';
import {
  ECC_BLOCK_COUNT,
  ECC_CODEWORDS_PER_BLOCK,
  ECC_FORMAT_BITS,
  ECC_LEVELS,
  MAX_VERSION,
  MIN_VERSION,
  alignmentPositions,
  byteCapacity,
  charCountBits,
  dataCodewords,
  rawCodewords,
} from './tables.js';

export { byteCapacity, MAX_VERSION, MIN_VERSION, ECC_LEVELS };

const BYTE_MODE = 0b0100;

/**
 * A rendered QR symbol. `modules` is a row-major Uint8Array of 0 (light) and
 * 1 (dark) values, `size` modules on a side, excluding the quiet zone.
 */
export class QrSymbol {
  constructor(version, ecc, mask, modules) {
    this.version = version;
    this.ecc = ecc;
    this.mask = mask;
    this.size = version * 4 + 17;
    this.modules = modules;
  }

  /** Is the module at (x, y) dark? Coordinates outside the symbol are light. */
  get(x, y) {
    if (x < 0 || y < 0 || x >= this.size || y >= this.size) return 0;
    return this.modules[y * this.size + x];
  }
}

/**
 * Encode a binary payload into a QR symbol.
 *
 * @param {Uint8Array} data payload bytes
 * @param {object} [options]
 * @param {'L'|'M'|'Q'|'H'} [options.ecc] minimum error correction level
 * @param {number} [options.minVersion]
 * @param {number} [options.maxVersion]
 * @param {number} [options.mask] force a specific mask (0-7); omit to auto-select
 * @param {boolean} [options.boostEcc] upgrade ECC for free if the payload leaves room
 */
export function encodeBytes(data, options = {}) {
  const {
    ecc = 'M',
    minVersion = MIN_VERSION,
    maxVersion = MAX_VERSION,
    mask = -1,
    boostEcc = true,
  } = options;

  if (!(data instanceof Uint8Array)) data = new Uint8Array(data);
  if (ECC_LEVELS.indexOf(ecc) < 0) throw new RangeError(`unknown ECC level ${ecc}`);
  if (minVersion < MIN_VERSION || maxVersion > MAX_VERSION || minVersion > maxVersion) {
    throw new RangeError('invalid version range');
  }

  // Smallest version in range that can hold the payload at the requested level.
  let version = minVersion;
  for (;; version++) {
    if (version > maxVersion) {
      throw new RangeError(
        `payload of ${data.length} bytes exceeds capacity of version ${maxVersion}-${ecc} ` +
          `(${byteCapacity(maxVersion, ecc)} bytes)`,
      );
    }
    if (data.length <= byteCapacity(version, ecc)) break;
  }

  // Error correction is free if the payload happens to fit at a stronger level.
  let level = ecc;
  if (boostEcc) {
    for (const candidate of ECC_LEVELS.slice(ECC_LEVELS.indexOf(ecc) + 1)) {
      if (data.length <= byteCapacity(version, candidate)) level = candidate;
    }
  }

  const codewords = buildCodewords(data, version, level);
  const interleaved = addEccAndInterleave(codewords, version, level);
  return drawSymbol(interleaved, version, level, mask);
}

/** Assemble the bitstream: mode indicator, length, payload, terminator, padding. */
function buildCodewords(data, version, ecc) {
  const capacity = dataCodewords(version, ecc);
  const out = new Uint8Array(capacity);
  let bitPos = 0;

  const writeBits = (value, count) => {
    for (let i = count - 1; i >= 0; i--) {
      const bit = (value >>> i) & 1;
      if (bit) out[bitPos >>> 3] |= 0x80 >>> (bitPos & 7);
      bitPos++;
    }
  };

  writeBits(BYTE_MODE, 4);
  writeBits(data.length, charCountBits(version));
  for (let i = 0; i < data.length; i++) writeBits(data[i], 8);

  // Terminator: up to four zero bits, then pad to a codeword boundary.
  const capacityBits = capacity * 8;
  bitPos = Math.min(bitPos + 4, capacityBits);
  bitPos = Math.min(bitPos + ((8 - (bitPos & 7)) & 7), capacityBits);

  // Fill any remaining codewords with the standard alternating pad bytes.
  for (let pad = 0xec, i = bitPos >>> 3; i < capacity; i++, pad ^= 0xec ^ 0x11) {
    out[i] = pad;
  }
  return out;
}

/** Split into ECC blocks, append Reed-Solomon codewords, and interleave. */
function addEccAndInterleave(data, version, ecc) {
  const level = ECC_LEVELS.indexOf(ecc);
  const blockCount = ECC_BLOCK_COUNT[level][version];
  const eccLen = ECC_CODEWORDS_PER_BLOCK[level][version];
  const total = rawCodewords(version);

  // Blocks come in two sizes differing by one codeword; the shorter ones first.
  const shortCount = blockCount - (total % blockCount);
  const shortDataLen = Math.floor(total / blockCount) - eccLen;

  const generator = rsGeneratorPoly(eccLen);
  const blocks = [];
  for (let i = 0, offset = 0; i < blockCount; i++) {
    const len = shortDataLen + (i < shortCount ? 0 : 1);
    const chunk = data.subarray(offset, offset + len);
    offset += len;
    blocks.push({ data: chunk, ecc: rsRemainder(chunk, generator) });
  }

  const result = new Uint8Array(total);
  let out = 0;
  // Data codewords, one from each block in turn. Short blocks have nothing to
  // contribute at the final index, so they are skipped there.
  for (let i = 0; i <= shortDataLen; i++) {
    for (let b = 0; b < blockCount; b++) {
      if (i < blocks[b].data.length) result[out++] = blocks[b].data[i];
    }
  }
  // Then the ECC codewords, which are the same length in every block.
  for (let i = 0; i < eccLen; i++) {
    for (let b = 0; b < blockCount; b++) result[out++] = blocks[b].ecc[i];
  }
  return result;
}

/** Lay out function patterns and data, then pick the lowest-penalty mask. */
function drawSymbol(codewords, version, ecc, forcedMask) {
  const size = version * 4 + 17;
  const modules = new Uint8Array(size * size);
  const reserved = new Uint8Array(size * size);

  const set = (x, y, dark) => {
    modules[y * size + x] = dark ? 1 : 0;
    reserved[y * size + x] = 1;
  };

  // Finder patterns and their separators, in the three corners.
  for (const [cx, cy] of [[3, 3], [size - 4, 3], [3, size - 4]]) {
    for (let dy = -4; dy <= 4; dy++) {
      for (let dx = -4; dx <= 4; dx++) {
        const x = cx + dx;
        const y = cy + dy;
        if (x < 0 || y < 0 || x >= size || y >= size) continue;
        const ring = Math.max(Math.abs(dx), Math.abs(dy));
        set(x, y, ring !== 2 && ring <= 3);
      }
    }
  }

  // Timing patterns.
  for (let i = 0; i < size; i++) {
    if (!reserved[6 * size + i]) set(i, 6, i % 2 === 0);
    if (!reserved[i * size + 6]) set(6, i, i % 2 === 0);
  }

  // Alignment patterns, skipping the three that would collide with finders.
  const aligns = alignmentPositions(version);
  for (let i = 0; i < aligns.length; i++) {
    for (let j = 0; j < aligns.length; j++) {
      const corner =
        (i === 0 && j === 0) ||
        (i === 0 && j === aligns.length - 1) ||
        (i === aligns.length - 1 && j === 0);
      if (corner) continue;
      for (let dy = -2; dy <= 2; dy++) {
        for (let dx = -2; dx <= 2; dx++) {
          set(aligns[j] + dx, aligns[i] + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
        }
      }
    }
  }

  // Reserve the format information area and the dark module.
  for (let i = 0; i < 9; i++) {
    if (!reserved[8 * size + i]) set(i, 8, false);
    if (!reserved[i * size + 8]) set(8, i, false);
  }
  for (let i = 0; i < 8; i++) {
    set(size - 1 - i, 8, false);
    set(8, size - 1 - i, false);
  }

  // Version information for versions 7 and up.
  if (version >= 7) {
    let rem = version;
    for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
    const bits = ((version << 12) | rem) >>> 0;
    for (let i = 0; i < 18; i++) {
      const dark = ((bits >>> i) & 1) === 1;
      const a = size - 11 + (i % 3);
      const b = Math.floor(i / 3);
      set(a, b, dark);
      set(b, a, dark);
    }
  }

  drawCodewords(modules, reserved, size, codewords);

  let bestMask = forcedMask;
  if (bestMask < 0 || bestMask > 7) {
    let bestPenalty = Infinity;
    for (let m = 0; m < 8; m++) {
      applyMask(modules, reserved, size, m);
      drawFormatBits(modules, size, ecc, m);
      const penalty = penaltyScore(modules, size);
      if (penalty < bestPenalty) {
        bestPenalty = penalty;
        bestMask = m;
      }
      applyMask(modules, reserved, size, m); // masking is its own inverse
    }
  }

  applyMask(modules, reserved, size, bestMask);
  drawFormatBits(modules, size, ecc, bestMask);
  return new QrSymbol(version, ecc, bestMask, modules);
}

/** Walk the two-module-wide zigzag from the bottom right, filling free modules. */
function drawCodewords(modules, reserved, size, codewords) {
  let bit = 0;
  const totalBits = codewords.length * 8;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5; // the vertical timing pattern column is skipped
    for (let vert = 0; vert < size; vert++) {
      for (let j = 0; j < 2; j++) {
        const x = right - j;
        const upward = ((right + 1) & 2) === 0;
        const y = upward ? size - 1 - vert : vert;
        if (reserved[y * size + x] || bit >= totalBits) continue;
        modules[y * size + x] = (codewords[bit >>> 3] >>> (7 - (bit & 7))) & 1;
        bit++;
      }
    }
  }
}

/** XOR the mask pattern over every non-function module. */
function applyMask(modules, reserved, size, mask) {
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      if (reserved[y * size + x]) continue;
      let invert;
      switch (mask) {
        case 0: invert = (x + y) % 2 === 0; break;
        case 1: invert = y % 2 === 0; break;
        case 2: invert = x % 3 === 0; break;
        case 3: invert = (x + y) % 3 === 0; break;
        case 4: invert = (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0; break;
        case 5: invert = ((x * y) % 2) + ((x * y) % 3) === 0; break;
        case 6: invert = (((x * y) % 2) + ((x * y) % 3)) % 2 === 0; break;
        case 7: invert = (((x + y) % 2) + ((x * y) % 3)) % 2 === 0; break;
        default: throw new RangeError(`invalid mask ${mask}`);
      }
      if (invert) modules[y * size + x] ^= 1;
    }
  }
}

/** Write the BCH-protected format information into both of its copies. */
function drawFormatBits(modules, size, ecc, mask) {
  const value = (ECC_FORMAT_BITS[ecc] << 3) | mask;
  let rem = value;
  for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
  const bits = (((value << 10) | rem) ^ 0x5412) >>> 0;

  const put = (x, y, dark) => { modules[y * size + x] = dark ? 1 : 0; };

  // First copy: around the top-left finder.
  for (let i = 0; i <= 5; i++) put(8, i, (bits >>> i) & 1);
  put(8, 7, (bits >>> 6) & 1);
  put(8, 8, (bits >>> 7) & 1);
  put(7, 8, (bits >>> 8) & 1);
  for (let i = 9; i < 15; i++) put(14 - i, 8, (bits >>> i) & 1);

  // Second copy: split between the other two finders.
  for (let i = 0; i < 8; i++) put(size - 1 - i, 8, (bits >>> i) & 1);
  for (let i = 8; i < 15; i++) put(8, size - 15 + i, (bits >>> i) & 1);
  put(8, size - 8, 1); // the always-dark module
}

/** The four ISO penalty rules used to choose between masks. */
function penaltyScore(modules, size) {
  const N1 = 3, N2 = 3, N3 = 40, N4 = 10;
  let score = 0;
  const at = (x, y) => modules[y * size + x];

  // Push a run onto the sliding window of the last seven run lengths. The very
  // first run of a line borders the quiet zone, which counts as light modules.
  const pushRun = (history, length) => {
    if (history[0] === 0) length += size;
    history.pop();
    history.unshift(length);
  };

  // Rule 3: a dark:light:dark:light:dark run of ratio 1:1:3:1:1 bounded by four
  // light modules looks like a finder pattern and confuses locators.
  const countFinderLookalikes = (h) => {
    const n = h[1];
    const core = n > 0 && h[2] === n && h[3] === n * 3 && h[4] === n && h[5] === n;
    return (
      (core && h[0] >= n * 4 && h[6] >= n ? 1 : 0) + (core && h[6] >= n * 4 && h[0] >= n ? 1 : 0)
    );
  };

  const terminate = (history, runColour, runLength) => {
    if (runColour === 1) {
      pushRun(history, runLength);
      runLength = 0;
    }
    pushRun(history, runLength + size); // trailing quiet zone
    return countFinderLookalikes(history);
  };

  // Rules 1 and 3, scanned along rows then columns.
  for (let pass = 0; pass < 2; pass++) {
    for (let a = 0; a < size; a++) {
      let runColour = 0;
      let runLength = 0;
      const history = [0, 0, 0, 0, 0, 0, 0];
      for (let b = 0; b < size; b++) {
        const colour = pass === 0 ? at(b, a) : at(a, b);
        if (colour === runColour) {
          runLength++;
          if (runLength === 5) score += N1;
          else if (runLength > 5) score++;
        } else {
          pushRun(history, runLength);
          if (runColour === 0) score += countFinderLookalikes(history) * N3;
          runColour = colour;
          runLength = 1;
        }
      }
      score += terminate(history, runColour, runLength) * N3;
    }
  }

  // Rule 2: solid 2x2 blocks of one colour.
  for (let y = 0; y < size - 1; y++) {
    for (let x = 0; x < size - 1; x++) {
      const c = at(x, y);
      if (c === at(x + 1, y) && c === at(x, y + 1) && c === at(x + 1, y + 1)) score += N2;
    }
  }

  // Rule 4: deviation of the dark module ratio from 50%.
  let dark = 0;
  for (let i = 0; i < modules.length; i++) dark += modules[i];
  const total = size * size;
  const k = Math.ceil(Math.abs(dark * 20 - total * 10) / total) - 1;
  score += Math.max(0, k) * N4;
  return score;
}

/**
 * Render a symbol into a packed 1-byte-per-module buffer with a quiet zone,
 * ready to be blitted to a canvas.
 */
export function toMatrix(symbol, quietZone = 4) {
  const side = symbol.size + quietZone * 2;
  const out = new Uint8Array(side * side);
  for (let y = 0; y < symbol.size; y++) {
    for (let x = 0; x < symbol.size; x++) {
      out[(y + quietZone) * side + (x + quietZone)] = symbol.modules[y * symbol.size + x];
    }
  }
  return { side, data: out };
}
