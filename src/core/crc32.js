/**
 * CRC-32 (IEEE 802.3), used to verify that a reassembled payload is byte-exact.
 *
 * QR's own Reed-Solomon layer already rejects misread symbols, so this is not
 * about transmission noise. It guards the seams: a receiver that mixed frames
 * from two different streams, a fountain decode that converged on the wrong
 * solution, or a truncated file. Cheap insurance on the one thing the user
 * actually cares about.
 */

const TABLE = new Uint32Array(256);
for (let i = 0; i < 256; i++) {
  let c = i;
  for (let bit = 0; bit < 8; bit++) {
    c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  }
  TABLE[i] = c >>> 0;
}

/**
 * @param {Uint8Array} bytes
 * @param {number} [seed] running value from a previous call, for streaming
 * @returns {number} unsigned 32-bit checksum
 */
export function crc32(bytes, seed = 0) {
  let crc = (seed ^ 0xffffffff) >>> 0;
  for (let i = 0; i < bytes.length; i++) {
    crc = (TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8)) >>> 0;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/** Format a checksum the way it is shown in the UI. */
export function formatCrc(value) {
  return value.toString(16).padStart(8, '0').toUpperCase();
}
