/** Sender page: turn a payload into a live stream of QR frames. */

import { createTransmission } from '../core/transmit.js';
import { BLOCK_OVERHEAD } from '../core/protocol.js';
import { encodeBytes, toMatrix, byteCapacity } from '../qr/encoder.js';
import { formatBytes, formatDuration, utf8Encode } from '../core/bytes.js';
import { FramePump, QrPainter } from './render.js';
import { collectRefs, initTheme, markCurrentPage, setText, showMessage } from './common.js';

const refs = collectRefs();
const painter = new QrPainter(refs.qrCanvas);

/** @type {import('../core/transmit.js').Transmission|null} */
let transmission = null;
/** @type {{name: string, mime: string, bytes: Uint8Array}|null} */
let selectedFile = null;
let mode = 'text';
let startedAt = 0;
let paused = false;

const pump = new FramePump(renderNextFrame);

initTheme();
markCurrentPage();
painter.clear();

// ---------------------------------------------------------------- input mode

function setMode(next) {
  mode = next;
  refs.tabText.setAttribute('aria-selected', String(next === 'text'));
  refs.tabFile.setAttribute('aria-selected', String(next === 'file'));
  refs.panelText.hidden = next !== 'text';
  refs.panelFile.hidden = next !== 'file';
  updatePlan();
}

refs.tabText.addEventListener('click', () => setMode('text'));
refs.tabFile.addEventListener('click', () => setMode('file'));

refs.dropzone.addEventListener('click', () => refs.fileInput.click());
refs.dropzone.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' || event.key === ' ') {
    event.preventDefault();
    refs.fileInput.click();
  }
});

for (const type of ['dragenter', 'dragover']) {
  refs.dropzone.addEventListener(type, (event) => {
    event.preventDefault();
    refs.dropzone.classList.add('dragging');
  });
}
for (const type of ['dragleave', 'drop']) {
  refs.dropzone.addEventListener(type, () => refs.dropzone.classList.remove('dragging'));
}

refs.dropzone.addEventListener('drop', (event) => {
  event.preventDefault();
  const file = event.dataTransfer?.files?.[0];
  if (file) void loadFile(file);
});

refs.fileInput.addEventListener('change', () => {
  const file = refs.fileInput.files?.[0];
  if (file) void loadFile(file);
});

refs.fileClear.addEventListener('click', () => {
  selectedFile = null;
  refs.fileInput.value = '';
  refs.fileChip.hidden = true;
  updatePlan();
});

async function loadFile(file) {
  const bytes = new Uint8Array(await file.arrayBuffer());
  selectedFile = { name: file.name, mime: file.type || 'application/octet-stream', bytes };
  setText(refs.fileName, file.name);
  setText(refs.fileSize, formatBytes(bytes.length));
  refs.fileChip.hidden = false;
  setMode('file');
  updatePlan();
}

/** The bytes that would be sent right now, given the current inputs. */
function currentPayload() {
  if (mode === 'file') {
    if (!selectedFile) return null;
    return { ...selectedFile, binary: true };
  }
  const text = refs.textInput.value;
  if (!text) return null;
  return { name: 'message.txt', mime: 'text/plain', bytes: utf8Encode(text), binary: false };
}

// ---------------------------------------------------------------- settings

function settings() {
  return {
    version: Number(refs.version.value),
    ecc: refs.ecc.value,
    fps: Number(refs.fps.value),
    compress: refs.compress.checked,
  };
}

/**
 * Update the plan readout without actually starting. Sizes here are exact for
 * everything except compression, which cannot be known without doing the work.
 */
function updatePlan() {
  const { version, ecc, fps } = settings();
  const capacity = byteCapacity(version, ecc);
  const perFrame = capacity - BLOCK_OVERHEAD;

  setText(refs.versionValue, `v${version} · ${version * 4 + 17} modules · ${perFrame} B/frame`);
  setText(refs.fpsValue, `${fps} fps`);
  setText(refs.statPerframe, `${perFrame} B`);

  const payload = currentPayload();
  if (!payload) {
    setText(refs.statPayload, '—');
    setText(refs.statWire, '—');
    setText(refs.statBlocks, '—');
    setText(refs.statBesttime, '—');
    setText(refs.statRate, '—');
    refs.start.disabled = false;
    return;
  }

  setText(refs.statPayload, formatBytes(payload.bytes.length));

  if (transmission) return; // live figures take over once running

  const blocks = Math.max(1, Math.ceil(payload.bytes.length / perFrame));
  setText(refs.statWire, '—');
  setText(refs.statBlocks, String(blocks));
  setText(refs.statBesttime, formatDuration((blocks * 1.09) / fps));
  setText(refs.statRate, `${formatBytes(Math.round(perFrame * fps))}/s`);
}

for (const control of [refs.version, refs.fps, refs.ecc, refs.compress]) {
  control.addEventListener('input', () => {
    updatePlan();
    if (transmission) {
      // Density and error correction change the frame layout, so the stream has
      // to be rebuilt; frame rate can be adjusted without interrupting it.
      if (control === refs.fps) pump.setFps(Number(refs.fps.value));
      else void restart();
    }
  });
}

refs.textInput.addEventListener('input', updatePlan);

// ---------------------------------------------------------------- streaming

