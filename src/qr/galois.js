/**
 * Arithmetic over the Galois field GF(2^8), as used by QR code error correction.
 *
 * QR codes use the primitive polynomial x^8 + x^4 + x^3 + x^2 + 1 (0x11D) to
 * define multiplication. Every non-zero element can be written as a power of
 * the generator 2, so we precompute exp/log tables once and turn multiplication
 * into a table lookup plus an addition.
 */

const PRIMITIVE = 0x11d;

/** exp[i] = 2^i in GF(256), doubled in length so we can skip the modulo. */
const EXP = new Uint8Array(512);
/** log[x] = i such that 2^i == x. log[0] is undefined and never read. */
const LOG = new Uint8Array(256);

{
  let x = 1;
  for (let i = 0; i < 255; i++) {
    EXP[i] = x;
    LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= PRIMITIVE;
  }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
}

/** Multiply two field elements. */
export function gfMul(a, b) {
  if (a === 0 || b === 0) return 0;
  return EXP[LOG[a] + LOG[b]];
}

/**
 * Build the Reed-Solomon generator polynomial of the given degree:
 *
 *   (x - 2^0)(x - 2^1) ... (x - 2^(degree-1))
 *
 * Returned in coefficient order from the highest power down, with the implicit
 * leading 1 omitted -- the layout the remainder routine below expects.
 */
export function rsGeneratorPoly(degree) {
  if (degree < 1 || degree > 255) throw new RangeError(`unsupported RS degree ${degree}`);
  const result = new Uint8Array(degree);
  result[degree - 1] = 1;

  let root = 1;
  for (let i = 0; i < degree; i++) {
    // Multiply the accumulated polynomial by (x - root).
    for (let j = 0; j < degree; j++) {
      result[j] = gfMul(result[j], root);
      if (j + 1 < degree) result[j] ^= result[j + 1];
    }
    root = gfMul(root, 0x02);
  }
  return result;
}

/**
 * Compute the Reed-Solomon remainder (the error correction codewords) of a
 * block of data against a precomputed generator polynomial.
 */
export function rsRemainder(data, generator) {
  const result = new Uint8Array(generator.length);
  for (let i = 0; i < data.length; i++) {
    const factor = data[i] ^ result[0];
    result.copyWithin(0, 1);
    result[result.length - 1] = 0;
    if (factor !== 0) {
      for (let j = 0; j < generator.length; j++) {
        result[j] ^= gfMul(generator[j], factor);
      }
    }
  }
  return result;
}
