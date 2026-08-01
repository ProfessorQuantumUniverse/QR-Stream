/**
 * The QR-Stream wire format.
 *
 * Version 1 of this project sent `index|total|text` as a UTF-8 string. That
 * cannot carry binary data, has no way to name a file, no way to tell two
 * concurrent streams apart, and no way to know whether what you reassembled is
 * what was sent. This is the replacement: a compact binary framing that fits in
 * a QR byte-mode segment with room to spare.
 *
 * Every frame is self-delimiting and independently verifiable, because there is
 * no back-channel -- a receiver may join mid-stream, at any frame, having
 * missed anything.
 *
 *   offset  size  field
 *   0       2     magic, 'Q' 'S'
 *   2       1     high nibble: protocol version; low nibble: frame type
 *   3       2     stream id, so two senders in view never merge
 *   5       ...   type-specific body
 *   n-4     4     CRC-32 over everything preceding it
 *
 * MANIFEST body (type 1) -- describes what is being sent:
 *   5       4     payload length in bytes (after compression)
 *   9       4     CRC-32 of the complete payload
 *   13      2     block size
 *   15      2     block count (k)
 *   17      1     flags
 *   18      1     name length, followed by that many UTF-8 bytes
 *   ...     1     mime length, followed by that many UTF-8 bytes
 *
 * BLOCK body (type 2) -- one coded packet from the fountain:
 *   5       4     seed identifying the block combination
 *   9       2     block count (k), repeated so blocks are useful before the
 *                 first manifest arrives
 *   11      ...   blockSize bytes of XORed payload
 */

import { crc32 } from './crc32.js';
import { utf8Decode, utf8Encode } from './bytes.js';

export const MAGIC_0 = 0x51; // 'Q'
export const MAGIC_1 = 0x53; // 'S'
export const PROTOCOL_VERSION = 1;

export const FRAME_MANIFEST = 1;
export const FRAME_BLOCK = 2;

export const FLAG_COMPRESSED = 1 << 0;
export const FLAG_BINARY = 1 << 1;

/** Bytes of framing around a block payload: header + seed + k + CRC. */
export const BLOCK_OVERHEAD = 5 + 4 + 2 + 4;
/** Framing around a manifest, excluding the variable-length name and mime. */
export const MANIFEST_OVERHEAD = 5 + 4 + 4 + 2 + 2 + 1 + 1 + 1 + 4;

class Writer {
  constructor(size) {
    this.bytes = new Uint8Array(size);
    this.view = new DataView(this.bytes.buffer);
    this.offset = 0;
  }
  u8(value) {
    this.view.setUint8(this.offset, value);
    this.offset += 1;
    return this;
  }
  u16(value) {
    this.view.setUint16(this.offset, value);
    this.offset += 2;
    return this;
  }
  u32(value) {
    this.view.setUint32(this.offset, value >>> 0);
    this.offset += 4;
    return this;
  }
  raw(source) {
    this.bytes.set(source, this.offset);
    this.offset += source.length;
    return this;
  }
  /** Append the trailing checksum and return the finished frame. */
  seal() {
    this.u32(crc32(this.bytes.subarray(0, this.offset)));
    return this.bytes.subarray(0, this.offset);
  }
}

function header(writer, type, streamId) {
  return writer
    .u8(MAGIC_0)
    .u8(MAGIC_1)
    .u8((PROTOCOL_VERSION << 4) | type)
    .u16(streamId & 0xffff);
}

/**
 * @typedef {object} Manifest
 * @property {number} streamId
 * @property {number} payloadLength compressed length in bytes
 * @property {number} payloadCrc
 * @property {number} blockSize
 * @property {number} blockCount
 * @property {boolean} compressed
 * @property {boolean} binary true for files, false for text
 * @property {string} name
 * @property {string} mime
 */

/** @param {Manifest} manifest */
export function encodeManifest(manifest) {
  const name = utf8Encode(manifest.name ?? '').subarray(0, 255);
  const mime = utf8Encode(manifest.mime ?? '').subarray(0, 255);
  const writer = new Writer(MANIFEST_OVERHEAD + name.length + mime.length);
  header(writer, FRAME_MANIFEST, manifest.streamId);
  writer
    .u32(manifest.payloadLength)
    .u32(manifest.payloadCrc)
    .u16(manifest.blockSize)
    .u16(manifest.blockCount)
    .u8((manifest.compressed ? FLAG_COMPRESSED : 0) | (manifest.binary ? FLAG_BINARY : 0))
    .u8(name.length)
    .raw(name)
    .u8(mime.length)
    .raw(mime);
  return writer.seal();
}

/**
 * @param {number} streamId
 * @param {number} seed
 * @param {number} blockCount
 * @param {Uint8Array} block
 */
export function encodeBlock(streamId, seed, blockCount, block) {
  const writer = new Writer(BLOCK_OVERHEAD + block.length);
  header(writer, FRAME_BLOCK, streamId);
  writer.u32(seed).u16(blockCount).raw(block);
  return writer.seal();
}

/**
 * Parse a frame. Returns null for anything that is not a valid QR-Stream frame,
 * which is the normal case when the camera picks up an unrelated QR code.
 *
 * @param {Uint8Array} frame
 */
export function decodeFrame(frame) {
  if (!frame || frame.length < 9) return null;
  if (frame[0] !== MAGIC_0 || frame[1] !== MAGIC_1) return null;

  const version = frame[2] >> 4;
  if (version !== PROTOCOL_VERSION) return null;

  const view = new DataView(frame.buffer, frame.byteOffset, frame.byteLength);
  const expected = view.getUint32(frame.length - 4);
  if (crc32(frame.subarray(0, frame.length - 4)) !== expected) return null;

  const type = frame[2] & 0x0f;
  const streamId = view.getUint16(3);

  if (type === FRAME_BLOCK) {
    if (frame.length < BLOCK_OVERHEAD) return null;
    return {
      type: FRAME_BLOCK,
      streamId,
      seed: view.getUint32(5),
      blockCount: view.getUint16(9),
      block: frame.subarray(11, frame.length - 4),
    };
  }

  if (type === FRAME_MANIFEST) {
    if (frame.length < MANIFEST_OVERHEAD) return null;
    const flags = view.getUint8(17);
    let offset = 18;
    const nameLength = view.getUint8(offset++);
    if (offset + nameLength + 1 > frame.length - 4) return null;
    const name = utf8Decode(frame.subarray(offset, offset + nameLength));
    offset += nameLength;
    const mimeLength = view.getUint8(offset++);
    if (offset + mimeLength > frame.length - 4) return null;
    const mime = utf8Decode(frame.subarray(offset, offset + mimeLength));
    return {
      type: FRAME_MANIFEST,
      streamId,
      payloadLength: view.getUint32(5),
      payloadCrc: view.getUint32(9),
      blockSize: view.getUint16(13),
      blockCount: view.getUint16(15),
      compressed: (flags & FLAG_COMPRESSED) !== 0,
      binary: (flags & FLAG_BINARY) !== 0,
      name,
      mime,
    };
  }

  return null;
}

/**
 * Largest block payload that fits alongside the framing in a QR symbol of the
 * given raw byte capacity.
 */
export function blockSizeForCapacity(capacity) {
  return Math.max(1, capacity - BLOCK_OVERHEAD);
}
