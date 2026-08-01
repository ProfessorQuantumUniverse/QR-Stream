/** Receiver page: camera capture, QR decoding, and stream reassembly. */

import { ReceiverSession } from '../core/receive.js';
import { formatBytes, formatDuration } from '../core/bytes.js';
import {
  blockMap,
  collectRefs,
  downloadBytes,
  initTheme,
  markCurrentPage,
  progressRing,
  setText,
  showMessage,
} from './common.js';

const refs = collectRefs();
const ring = progressRing(refs.ring);
const map = blockMap(refs.blockMap);
const session = new ReceiverSession();

const scratch = document.createElement('canvas');
const scratchContext = scratch.getContext('2d', { alpha: false, willReadFrequently: true });
const overlayContext = refs.overlay.getContext('2d');

/** @type {MediaStream|null} */
let stream = null;
/** @type {MediaStreamTrack|null} */
let track = null;
let scanning = false;
let scanPending = false;
let rafHandle = 0;
let torchOn = false;

/** Rolling scanner telemetry, for the readout. */
let scanTimes = [];
let decodeMs = 0;
let lastHit = 0;
let finished = false;

initTheme();
markCurrentPage();
ring.set(0, 'waiting');

// ------------------------------------------------------------------ camera

async function listCameras() {
  if (!navigator.mediaDevices?.enumerateDevices) return;
  const devices = await navigator.mediaDevices.enumerateDevices();
  const cameras = devices.filter((device) => device.kind === 'videoinput');
  if (cameras.length < 2) return;

  const selected = refs.camera.value;
  refs.camera.innerHTML = '<option value="">Default (rear)</option>';
  cameras.forEach((camera, index) => {
    const option = document.createElement('option');
    option.value = camera.deviceId;
    option.textContent = camera.label || `Camera ${index + 1}`;
    refs.camera.append(option);
  });
  refs.camera.value = selected;
}

async function startCamera() {
  showMessage(refs.message, '');

  if (!navigator.mediaDevices?.getUserMedia) {
    showMessage(
      refs.message,
      'This browser will not expose a camera here. Camera access needs a secure context: ' +
        'serve the page over HTTPS, or open it from localhost.',
      'error',
    );
    return;
  }

  const deviceId = refs.camera.value;
  const constraints = {
    video: deviceId
      ? { deviceId: { exact: deviceId }, width: { ideal: 1920 }, height: { ideal: 1080 } }
      : { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 } },
    audio: false,
  };

  try {
    stream = await navigator.mediaDevices.getUserMedia(constraints);
  } catch (error) {
    showMessage(refs.message, describeCameraError(error), 'error');
    return;
  }

  refs.video.srcObject = stream;
  await refs.video.play().catch(() => {});
  track = stream.getVideoTracks()[0] ?? null;

  refs.placeholder.hidden = true;
  refs.start.disabled = true;
  refs.stop.disabled = false;
  refs.reset.disabled = false;
  setStatus('live', 'Scanning');

  await listCameras();
  setUpTrackControls();

  scanning = true;
  scanTimes = [];
  scheduleScan();
}

/** Expose torch and zoom only when the hardware actually offers them. */
function setUpTrackControls() {
  if (!track?.getCapabilities) return;
  let capabilities = {};
  try {
    capabilities = track.getCapabilities();
  } catch {
    return;
  }

  refs.torch.hidden = !('torch' in capabilities);
  torchOn = false;
  setText(refs.torch, '🔦 Torch');

  if (capabilities.zoom) {
    refs.zoomField.hidden = false;
    refs.zoom.min = String(capabilities.zoom.min ?? 1);
    refs.zoom.max = String(capabilities.zoom.max ?? 4);
    refs.zoom.step = String(capabilities.zoom.step || 0.1);
    refs.zoom.value = String(track.getSettings().zoom ?? capabilities.zoom.min ?? 1);
    setText(refs.zoomValue, `${Number(refs.zoom.value).toFixed(1)}×`);
  } else {
    refs.zoomField.hidden = true;
  }
}

function describeCameraError(error) {
  switch (error?.name) {
    case 'NotAllowedError':
      return 'Camera permission was denied. Allow it in the address bar, then start again.';
    case 'NotFoundError':
      return 'No camera was found on this device.';
    case 'NotReadableError':
      return 'The camera is already in use by another application.';
    case 'OverconstrainedError':
      return 'That camera cannot provide a usable video mode. Try a different one.';
    default:
      return `Could not open the camera: ${error?.message || error}`;
  }
}

function stopCamera() {
  scanning = false;
  scanPending = false;
  if (rafHandle) cancelAnimationFrame(rafHandle);
  rafHandle = 0;
  for (const t of stream?.getTracks() ?? []) t.stop();
  stream = null;
  track = null;
  refs.video.srcObject = null;
  refs.placeholder.hidden = false;
  refs.torch.hidden = true;
  refs.zoomField.hidden = true;
  refs.start.disabled = false;
  refs.stop.disabled = true;
  overlayContext.clearRect(0, 0, refs.overlay.width, refs.overlay.height);
  setStatus('', 'Stopped');
}

