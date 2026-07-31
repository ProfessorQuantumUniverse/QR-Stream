/**
 * Loopback Lab: a full transfer with the camera replaced by a simulated channel.
 *
 * Everything except the optics is real. Frames are encoded by the same encoder
 * the sender uses, rasterised to actual pixels, and decoded by the same scanner
 * the receiver uses. Only the channel is synthetic, which is what makes it
 * useful: you can dial the loss rate to 90% and watch a fountain code shrug.
 */

import { createTransmission } from '../core/transmit.js';
import { ReceiverSession } from '../core/receive.js';
import { encodeBytes, toMatrix } from '../qr/encoder.js';
import { formatBytes, formatDuration, utf8Encode } from '../core/bytes.js';
import { QrPainter } from './render.js';
import {
  blockMap,
  collectRefs,
  initTheme,
  markCurrentPage,
  progressRing,
  setText,
  showMessage,
} from './common.js';

const refs = collectRefs();
const painter = new QrPainter(refs.qrCanvas);
const ring = progressRing(refs.ring, { size: 132 });
const map = blockMap(refs.blockMap);

/** Offscreen surface the QR is rasterised onto before being handed to the scanner. */
const channel = document.createElement('canvas');
const channelContext = channel.getContext('2d', { alpha: false, willReadFrequently: true });
/** One module per pixel, upscaled into `channel`. */
const modules = document.createElement('canvas');
const modulesContext = modules.getContext('2d', { alpha: false });

let running = false;
let chosenFile = null;
const counters = { sent: 0, dropped: 0, decoded: 0, unreadable: 0 };

initTheme();
markCurrentPage();
ring.set(0, 'idle');
painter.clear();

const SAMPLE = `QR-Stream moves data between machines that have no network in common.
The sender paints an endless sequence of QR codes; the receiver films them and
rebuilds the payload from whatever it happened to catch. There is no handshake,
no acknowledgement, and no retransmission request, because light only travels
one way across an air gap. `;

function sampleText(targetBytes) {
  let text = '';
  while (text.length < targetBytes) text += SAMPLE;
  return text.slice(0, targetBytes);
}

function randomBytes(length) {
  const out = new Uint8Array(length);
  // Chunked because getRandomValues refuses more than 64 kB at a time.
  for (let offset = 0; offset < length; offset += 65536) {
    crypto.getRandomValues(out.subarray(offset, Math.min(offset + 65536, length)));
  }
  return out;
}

async function resolvePayload() {
  const choice = refs.payload.value;
  switch (choice) {
    case 'text-small':
      return { bytes: utf8Encode(sampleText(2048)), name: 'sample.txt', binary: false };
    case 'text-large':
      return { bytes: utf8Encode(sampleText(40960)), name: 'sample.txt', binary: false };
    case 'random-8':
      return { bytes: randomBytes(8192), name: 'random.bin', binary: true };
    case 'random-64':
      return { bytes: randomBytes(65536), name: 'random.bin', binary: true };
    case 'file':
      if (!chosenFile) return null;
      return { bytes: chosenFile.bytes, name: chosenFile.name, binary: true };
    default:
      return null;
  }
}

refs.payload.addEventListener('change', () => {
  if (refs.payload.value === 'file') refs.fileInput.click();
  else refs.fileChip.hidden = true;
});

refs.fileInput.addEventListener('change', async () => {
  const file = refs.fileInput.files?.[0];
  if (!file) return;
  chosenFile = { name: file.name, bytes: new Uint8Array(await file.arrayBuffer()) };
  setText(refs.fileName, file.name);
  setText(refs.fileSize, formatBytes(chosenFile.bytes.length));
  refs.fileChip.hidden = false;
});

refs.loss.addEventListener('input', () => setText(refs.lossValue, `${refs.loss.value}%`));
refs.version.addEventListener('input', () => setText(refs.versionValue, `v${refs.version.value}`));

// --------------------------------------------------------------------- run

refs.run.addEventListener('click', () => void run());
refs.cancel.addEventListener('click', () => {
  running = false;
});