async function start() {
  const payload = currentPayload();
  if (!payload) {
    showMessage(refs.message, 'Add some text or choose a file first.', 'error');
    return;
  }

  const { version, ecc, fps, compress } = settings();
  showMessage(refs.message, '');

  try {
    transmission = await createTransmission({
      data: payload.bytes,
      name: payload.name,
      mime: payload.mime,
      binary: payload.binary,
      version,
      ecc,
      compress,
    });
  } catch (error) {
    showMessage(refs.message, error.message, 'error');
    return;
  }

  startedAt = performance.now();
  paused = false;

  refs.qrFrame.classList.remove('idle');
  refs.start.disabled = true;
  refs.pause.disabled = false;
  refs.stop.disabled = false;
  refs.fullscreen.disabled = false;
  setText(refs.pause, 'Pause');

  setText(refs.statWire, formatBytes(transmission.payloadLength));
  setText(refs.statBlocks, String(transmission.blockCount));
  // The planned figure assumed the requested density; report what is actually
  // going out, which differs when a small payload shrinks the symbol.
  setText(refs.statPerframe, `${transmission.blockSize} B`);
  setText(refs.statBesttime, formatDuration(transmission.minimumFrames / fps));
  setText(
    refs.statRate,
    `${formatBytes(Math.round(transmission.blockSize * fps))}/s`,
  );

  const blocks = `${transmission.blockCount} ${transmission.blockCount === 1 ? 'block' : 'blocks'}`;
  const stream = transmission.manifest.streamId.toString(16).padStart(4, '0').toUpperCase();
  const shrunk =
    transmission.version < version ? ` · shrunk to v${transmission.version} for an easier scan` : '';
  setText(
    refs.caption,
    transmission.manifest.compressed
      ? `Compressed to ${Math.max(1, Math.round(transmission.compressionRatio * 100))}% — ` +
          `${blocks} to send · stream ${stream}${shrunk}`
      : `${blocks} to send · stream ${stream}${shrunk}`,
  );

  pump.start(fps);
  updatePhase();
}

async function restart() {
  const wasRunning = Boolean(transmission);
  stop();
  if (wasRunning) await start();
}

function stop() {
  pump.stop();
  transmission = null;
  paused = false;
  refs.qrFrame.classList.add('idle');
  refs.start.disabled = false;
  refs.pause.disabled = true;
  refs.stop.disabled = true;
  refs.fullscreen.disabled = true;
  setText(refs.statFrames, '0');
  setText(refs.statFps, '0.0');
  setText(refs.statElapsed, '0s');
  setText(refs.statPasses, '0');
  setText(refs.caption, 'Configure a payload, then start the stream.');
  painter.clear();
  updatePhase();
  updatePlan();
}

function togglePause() {
  if (!transmission) return;
  paused = !paused;
  if (paused) pump.stop();
  else pump.start(Number(refs.fps.value));
  setText(refs.pause, paused ? 'Resume' : 'Pause');
  updatePhase();
}

/** Encode and display one frame. Called by the pump at the target rate. */
function renderNextFrame() {
  if (!transmission) return;

  const frame = transmission.next();
  let symbol;
  try {
    symbol = encodeBytes(frame.bytes, {
      ecc: transmission.ecc,
      minVersion: transmission.version,
      maxVersion: transmission.version,
    });
  } catch (error) {
    showMessage(refs.message, `Could not encode a frame: ${error.message}`, 'error');
    stop();
    return;
  }

  painter.draw(toMatrix(symbol, 4));

  setText(refs.statFrames, String(transmission.framesSent));
  setText(refs.statFps, pump.measuredFps.toFixed(1));
  setText(refs.statElapsed, formatDuration((performance.now() - startedAt) / 1000));
  setText(refs.statPasses, String(Math.floor(transmission.position / transmission.blockCount)));
  updatePhase();
}

function updatePhase() {
  if (!transmission) {
    refs.phase.className = 'badge';
    refs.phase.innerHTML = '<span class="dot"></span> Idle';
    return;
  }
  if (paused) {
    refs.phase.className = 'badge warn';
    refs.phase.innerHTML = '<span class="dot"></span> Paused';
    return;
  }
  const systematic = !transmission.systematicPassComplete;
  refs.phase.className = systematic ? 'badge live' : 'badge good';
  refs.phase.innerHTML = systematic
    ? '<span class="dot"></span> First pass'
    : '<span class="dot"></span> Fountain';
}

refs.start.addEventListener('click', () => void start());
refs.pause.addEventListener('click', togglePause);
refs.stop.addEventListener('click', stop);

refs.fullscreen.addEventListener('click', () => {
  if (document.fullscreenElement) document.exitFullscreen();
  else refs.qrFrame.requestFullscreen?.().catch(() => {});
});

// Re-render immediately after a fullscreen change so the symbol is resized to
// the new canvas rather than waiting for the next scheduled frame.
document.addEventListener('fullscreenchange', () => {
  if (transmission && !paused) renderNextFrame();
});

document.addEventListener('keydown', (event) => {
  if (event.target instanceof HTMLTextAreaElement || event.target instanceof HTMLInputElement) return;
  if (event.key === ' ') {
    event.preventDefault();
    if (transmission) togglePause();
    else void start();
  } else if (event.key === 'f' || event.key === 'F') {
    if (!refs.fullscreen.disabled) refs.fullscreen.click();
  } else if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
    event.preventDefault();
    const delta = event.key === 'ArrowUp' ? 1 : -1;
    refs.fps.value = String(Math.max(1, Math.min(30, Number(refs.fps.value) + delta)));
    refs.fps.dispatchEvent(new Event('input'));
  }
});

updatePlan();