refs.start.addEventListener('click', () => void startCamera());
refs.stop.addEventListener('click', stopCamera);

refs.camera.addEventListener('change', () => {
  if (!stream) return;
  stopCamera();
  void startCamera();
});

refs.torch.addEventListener('click', async () => {
  if (!track) return;
  torchOn = !torchOn;
  try {
    await track.applyConstraints({ advanced: [{ torch: torchOn }] });
    setText(refs.torch, torchOn ? '🔦 Torch on' : '🔦 Torch');
  } catch {
    showMessage(refs.message, 'This camera would not switch its light on.', 'error');
    torchOn = false;
  }
});

refs.zoom.addEventListener('input', async () => {
  setText(refs.zoomValue, `${Number(refs.zoom.value).toFixed(1)}×`);
  try {
    await track?.applyConstraints({ advanced: [{ zoom: Number(refs.zoom.value) }] });
  } catch {
    /* the camera declined; the slider position is harmless */
  }
});

// ------------------------------------------------------------------ scanning

/**
 * Prefer `requestVideoFrameCallback`, which fires once per decoded video frame:
 * scanning the same frame twice is pure waste, and scanning on a timer means
 * either missing frames or burning CPU on repeats.
 */
function scheduleScan() {
  // Guard against two scan loops running at once: a callback registered before
  // the tab was hidden is still pending when it becomes visible again.
  if (!scanning || scanPending) return;
  scanPending = true;
  const run = () => {
    scanPending = false;
    scanFrame();
  };
  if (refs.video.requestVideoFrameCallback) {
    refs.video.requestVideoFrameCallback(run);
  } else {
    rafHandle = requestAnimationFrame(run);
  }
}

function scanFrame() {
  if (!scanning) return;

  const width = refs.video.videoWidth;
  const height = refs.video.videoHeight;
  if (!width || !height) {
    scheduleScan();
    return;
  }

  // Downscale to the configured working resolution. Decode cost grows with
  // pixel count, and past a certain point the extra pixels buy nothing.
  const target = Number(refs.detail.value);
  const scale = Math.min(1, target / Math.max(width, height));
  const w = Math.max(1, Math.round(width * scale));
  const h = Math.max(1, Math.round(height * scale));

  if (scratch.width !== w || scratch.height !== h) {
    scratch.width = w;
    scratch.height = h;
  }

  scratchContext.drawImage(refs.video, 0, 0, w, h);
  const image = scratchContext.getImageData(0, 0, w, h);

  const began = performance.now();
  // We always render black on white, so there is no point paying for the
  // inverted pass.
  const found = window.jsQR(image.data, w, h, { inversionAttempts: 'dontInvert' });
  decodeMs = decodeMs ? decodeMs * 0.8 + (performance.now() - began) * 0.2 : performance.now() - began;

  const now = performance.now();
  scanTimes.push(now);
  while (scanTimes.length > 2 && now - scanTimes[0] > 3000) scanTimes.shift();

  if (found) {
    lastHit = now;
    drawOverlay(found.location, w, h);
    handleDecoded(found.binaryData);
  } else if (now - lastHit > 250) {
    overlayContext.clearRect(0, 0, refs.overlay.width, refs.overlay.height);
  }

  updateScannerStats();
  scheduleScan();
}

function handleDecoded(binaryData) {
  if (finished || !binaryData) return;

  const before = session.streamId;
  const outcome = session.ingest(Uint8Array.from(binaryData));

  if (outcome.status === 'ignored') return;

  if (session.streamId !== before || outcome.streamStarted) {
    map.reset(session.blockCount || 0);
    showMessage(refs.message, '');
  }

  if (outcome.status === 'manifest') {
    map.reset(session.blockCount);
    const { name, binary } = outcome.manifest;
    setText(refs.incomingName, name || (binary ? 'unnamed file' : 'text message'));
    setText(refs.statBlocks, `${session.recoveredBlocks} / ${session.blockCount}`);
  }

  if (session.decoder && refs.blockMap.childElementCount !== session.blockCount) {
    map.reset(session.blockCount);
  }

  updateReceptionStats();

  if (session.ready) void finish();
}

