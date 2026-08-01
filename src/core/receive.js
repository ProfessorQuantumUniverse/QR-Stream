/**
 * Receiver-side stream assembly.
 *
 * The receiver is deliberately tolerant: it may start filming at any point,
 * miss any number of frames, see the same frame many times, or have an
 * unrelated QR code wander through shot. None of those are errors. The only
 * things it treats as real events are a new stream appearing, progress being
 * made, and the payload completing with a matching checksum.
 *
 * Decoding starts as soon as the first *block* arrives, because a block frame
 * carries the block count and its own length implies the block size. The
 * manifest is only needed to finish: to trim the padding, verify the checksum,
 * and name the result.
 */

import { LtDecoder } from './fountain.js';
import { crc32 } from './crc32.js';
import { inflate, canDecompress } from './compress.js';
import { utf8Decode } from './bytes.js';
import { FRAME_BLOCK, FRAME_MANIFEST, decodeFrame } from './protocol.js';

/** Rolling window used for the throughput readout, in milliseconds. */
const RATE_WINDOW_MS = 4000;

export class ReceiverSession {
  constructor() {
    this.reset();
  }

  reset() {
    /** @type {number|null} */
    this.streamId = null;
    /** @type {import('./protocol.js').Manifest|null} */
    this.manifest = null;
    /** @type {LtDecoder|null} */
    this.decoder = null;
    this.blockCount = 0;
    this.blockSize = 0;
    this.startedAt = null;
    this.finishedAt = null;
    /** Timestamps of frames that advanced the decode, for the rate readout. */
    this.recentUseful = [];
    /** Every valid frame seen, including repeats of frames already decoded. */
    this.framesSeen = 0;
    this.duplicateFrames = 0;
    this.foreignFrames = 0;
    this.complete = false;
  }

  get progress() {
    return this.decoder ? this.decoder.progress : 0;
  }

  get recoveredBlocks() {
    return this.decoder ? this.decoder.recovered : 0;
  }

  /** Blocks recovered per second, averaged over a short window. */
  get blocksPerSecond() {
    if (this.recentUseful.length < 2) return 0;
    const span = this.recentUseful[this.recentUseful.length - 1] - this.recentUseful[0];
    if (span <= 0) return 0;
    return ((this.recentUseful.length - 1) * 1000) / span;
  }

  /** Estimated seconds remaining, or null when there is nothing to base it on. */
  get secondsRemaining() {
    if (!this.decoder || this.complete) return null;
    const rate = this.blocksPerSecond;
    if (rate <= 0) return null;
    return (this.blockCount - this.decoder.recovered) / rate;
  }

  /** Payload bytes per second, useful as a headline number. */
  get bytesPerSecond() {
    return this.blocksPerSecond * this.blockSize;
  }

  recoveredMask() {
    return this.decoder ? this.decoder.recoveredMask() : new Uint8Array(0);
  }

  /**
   * Feed in the bytes decoded from one QR symbol.
   *
   * @param {Uint8Array|number[]} raw
   * @param {number} [now] timestamp, injectable for testing
   * @returns {{status: string, [key: string]: any}}
   */
  ingest(raw, now = Date.now()) {
    const bytes = raw instanceof Uint8Array ? raw : Uint8Array.from(raw);
    const frame = decodeFrame(bytes);
    if (!frame) {
      this.foreignFrames++;
      return { status: 'ignored' };
    }

    // A different stream id means a different transfer, so start over rather
    // than mixing two payloads into one corrupt result.
    if (this.streamId !== null && frame.streamId !== this.streamId) {
      this.reset();
    }

    let restarted = false;
    if (this.streamId === null) {
      this.streamId = frame.streamId;
      this.startedAt = now;
      restarted = true;
    }

    this.framesSeen++;

    const result =
      frame.type === FRAME_MANIFEST ? this.#onManifest(frame) : this.#onBlock(frame, now);
    if (restarted && result.status === 'ignored') return result;
    return restarted ? { ...result, streamStarted: true } : result;
  }

  #onManifest(frame) {
    if (this.manifest) return { status: 'duplicate' };

    // Blocks may have arrived first and established the geometry. If the
    // manifest disagrees, one of them is from a stream we misidentified.
    if (this.decoder && (frame.blockCount !== this.blockCount || frame.blockSize !== this.blockSize)) {
      this.reset();
      return { status: 'ignored' };
    }

    this.manifest = frame;
    this.blockCount = frame.blockCount;
    this.blockSize = frame.blockSize;
    if (!this.decoder) this.decoder = new LtDecoder(this.blockCount, this.blockSize);
    return { status: 'manifest', manifest: frame };
  }

  #onBlock(frame, now) {
    if (!this.decoder) {
      if (frame.blockCount < 1 || frame.block.length < 1) return { status: 'ignored' };
      this.blockCount = frame.blockCount;
      this.blockSize = frame.block.length;
      this.decoder = new LtDecoder(this.blockCount, this.blockSize);
    } else if (frame.blockCount !== this.blockCount || frame.block.length !== this.blockSize) {
      return { status: 'ignored' };
    }

    if (this.complete) return { status: 'duplicate' };

    const advanced = this.decoder.addPacket(frame.seed, frame.block);
    if (!advanced) {
      this.duplicateFrames++;
      return { status: 'duplicate' };
    }

    this.recentUseful.push(now);
    while (this.recentUseful.length > 2 && now - this.recentUseful[0] > RATE_WINDOW_MS) {
      this.recentUseful.shift();
    }

    if (this.decoder.complete) {
      this.complete = true;
      this.finishedAt = now;
      return { status: 'decoded' };
    }
    return { status: 'progress' };
  }

  /** True when every block is recovered *and* we know how to interpret them. */
  get ready() {
    return this.complete && this.manifest !== null;
  }

  /**
   * Produce the final result: decompressed, checksum-verified, and typed.
   *
   * @returns {Promise<{bytes: Uint8Array, text: string|null, name: string, mime: string,
   *                    binary: boolean, verified: boolean, elapsedMs: number}>}
   */
  async result() {
    if (!this.ready) throw new Error('transfer is not complete');
    const manifest = this.manifest;

    let payload = this.decoder.assemble(manifest.payloadLength);

    const verified = crc32(payload) === manifest.payloadCrc;
    if (!verified) {
      throw new Error(
        'Checksum mismatch: the reassembled payload does not match what the sender described.',
      );
    }

    if (manifest.compressed) {
      if (!canDecompress) {
        throw new Error(
          'This stream is compressed, but this browser has no DecompressionStream. ' +
            'Ask the sender to disable compression.',
        );
      }
      payload = await inflate(payload);
    }

    return {
      bytes: payload,
      text: manifest.binary ? null : utf8Decode(payload),
      name: manifest.name || (manifest.binary ? 'received.bin' : 'received.txt'),
      mime: manifest.mime || (manifest.binary ? 'application/octet-stream' : 'text/plain'),
      binary: manifest.binary,
      verified,
      elapsedMs: (this.finishedAt ?? 0) - (this.startedAt ?? 0),
    };
  }
}
