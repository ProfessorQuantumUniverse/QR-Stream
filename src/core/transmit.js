/**
 * Turns a payload into an endless stream of QR frames.
 *
 * Two decisions shape everything downstream:
 *
 * 1. Every symbol is pinned to the same QR version, so the code never changes
 *    size mid-stream. A symbol that grows and shrinks makes phone cameras hunt
 *    for focus, and hunting costs far more frames than the few bytes saved by
 *    letting small frames use a smaller symbol.
 *
 * 2. The manifest is re-sent periodically rather than once at the start. There
 *    is no back-channel and no way to ask for a repeat, so a receiver that
 *    starts filming halfway through must still be able to learn what it is
 *    looking at.
 */

import { LtEncoder } from './fountain.js';
import { maybeCompress } from './compress.js';
import { crc32 } from './crc32.js';
import { randomSeed } from './prng.js';
import { utf8Decode, utf8Encode } from './bytes.js';
import { BLOCK_OVERHEAD, MANIFEST_OVERHEAD, encodeBlock, encodeManifest } from './protocol.js';
import { byteCapacity } from '../qr/encoder.js';

/** How often a manifest frame is inserted into the block stream. */
const MANIFEST_INTERVAL = 12;

export const DEFAULT_VERSION = 16;
export const DEFAULT_ECC = 'M';

/**
 * @typedef {object} TransmissionOptions
 * @property {Uint8Array} data raw payload
 * @property {string} [name] file name, shown to the receiving user
 * @property {string} [mime]
 * @property {boolean} [binary] true for files, false for text
 * @property {number} [version] QR version, 1-40; higher packs more per frame
 * @property {'L'|'M'|'Q'|'H'} [ecc]
 * @property {boolean} [compress]
 * @property {number} [streamId]
 */

/**
 * Prepare a transmission. Compression is asynchronous, hence the promise.
 *
 * @param {TransmissionOptions} options
 */
export async function createTransmission(options) {
  const {
    data,
    name = '',
    mime = 'text/plain',
    binary = false,
    version = DEFAULT_VERSION,
    ecc = DEFAULT_ECC,
    compress = true,
    streamId = randomSeed() & 0xffff,
  } = options;

  const capacity = byteCapacity(version, ecc);
  if (capacity - BLOCK_OVERHEAD < 16) {
    throw new RangeError(
      `QR version ${version} at level ${ecc} leaves only ${capacity - BLOCK_OVERHEAD} bytes ` +
        'per frame; choose a higher version or a lower error correction level',
    );
  }

  const { bytes: payload, compressed } = await maybeCompress(data, compress);
  const labels = fitLabels(name, mime, capacity);

  // A payload smaller than one frame does not need a frame that big, and a
  // sparse symbol is markedly easier to scan than a dense one. Shrink to the
  // smallest version that still holds the payload and the manifest.
  let effectiveVersion = version;
  let blockSize = capacity - BLOCK_OVERHEAD;
  if (payload.length < blockSize) {
    blockSize = Math.max(1, payload.length);
    const needed = Math.max(blockSize + BLOCK_OVERHEAD, labels.manifestLength);
    for (let candidate = 1; candidate <= version; candidate++) {
      if (byteCapacity(candidate, ecc) >= needed) {
        effectiveVersion = candidate;
        break;
      }
    }
  }

  const encoder = new LtEncoder(payload, blockSize);
  const manifest = {
    streamId,
    payloadLength: payload.length,
    payloadCrc: crc32(payload),
    blockSize,
    blockCount: encoder.k,
    compressed,
    binary,
    name: labels.name,
    mime: labels.mime,
  };

  return new Transmission(encoder, manifest, {
    version: effectiveVersion,
    ecc,
    originalLength: data.length,
  });
}

/**
 * Keep the manifest inside one symbol.
 *
 * A long filename can otherwise push the manifest past the capacity of the
 * symbol the stream is built around, and a manifest that never fits is a
 * transfer that never completes. Trimming a name is a far better failure than
 * that, so the name is shortened until it fits.
 */
function fitLabels(name, mime, capacity) {
  const mimeBytes = utf8Encode(mime ?? '').subarray(0, 255);
  const fixed = MANIFEST_OVERHEAD + mimeBytes.length;
  let nameBytes = utf8Encode(name ?? '').subarray(0, 255);

  if (fixed + nameBytes.length > capacity) {
    nameBytes = nameBytes.subarray(0, Math.max(0, capacity - fixed));
  }

  return {
    // Truncation can land mid-codepoint; drop the resulting replacement chars.
    name: utf8Decode(nameBytes).replace(/�+$/, ''),
    mime: utf8Decode(mimeBytes).replace(/�+$/, ''),
    manifestLength: fixed + nameBytes.length,
  };
}

export class Transmission {
  constructor(encoder, manifest, meta) {
    this.encoder = encoder;
    this.manifest = manifest;
    this.version = meta.version;
    this.ecc = meta.ecc;
    this.originalLength = meta.originalLength;
    this.manifestFrame = encodeManifest(manifest);

    /** Index of the next frame to emit; also drives the seed sequence. */
    this.position = 0;
    /** Frames emitted since the stream started, including manifests. */
    this.framesSent = 0;
  }

  get blockCount() {
    return this.manifest.blockCount;
  }

  get blockSize() {
    return this.manifest.blockSize;
  }

  /** Bytes of payload actually transmitted, after compression. */
  get payloadLength() {
    return this.manifest.payloadLength;
  }

  get compressionRatio() {
    if (!this.originalLength) return 1;
    return this.manifest.payloadLength / this.originalLength;
  }

  /**
   * Minimum frames a receiver needs in the best case: one systematic pass plus
   * the manifests interleaved into it.
   */
  get minimumFrames() {
    return this.blockCount + Math.ceil(this.blockCount / MANIFEST_INTERVAL) + 1;
  }

  /** True once a full systematic pass has been emitted at least once. */
  get systematicPassComplete() {
    return this.position >= this.blockCount;
  }

  /**
   * Produce the next frame in the stream. The first frame is always a manifest
   * so a receiver watching from the start knows immediately what is coming.
   *
   * @returns {{bytes: Uint8Array, kind: 'manifest'|'block', seed: number|null}}
   */
  next() {
    const isManifest = this.framesSent % MANIFEST_INTERVAL === 0;
    this.framesSent++;

    if (isManifest) {
      return { bytes: this.manifestFrame, kind: 'manifest', seed: null };
    }

    const seed = this.position++;
    const block = this.encoder.packet(seed);
    return {
      bytes: encodeBlock(this.manifest.streamId, seed, this.blockCount, block),
      kind: 'block',
      seed,
    };
  }

  /** Restart the seed sequence, so the systematic pass is sent again. */
  rewind() {
    this.position = 0;
    this.framesSent = 0;
  }
}