function drawOverlay(location, sourceWidth, sourceHeight) {
  const rect = refs.viewport.getBoundingClientRect();
  if (refs.overlay.width !== Math.round(rect.width) || refs.overlay.height !== Math.round(rect.height)) {
    refs.overlay.width = Math.round(rect.width);
    refs.overlay.height = Math.round(rect.height);
  }

  // The video is drawn with object-fit: cover, so replicate that mapping.
  const scale = Math.max(refs.overlay.width / sourceWidth, refs.overlay.height / sourceHeight);
  const offsetX = (refs.overlay.width - sourceWidth * scale) / 2;
  const offsetY = (refs.overlay.height - sourceHeight * scale) / 2;
  const project = (point) => [point.x * scale + offsetX, point.y * scale + offsetY];

  const corners = [
    location.topLeftCorner,
    location.topRightCorner,
    location.bottomRightCorner,
    location.bottomLeftCorner,
  ].map(project);

  overlayContext.clearRect(0, 0, refs.overlay.width, refs.overlay.height);
  overlayContext.beginPath();
  overlayContext.moveTo(corners[0][0], corners[0][1]);
  for (const [x, y] of corners.slice(1)) overlayContext.lineTo(x, y);
  overlayContext.closePath();

  const style = getComputedStyle(document.documentElement);
  overlayContext.strokeStyle = style.getPropertyValue('--accent').trim() || '#22d3ee';
  overlayContext.lineWidth = 3;
  overlayContext.lineJoin = 'round';
  overlayContext.stroke();
  overlayContext.fillStyle = 'rgba(34, 211, 238, 0.10)';
  overlayContext.fill();
}

// ------------------------------------------------------------------ readouts

function updateScannerStats() {
  const span = scanTimes.length > 1 ? scanTimes[scanTimes.length - 1] - scanTimes[0] : 0;
  const rate = span > 0 ? ((scanTimes.length - 1) * 1000) / span : 0;
  setText(refs.statScanrate, rate.toFixed(1));
  refs.statDecode.innerHTML = `${decodeMs.toFixed(0)} <small>ms</small>`;
  setText(refs.statSeen, String(session.framesSeen));
  setText(refs.statDupes, String(session.duplicateFrames));
}

function updateReceptionStats() {
  if (!session.decoder) return;
  const { recoveredBlocks, blockCount } = session;

  ring.set(session.progress, `${recoveredBlocks}/${blockCount}`);
  map.update(session.recoveredMask());
  setText(refs.statBlocks, `${recoveredBlocks} / ${blockCount}`);

  const rate = session.bytesPerSecond;
  setText(refs.statThroughput, rate > 0 ? `${formatBytes(Math.round(rate))}/s` : '—');

  const remaining = session.secondsRemaining;
  setText(refs.statEta, remaining === null ? '—' : formatDuration(remaining));

  const overhead = session.decoder.overhead;
  setText(refs.statOverhead, overhead > 0 ? `${overhead.toFixed(2)}×` : '—');
}

function setStatus(kind, label) {
  refs.status.className = `badge ${kind}`.trim();
  refs.status.innerHTML = `<span class="dot"></span> ${label}`;
}

// ------------------------------------------------------------------ result

async function finish() {
  if (finished) return;
  finished = true;

  let result;
  try {
    result = await session.result();
  } catch (error) {
    finished = false;
    showMessage(refs.message, error.message, 'error');
    setStatus('bad', 'Failed');
    return;
  }

  scanning = false;
  setStatus('good', 'Complete');
  ring.set(1, 'complete');
  updateReceptionStats();

  refs.verifyBadge.hidden = !result.verified;
  refs.resultCard.hidden = false;
  setText(refs.resultName, result.name);
  setText(refs.resultSize, formatBytes(result.bytes.length));
  setText(refs.resultIcon, result.binary ? '📦' : '📝');
  setText(refs.resultTime, `in ${formatDuration(result.elapsedMs / 1000)}`);

  if (result.text !== null) {
    refs.resultText.hidden = false;
    refs.resultText.textContent =
      result.text.length > 20000 ? `${result.text.slice(0, 20000)}\n… (truncated for display)` : result.text;
    refs.copy.hidden = false;
  } else {
    refs.resultText.hidden = true;
    refs.copy.hidden = true;
  }

  refs.download.onclick = () => downloadBytes(result.bytes, result.name, result.mime);
  refs.copy.onclick = async () => {
    try {
      await navigator.clipboard.writeText(result.text ?? '');
      setText(refs.copy, 'Copied');
      setTimeout(() => setText(refs.copy, 'Copy text'), 1500);
    } catch {
      showMessage(refs.message, 'The browser blocked clipboard access.', 'error');
    }
  };

  // Keep the camera running but stop decoding; the user may want to line up
  // another transfer without re-granting permission.
  refs.resultCard.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

function resetReception() {
  session.reset();
  finished = false;
  map.reset(0);
  ring.set(0, 'waiting');
  refs.resultCard.hidden = true;
  refs.verifyBadge.hidden = true;
  setText(refs.incomingName, 'Waiting for a stream…');
  setText(refs.statBlocks, '0 / 0');
  setText(refs.statThroughput, '—');
  setText(refs.statEta, '—');
  setText(refs.statOverhead, '—');
  showMessage(refs.message, '');
  if (stream) {
    scanning = true;
    setStatus('live', 'Scanning');
    scheduleScan();
  } else {
    setStatus('', 'Stopped');
  }
}

refs.reset.addEventListener('click', resetReception);
refs.again.addEventListener('click', resetReception);

window.addEventListener('beforeunload', stopCamera);
document.addEventListener('visibilitychange', () => {
  // Resume the scan loop after the tab comes back; rVFC stops firing while hidden.
  if (!document.hidden && scanning) scheduleScan();
});
