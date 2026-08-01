/**
 * Loads the vendored jsQR bundle for use from Node tests.
 *
 * The vendored file is a UMD bundle meant for the browser, and this package is
 * ESM, so Node will not import it directly. Evaluating it in a synthetic CommonJS
 * scope gets us the decoder without keeping a second copy of it around.
 */
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('../../src/vendor/jsqr.js', import.meta.url), 'utf8');
const shim = { exports: {} };
// eslint-disable-next-line no-new-func
new Function('module', 'exports', source)(shim, shim.exports);

/** @type {(data: Uint8ClampedArray, width: number, height: number, options?: object) => any} */
const jsQR = shim.exports;
export default jsQR;

/**
 * Rasterise a QR matrix into the RGBA buffer jsQR expects. Scaling each module
 * up to several pixels mirrors what a camera would see and gives the locator
 * enough to work with.
 */
export function rasterise(matrix, scale = 3) {
  const { side, data } = matrix;
  const width = side * scale;
  const rgba = new Uint8ClampedArray(width * width * 4);
  for (let y = 0; y < width; y++) {
    const row = Math.floor(y / scale);
    for (let x = 0; x < width; x++) {
      const dark = data[row * side + Math.floor(x / scale)];
      const value = dark ? 0 : 255;
      const i = (y * width + x) * 4;
      rgba[i] = value;
      rgba[i + 1] = value;
      rgba[i + 2] = value;
      rgba[i + 3] = 255;
    }
  }
  return { data: rgba, width, height: width };
}
