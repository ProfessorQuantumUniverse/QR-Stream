/**
 * Systematic LT codes -- the rateless erasure code at the heart of QR-Stream.
 *
 * The original version of this project cut the payload into N chunks and looped
 * over them forever. That works, but it makes the receiver responsible for
 * catching one *specific* frame: miss chunk 7 and you wait a whole cycle for it
 * to come round again, and a camera that drops frames periodically can miss the
 * same chunk repeatedly and never finish.
 *
 * A fountain code removes the notion of a specific frame entirely. The sender
 * emits an endless stream of packets, each the XOR of a pseudo-randomly chosen
 * subset of source blocks, identified only by the 32-bit seed that generated
 * the subset. The receiver collects *any* packets it happens to see and peels
 * them apart; once it has modestly more than N packets' worth, the whole
 * payload pops out. Nothing needs to be requested, acknowledged or retried,
 * which is exactly right for a channel that is physically one-way.
 *
 * Reference: M. Luby, "LT Codes", FOCS 2002.
 */

import { mulberry32, scramble } from './prng.js';

/**
 * Robust soliton parameters. `c` scales how many degree-one packets are held in
 * reserve to keep the peeling process from stalling; `delta` is the tolerated
 * failure probability. These values are tuned for the block counts a QR stream
 * actually produces (roughly 4 to 4000).
 */
const SOLITON_C = 0.05;
const SOLITON_DELTA = 0.05;

const cdfCache = new Map();

/**
 * Cumulative degree distribution for `k` source blocks.
 *
 * The ideal soliton distribution is optimal in expectation but has no margin:
 * one unlucky draw and the decoder runs out of degree-one packets. The robust
 * variant adds a spike of extra low-degree packets, trading a few percent of
 * overhead for a decoder that reliably finishes.
 */
function degreeCdf(k) {
  const cached = cdfCache.get(k);
  if (cached) return cached;

  const weights = new Float64Array(k + 1);
  // Ideal soliton: rho(1) = 1/k, rho(d) = 1/(d(d-1)).
  weights[1] = 1 / k;
  for (let d = 2; d <= k; d++) weights[d] = 1 / (d * (d - 1));

  // Robust component tau, spiking at k/S.
  const s = SOLITON_C * Math.log(k / SOLITON_DELTA) * Math.sqrt(k);
  let pivot = Math.round(k / s);
  if (!Number.isFinite(pivot) || pivot < 1) pivot = 1;
  if (pivot > k) pivot = k;
  for (let d = 1; d < pivot; d++) weights[d] += s / (k * d);
  weights[pivot] += Math.max(0, (s * Math.log(s / SOLITON_DELTA)) / k);

  let total = 0;
  for (let d = 1; d <= k; d++) total += weights[d];

  const cdf = new Float64Array(k + 1);
  let running = 0;
  for (let d = 1; d <= k; d++) {
    running += weights[d] / total;
    cdf[d] = running;
  }
  cdf[k] = 1;

  cdfCache.set(k, cdf);
  return cdf;
}

/**
 * Which source blocks combine into the packet identified by `seed`?
 *
 * Seeds below `k` are *systematic*: they map to a single source block, so the
 * first pass over a payload is a plain, uncoded transmission. A receiver that
 * has a clean view for one full cycle is then done in exactly k frames with no
 * coding overhead at all, and the fountain only starts paying for itself once
 * frames actually go missing. Seeds at or above `k` draw from the soliton
 * distribution.
 *
 * @param {number} seed 32-bit packet identifier
 * @param {number} k number of source blocks
 * @returns {number[]} source block indices to XOR together
 */
export function blocksForSeed(seed, k) {
  if (k <= 0) return [];
  if (seed < k) return [seed];
  if (k === 1) return [0];

  const random = mulberry32(scramble(seed));
  const cdf = degreeCdf(k);

  // Invert the CDF by binary search.
  const u = random();
  let lo = 1;
  let hi = k;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (cdf[mid] < u) lo = mid + 1;
    else hi = mid;
  }
  const degree = Math.min(lo, k);

  if (degree === 1) return [Math.floor(random() * k) % k];

  // Rejection sampling is fine while the degree is a small fraction of k; once
  // it approaches k the coupon-collector tail makes a partial shuffle cheaper.
  if (degree * 2 <= k) {
    const chosen = new Set();
    while (chosen.size < degree) chosen.add(Math.floor(random() * k) % k);
    return [...chosen];
  }

  const pool = new Int32Array(k);
  for (let i = 0; i < k; i++) pool[i] = i;
  for (let i = 0; i < degree; i++) {
    const j = i + (Math.floor(random() * (k - i)) % (k - i));
    const tmp = pool[i];
    pool[i] = pool[j];
    pool[j] = tmp;
  }
  return Array.from(pool.subarray(0, degree));
}

/** XOR `source` into `target` in place. */
function xorInto(target, source) {
  for (let i = 0; i < target.length; i++) target[i] ^= source[i];
}

/**
 * Produces an endless stream of coded packets from a fixed payload.
 */
