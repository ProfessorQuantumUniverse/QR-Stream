/**
 * Payload compression using the browser's built-in DEFLATE.
 *
 * Every byte removed here is a frame the receiver does not have to catch, so
 * compression is the single cheapest speed-up available -- text and source code
 * routinely shrink by 60-70%. Already-compressed input (images, archives) grows
 * slightly under DEFLATE, so the sender compresses speculatively and keeps the
 * result only if it actually won; the manifest records which it chose.
 *
 * `CompressionStream` is unavailable in a few older browsers. Rather than ship
 * a DEFLATE implementation for that case, the sender just transmits raw bytes.
 * The receiver only needs `DecompressionStream` if a stream actually arrives
 * compressed, and it says so plainly when it cannot.
 */

export const canCompress = typeof CompressionStream !== 'undefined';
export const canDecompress = typeof DecompressionStream !== 'undefined';

async function pipeThrough(bytes, stream) {
  const writer = stream.writable.getWriter();
  writer.write(bytes);
  writer.close();

  const reader = stream.readable.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    total += value.length;
  }

  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

/** Raw DEFLATE, no zlib or gzip wrapper -- those bytes are pure overhead here. */
export async function deflate(bytes) {
  if (!canCompress) throw new Error('CompressionStream is not available');
  return pipeThrough(bytes, new CompressionStream('deflate-raw'));
}

export async function inflate(bytes) {
  if (!canDecompress) throw new Error('DecompressionStream is not available');
  return pipeThrough(bytes, new DecompressionStream('deflate-raw'));
}

/**
 * Compress if it helps, otherwise pass through.
 *
 * @param {Uint8Array} bytes
 * @param {boolean} [enabled]
 * @returns {Promise<{bytes: Uint8Array, compressed: boolean}>}
 */
export async function maybeCompress(bytes, enabled = true) {
  if (!enabled || !canCompress || bytes.length < 64) {
    return { bytes, compressed: false };
  }
  try {
    const packed = await deflate(bytes);
    // A marginal win is not worth making the receiver depend on
    // DecompressionStream, so require a real saving.
    if (packed.length < bytes.length * 0.95) return { bytes: packed, compressed: true };
  } catch {
    // Fall through to sending the payload uncompressed.
  }
  return { bytes, compressed: false };
}
