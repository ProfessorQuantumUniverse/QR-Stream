/**
 * Painting QR symbols onto a canvas, fast enough to do it thirty times a second.
 *
 * The naive approach -- one `fillRect` per dark module -- means tens of
 * thousands of draw calls for a dense symbol and cannot keep up. Instead the
 * matrix is written into an `ImageData` at one pixel per module and blitted to
 * a small offscreen canvas, which the browser then scales up with smoothing
 * disabled. That is a single hardware-accelerated draw call per frame, and it
 * gives exactly the hard pixel edges a scanner wants.
 */

export class QrPainter {
  /** @param {HTMLCanvasElement} canvas */
  constructor(canvas) {
    this.canvas = canvas;
    this.context = canvas.getContext('2d', { alpha: false });
    this.buffer = document.createElement('canvas');
    this.bufferContext = this.buffer.getContext('2d', { alpha: false });
    this.side = 0;
    this.image = null;
  }

  /**
   * Draw a matrix produced by `toMatrix()`.
   *
   * @param {{side: number, data: Uint8Array}} matrix
   * @param {number} [displaySize] canvas backing-store size in pixels
   */
  draw(matrix, displaySize) {
    const { side, data } = matrix;

    if (side !== this.side) {
      this.side = side;
      this.buffer.width = side;
      this.buffer.height = side;
      this.image = this.bufferContext.createImageData(side, side);
    }

    const pixels = this.image.data;
    for (let i = 0, p = 0; i < data.length; i++, p += 4) {
      const value = data[i] ? 0 : 255;
      pixels[p] = value;
      pixels[p + 1] = value;
      pixels[p + 2] = value;
      pixels[p + 3] = 255;
    }
    this.bufferContext.putImageData(this.image, 0, 0);

    // Snap the canvas to a whole multiple of the module count so that every
    // module lands on exactly the same number of device pixels. Uneven module
    // sizes are a real source of scan failures on dense symbols.
    const target = displaySize ?? this.#preferredSize();
    const scale = Math.max(1, Math.floor(target / side));
    const pixelSize = side * scale;

    if (this.canvas.width !== pixelSize) {
      this.canvas.width = pixelSize;
      this.canvas.height = pixelSize;
    }

    this.context.imageSmoothingEnabled = false;
    this.context.drawImage(this.buffer, 0, 0, pixelSize, pixelSize);
  }

  #preferredSize() {
    const rect = this.canvas.getBoundingClientRect();
    const css = Math.max(rect.width || 0, 240);
    const dpr = Math.min(window.devicePixelRatio || 1, 3);
    return Math.round(css * dpr);
  }

  clear() {
    this.context.fillStyle = '#ffffff';
    this.context.fillRect(0, 0, this.canvas.width, this.canvas.height);
  }
}

/**
 * Drives a callback at a target frame rate using `requestAnimationFrame`.
 *
 * Display refresh is not a multiple of most useful QR rates, so this ticks on
 * every animation frame and emits only when enough time has passed. Timing is
 * taken from the frame clock rather than `setInterval`, which drifts badly once
 * the encoder starts competing for the main thread.
 */
export class FramePump {
  /** @param {(elapsedMs: number) => void} onFrame */
  constructor(onFrame) {
    this.onFrame = onFrame;
    this.fps = 10;
    this.running = false;
    this.handle = 0;
    this.lastEmit = 0;
    this.emitted = 0;
    this.measuredFps = 0;
    this.previousEmit = 0;
    /** Private methods cannot be rebound, so keep a stable arrow for rAF. */
    this.tick = (now) => this.#tick(now);
  }

  start(fps) {
    if (fps) this.fps = fps;
    if (this.running) return;
    this.running = true;
    this.lastEmit = 0;
    this.previousEmit = 0;
    this.handle = requestAnimationFrame(this.tick);
  }

  stop() {
    this.running = false;
    if (this.handle) cancelAnimationFrame(this.handle);
    this.handle = 0;
    this.measuredFps = 0;
  }

  setFps(fps) {
    this.fps = Math.max(1, fps);
  }

  #tick(now) {
    if (!this.running) return;
    this.handle = requestAnimationFrame(this.tick);

    const interval = 1000 / this.fps;
    if (this.lastEmit === 0) {
      this.lastEmit = now;
    } else if (now - this.lastEmit + 0.5 < interval) {
      return;
    } else {
      // Advance by whole intervals so a slow frame does not permanently shift
      // the schedule, but never try to catch up more than one frame's worth.
      const skipped = Math.floor((now - this.lastEmit) / interval);
      this.lastEmit += Math.max(1, skipped) * interval;
      if (now - this.lastEmit > interval * 3) this.lastEmit = now;
    }

    const delta = this.previousEmit ? now - this.previousEmit : 0;
    this.previousEmit = now;
    if (delta > 0) {
      // Exponential moving average: the instantaneous value is far too jumpy
      // to read off a screen.
      const instant = 1000 / delta;
      this.measuredFps = this.measuredFps ? this.measuredFps * 0.85 + instant * 0.15 : instant;
    }

    this.emitted++;
    this.onFrame(delta);
  }
}