export class LtEncoder {
  /**
   * @param {Uint8Array} payload
   * @param {number} blockSize bytes per source block
   */
  constructor(payload, blockSize) {
    if (blockSize < 1) throw new RangeError('blockSize must be at least 1');
    this.payload = payload;
    this.blockSize = blockSize;
    this.k = Math.max(1, Math.ceil(payload.length / blockSize));

    // The tail block is zero-padded so every packet is exactly blockSize bytes;
    // the receiver truncates using the length carried in the manifest.
    this.blocks = [];
    for (let i = 0; i < this.k; i++) {
      const block = new Uint8Array(blockSize);
      block.set(payload.subarray(i * blockSize, Math.min((i + 1) * blockSize, payload.length)));
      this.blocks.push(block);
    }
  }

  /** Build the packet for a given seed. */
  packet(seed) {
    const indices = blocksForSeed(seed, this.k);
    const out = new Uint8Array(this.blockSize);
    if (indices.length > 0) out.set(this.blocks[indices[0]]);
    for (let i = 1; i < indices.length; i++) xorInto(out, this.blocks[indices[i]]);
    return out;
  }
}

/**
 * Collects coded packets and peels them back into the original blocks.
 *
 * The decoder keeps every packet it cannot yet resolve, indexed by the blocks
 * it still depends on. Whenever a block becomes known, every packet waiting on
 * it is reduced; any that drops to a single unknown yields another block, and
 * the cascade continues. This is belief propagation on the code's bipartite
 * graph, and it is why the receiver never has to ask for anything.
 */
export class LtDecoder {
  /**
   * @param {number} k number of source blocks
   * @param {number} blockSize bytes per block
   */
  constructor(k, blockSize) {
    this.k = k;
    this.blockSize = blockSize;
    this.blocks = new Array(k).fill(null);
    this.recovered = 0;
    /** Packets that still depend on more than one unknown block. */
    this.pending = new Map();
    /** blockIndex -> set of pending packet ids waiting on it. */
    this.waiting = new Map();
    this.seen = new Set();
    this.received = 0;
    this.nextId = 1;
  }

  get complete() {
    return this.recovered >= this.k;
  }

  /** Fraction of the payload recovered so far, 0..1. */
  get progress() {
    return this.k === 0 ? 1 : this.recovered / this.k;
  }

  /**
   * Coding overhead so far: 1.0 means no wasted frames, 1.3 means 30% more
   * packets were needed than there are source blocks.
   */
  get overhead() {
    return this.k === 0 ? 1 : this.received / this.k;
  }

  /** Which source blocks are known, for progress visualisation. */
  recoveredMask() {
    const mask = new Uint8Array(this.k);
    for (let i = 0; i < this.k; i++) mask[i] = this.blocks[i] ? 1 : 0;
    return mask;
  }

  /**
   * Feed in a received packet.
   *
   * @param {number} seed packet identifier
   * @param {Uint8Array} payload exactly `blockSize` bytes
   * @returns {boolean} true if this packet advanced the decode
   */
  addPacket(seed, payload) {
    if (this.complete) return false;
    if (this.seen.has(seed)) return false; // a repeat of a frame already scanned
    this.seen.add(seed);
    this.received++;

    const data = payload.slice(0, this.blockSize);
    const missing = new Set();
    for (const index of blocksForSeed(seed, this.k)) {
      const known = this.blocks[index];
      if (known) xorInto(data, known);
      else if (missing.has(index)) missing.delete(index); // XORed with itself
      else missing.add(index);
    }

    if (missing.size === 0) return false; // carried nothing new

    if (missing.size > 1) {
      const id = this.nextId++;
      this.pending.set(id, { data, missing });
      for (const index of missing) {
        let set = this.waiting.get(index);
        if (!set) this.waiting.set(index, (set = new Set()));
        set.add(id);
      }
      return true;
    }

    // Degree one: this packet *is* a source block. Solving it may free others.
    const queue = [];
    this.#solve(missing.values().next().value, data, queue);
    while (queue.length > 0 && !this.complete) this.#propagate(queue.pop(), queue);
    return true;
  }

  #solve(index, data, queue) {
    if (this.blocks[index]) return;
    this.blocks[index] = data;
    this.recovered++;
    queue.push(index);
  }

  /** Reduce every pending packet that was waiting on a newly solved block. */
  #propagate(index, queue) {
    const dependents = this.waiting.get(index);
    if (!dependents) return;
    this.waiting.delete(index);
    const solved = this.blocks[index];

    for (const id of dependents) {
      const packet = this.pending.get(id);
      if (!packet) continue;
      xorInto(packet.data, solved);
      packet.missing.delete(index);

      if (packet.missing.size === 1) {
        const remaining = packet.missing.values().next().value;
        this.pending.delete(id);
        const others = this.waiting.get(remaining);
        if (others) others.delete(id);
        this.#solve(remaining, packet.data, queue);
      } else if (packet.missing.size === 0) {
        this.pending.delete(id); // fully redundant now
      }
    }
  }

  /**
   * Concatenate the recovered blocks.
   *
   * @param {number} [length] truncate to this many bytes
   */
  assemble(length) {
    if (!this.complete) throw new Error('decode is not complete');
    const total = length ?? this.k * this.blockSize;
    const out = new Uint8Array(total);
    for (let i = 0; i < this.k; i++) {
      const offset = i * this.blockSize;
      if (offset >= total) break;
      const block = this.blocks[i];
      out.set(block.subarray(0, Math.min(this.blockSize, total - offset)), offset);
    }
    return out;
  }
}