async function run() {
  if (running) return;

  const payload = await resolvePayload();
  if (!payload) {
    showMessage(refs.message, 'Choose a file first.', 'error');
    return;
  }

  showMessage(refs.message, '');
  refs.verdict.hidden = true;
  refs.qrFrame.classList.remove('idle');
  refs.run.disabled = true;
  refs.cancel.disabled = false;
  running = true;

  for (const key of Object.keys(counters)) counters[key] = 0;

  const version = Number(refs.version.value);
  const ecc = refs.ecc.value;
  const lossRate = Number(refs.loss.value) / 100;
  const throttleFps = Number(refs.speed.value);
  const softening = refs.blur.checked;

  let transmission;
  try {
    transmission = await createTransmission({
      data: payload.bytes,
      name: payload.name,
      binary: payload.binary,
      version,
      ecc,
    });
  } catch (error) {
    showMessage(refs.message, error.message, 'error');
    finish();
    return;
  }

  const session = new ReceiverSession();
  map.reset(transmission.blockCount);
  setText(refs.statBlocks, `0 / ${transmission.blockCount}`);
  setPhase('live', 'Running');

  const started = performance.now();
  const frameBudgetMs = throttleFps > 0 ? 1000 / throttleFps : 0;
  let lastFrame = 0;

  // The loop yields to the browser between frames so the page stays responsive
  // and the QR canvas actually repaints; a tight synchronous loop would finish
  // faster but show nothing.
  while (running && !session.ready) {
    const now = performance.now();
    if (frameBudgetMs && now - lastFrame < frameBudgetMs) {
      await nextTick();
      continue;
    }
    lastFrame = now;

    const frame = transmission.next();
    counters.sent++;

    const symbol = encodeBytes(frame.bytes, {
      ecc,
      minVersion: version,
      maxVersion: version,
    });
    const matrix = toMatrix(symbol, 4);
    painter.draw(matrix, 256);

    if (Math.random() < lossRate) {
      counters.dropped++;
    } else {
      const scanned = scan(matrix, softening);
      if (scanned) {
        counters.decoded++;
        session.ingest(Uint8Array.from(scanned));
      } else {
        counters.unreadable++;
      }
    }

    updateStats(session, started);

    if (counters.sent > transmission.blockCount * 400 + 2000) {
      showMessage(refs.message, 'Gave up: the channel is too degraded to converge.', 'error');
      break;
    }

    await nextTick();
  }

  const elapsed = (performance.now() - started) / 1000;

  if (session.ready) {
    try {
      const result = await session.result();
      const identical =
        result.bytes.length === payload.bytes.length &&
        result.bytes.every((byte, i) => byte === payload.bytes[i]);

      refs.verdict.hidden = false;
      refs.verdict.className = identical ? 'message ok' : 'message error';
      refs.verdict.textContent = identical
        ? `Recovered ${formatBytes(result.bytes.length)} byte-for-byte in ${formatDuration(elapsed)}, ` +
          `after losing ${counters.dropped} of ${counters.sent} frames. ` +
          `Coding overhead ${session.decoder.overhead.toFixed(2)}×, CRC verified.`
        : 'Reassembled payload does not match the original — this is a bug, please report it.';
      setPhase(identical ? 'good' : 'bad', identical ? 'Complete' : 'Mismatch');
    } catch (error) {
      showMessage(refs.message, error.message, 'error');
      setPhase('bad', 'Failed');
    }
  } else {
    setPhase('warn', running ? 'Gave up' : 'Stopped');
  }

  finish();
}

/** Rasterise a matrix to pixels and read it back through the real scanner. */
function scan(matrix, soften) {
  const scale = 4;
  const size = matrix.side * scale;
  if (channel.width !== size) {
    channel.width = size;
    channel.height = size;
  }

  if (modules.width !== matrix.side) {
    modules.width = matrix.side;
    modules.height = matrix.side;
  }

  const image = modulesContext.createImageData(matrix.side, matrix.side);
  for (let i = 0, p = 0; i < matrix.data.length; i++, p += 4) {
    const value = matrix.data[i] ? 0 : 255;
    image.data[p] = value;
    image.data[p + 1] = value;
    image.data[p + 2] = value;
    image.data[p + 3] = 255;
  }
  modulesContext.putImageData(image, 0, 0);

  // Scale up with nearest-neighbour so module edges stay hard -- interpolating
  // here would blur every boundary and defeat the scanner before the simulated
  // channel gets a chance to. Softening, when asked for, is applied afterwards
  // as an explicit blur, which is what a real lens does.
  channelContext.imageSmoothingEnabled = false;
  channelContext.filter = soften ? 'blur(1px)' : 'none';
  channelContext.drawImage(modules, 0, 0, size, size);
  channelContext.filter = 'none';

  const pixels = channelContext.getImageData(0, 0, size, size);
  const found = window.jsQR(pixels.data, size, size, { inversionAttempts: 'dontInvert' });
  return found ? found.binaryData : null;
}

function nextTick() {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}

function updateStats(session, started) {
  setText(refs.statSent, String(counters.sent));
  setText(refs.statDropped, String(counters.dropped));
  setText(refs.statDecoded, String(counters.decoded));
  setText(refs.statUnreadable, String(counters.unreadable));

  const elapsed = (performance.now() - started) / 1000;
  setText(refs.statElapsed, formatDuration(elapsed));

  if (!session.decoder) return;
  ring.set(session.progress, `${session.recoveredBlocks}/${session.blockCount}`);
  map.update(session.recoveredMask());
  setText(refs.statBlocks, `${session.recoveredBlocks} / ${session.blockCount}`);
  setText(refs.statOverhead, `${session.decoder.overhead.toFixed(2)}×`);

  const bytes = session.recoveredBlocks * session.blockSize;
  setText(refs.statGoodput, elapsed > 0 ? `${formatBytes(Math.round(bytes / elapsed))}/s` : '—');
}

function setPhase(kind, label) {
  refs.phase.className = `badge ${kind}`.trim();
  refs.phase.innerHTML = `<span class="dot"></span> ${label}`;
}

function finish() {
  running = false;
  refs.run.disabled = false;
  refs.cancel.disabled = true;
}
