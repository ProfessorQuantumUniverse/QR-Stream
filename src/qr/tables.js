/**
 * Capacity tables from ISO/IEC 18004.
 *
 * Index 0 of each row is unused padding so that a QR version number (1..40)
 * can index directly. Everything else about a symbol -- total codewords,
 * alignment pattern positions, block sizes -- is derived from these two tables
 * plus the module geometry, rather than being transcribed separately.
 *
 * `tests/unit/qr-encoder.test.mjs` round-trips every version/level pair through
 * an independent decoder, so a typo here fails the build rather than shipping.
 */

/** ECC level ordinals used to index the tables below. */
export const ECC_LEVELS = ['L', 'M', 'Q', 'H'];

/** Bit patterns written into the format information area (not the ordinals). */
export const ECC_FORMAT_BITS = { L: 1, M: 0, Q: 3, H: 2 };

/** Number of error correction codewords in each block. */
export const ECC_CODEWORDS_PER_BLOCK = [
  // 0   1   2   3   4   5   6   7   8   9  10  11  12  13  14  15  16  17  18  19  20  21  22  23  24  25  26  27  28  29  30  31  32  33  34  35  36  37  38  39  40
  [0, 7, 10, 15, 20, 26, 18, 20, 24, 30, 18, 20, 24, 26, 30, 22, 24, 28, 30, 28, 28, 28, 28, 30, 30, 26, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30], // L
  [0, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22, 22, 24, 24, 28, 28, 26, 26, 26, 26, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28], // M
  [0, 13, 22, 18, 26, 18, 24, 18, 22, 20, 24, 28, 26, 24, 20, 30, 24, 28, 28, 26, 30, 28, 30, 30, 30, 30, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30], // Q
  [0, 17, 28, 22, 16, 22, 28, 26, 26, 24, 28, 24, 28, 22, 24, 24, 30, 28, 28, 26, 28, 30, 24, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30], // H
];

/** Number of error correction blocks the data is split across. */
export const ECC_BLOCK_COUNT = [
  [0, 1, 1, 1, 1, 1, 2, 2, 2, 2, 4, 4, 4, 4, 4, 6, 6, 6, 6, 7, 8, 8, 9, 9, 10, 12, 12, 12, 13, 14, 15, 16, 17, 18, 19, 19, 20, 21, 22, 24, 25], // L
  [0, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8, 9, 9, 10, 10, 11, 13, 14, 16, 17, 17, 18, 20, 21, 23, 25, 26, 28, 29, 31, 33, 35, 37, 38, 40, 43, 45, 47, 49], // M
  [0, 1, 1, 2, 2, 4, 4, 6, 6, 8, 8, 8, 10, 12, 16, 12, 17, 16, 18, 21, 20, 23, 23, 25, 27, 29, 34, 34, 35, 38, 40, 43, 45, 48, 51, 53, 56, 59, 62, 65, 68], // Q
  [0, 1, 1, 2, 4, 4, 4, 5, 6, 8, 8, 11, 11, 16, 16, 18, 16, 19, 21, 25, 25, 25, 34, 30, 32, 35, 37, 40, 42, 45, 48, 51, 54, 57, 60, 63, 66, 70, 74, 77, 81], // H
];

export const MIN_VERSION = 1;
export const MAX_VERSION = 40;

/**
 * Total number of data + error correction modules in a symbol, i.e. everything
 * except the finder patterns, timing patterns, alignment patterns, format
 * information and version information.
 */
export function rawDataModules(version) {
  let modules = (16 * version + 128) * version + 64;
  if (version >= 2) {
    const alignCount = Math.floor(version / 7) + 2;
    modules -= (25 * alignCount - 10) * alignCount - 55;
    if (version >= 7) modules -= 36; // two 6x3 version information blocks
  }
  return modules;
}

/** Total codewords (data + ECC) available in a symbol. */
export function rawCodewords(version) {
  return Math.floor(rawDataModules(version) / 8);
}

/** Codewords available for actual payload data after ECC is reserved. */
export function dataCodewords(version, ecc) {
  const level = ECC_LEVELS.indexOf(ecc);
  if (level < 0) throw new RangeError(`unknown ECC level ${ecc}`);
  return (
    rawCodewords(version) -
    ECC_CODEWORDS_PER_BLOCK[level][version] * ECC_BLOCK_COUNT[level][version]
  );
}

/** Number of bits used by the character count field in byte mode. */
export function charCountBits(version) {
  return version <= 9 ? 8 : 16;
}

/**
 * Largest binary payload (in bytes) that fits in a symbol, accounting for the
 * 4-bit mode indicator and the character count field.
 */
export function byteCapacity(version, ecc) {
  const bits = dataCodewords(version, ecc) * 8 - 4 - charCountBits(version);
  return Math.max(0, Math.floor(bits / 8));
}

/** Centre coordinates of the alignment patterns for a version. */
export function alignmentPositions(version) {
  if (version === 1) return [];
  const count = Math.floor(version / 7) + 2;
  const size = version * 4 + 17;
  // Version 32 is the one case the general formula gets wrong.
  const step = version === 32 ? 26 : Math.ceil((version * 4 + 4) / (count * 2 - 2)) * 2;
  const positions = [6];
  for (let pos = size - 7; positions.length < count; pos -= step) {
    positions.splice(1, 0, pos);
  }
  return positions;
}
