/**
 * A small deterministic PRNG shared by the fountain encoder and decoder.
 *
 * Both ends must derive the exact same block selection from a 32-bit seed, so
 * this has to be reproducible across browsers and Node. mulberry32 uses only
 * `Math.imul` and unsigned shifts -- integer operations with exactly defined
 * results -- and the final division by 2^32 is exact in IEEE-754. No engine is
 * free to disagree.
 */

/** @returns {() => number} a generator of floats in [0, 1). */
export function mulberry32(seed) {
  let state = seed >>> 0;
  return function next() {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Mix a 32-bit value so that adjacent seeds produce unrelated streams. */
export function scramble(value) {
  let x = value >>> 0;
  x ^= x >>> 16;
  x = Math.imul(x, 0x21f0aaad);
  x ^= x >>> 15;
  x = Math.imul(x, 0x735a2d97);
  x ^= x >>> 15;
  return x >>> 0;
}

/** A non-deterministic 32-bit value, used to pick stream identifiers. */
export function randomSeed() {
  const buffer = new Uint32Array(1);
  if (typeof crypto !== 'undefined' && crypto.getRandomValues) {
    crypto.getRandomValues(buffer);
    return buffer[0] >>> 0;
  }
  return Math.floor(Math.random() * 4294967296) >>> 0;
}
