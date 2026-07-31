#!/usr/bin/env node
/**
 * Drives the receiver page through a real camera.
 *
 * Everything else in the suite stops short of `getUserMedia`, which leaves the
 * one path users actually exercise untested: video track -> frame capture ->
 * downscale -> scan -> session. Chromium can be pointed at a Y4M file as a fake
 * capture device, so this renders an actual QR-Stream broadcast to video and
 * films it.
 *
 * The video loops, which is a fair model of a receiver watching a sender that
 * keeps repeating: it sees each frame more than once and must not double-count.
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { chromium } from 'playwright';

import { createTransmission } from '../../src/core/transmit.js';
import { encodeBytes, toMatrix } from '../../src/qr/encoder.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const PORT = Number(process.env.PORT ?? 8322);
const BASE = `http://localhost:${PORT}`;

const WIDTH = 800;
const HEIGHT = 600;
const FPS = 10;
/** How many video frames each QR symbol is held for. */
const HOLD = 2;

const MESSAGE =
  'BEGIN QR-STREAM CAMERA TEST\n' +
  Array.from({ length: 24 }, (_, i) => `line ${i}: ${'abcdefghijklmnopqrstuvwxyz'.slice(i % 20)}`).join(
    '\n',
  ) +
  '\nEND\n';

/** Draw a QR matrix into a full-frame luma plane, centred on white. */
function renderLuma(matrix) {
  const luma = new Uint8Array(WIDTH * HEIGHT).fill(255);
  const scale = Math.floor(Math.min(WIDTH, HEIGHT) / matrix.side);
  const size = scale * matrix.side;
  const originX = Math.floor((WIDTH - size) / 2);
  const originY = Math.floor((HEIGHT - size) / 2);

  for (let my = 0; my < matrix.side; my++) {
    for (let mx = 0; mx < matrix.side; mx++) {
      if (!matrix.data[my * matrix.side + mx]) continue;
      for (let dy = 0; dy < scale; dy++) {
        const start = (originY + my * scale + dy) * WIDTH + originX + mx * scale;
        luma.fill(0, start, start + scale);
      }
    }
  }
  return luma;
}

/** Build a Y4M clip of a broadcast. Chroma is flat grey: the image is monochrome. */
async function renderClip(path) {
  const transmission = await createTransmission({
    data: new TextEncoder().encode(MESSAGE),
    name: 'camera-test.txt',
    mime: 'text/plain',
    binary: false,
    version: 10,
    ecc: 'M',
    compress: false,
  });

  const chroma = new Uint8Array((WIDTH / 2) * (HEIGHT / 2)).fill(128);
  const parts = [
    Buffer.from(`YUV4MPEG2 W${WIDTH} H${HEIGHT} F${FPS}:1 Ip A1:1 C420mpeg2\n`, 'ascii'),
  ];

  // Enough of the stream for a full uncoded pass plus the manifests woven in.
  const frameCount = transmission.blockCount + Math.ceil(transmission.blockCount / 12) + 4;
  for (let i = 0; i < frameCount; i++) {
    const frame = transmission.next();
    const symbol = encodeBytes(frame.bytes, {
      ecc: transmission.ecc,
      minVersion: transmission.version,
      maxVersion: transmission.version,
    });
    const luma = renderLuma(toMatrix(symbol, 4));
    for (let hold = 0; hold < HOLD; hold++) {
      parts.push(Buffer.from('FRAME\n', 'ascii'), Buffer.from(luma), Buffer.from(chroma), Buffer.from(chroma));
    }
  }

  await writeFile(path, Buffer.concat(parts));
  return { transmission, frameCount };
}

async function main() {
  const workDir = await mkdtemp(join(tmpdir(), 'qrstream-camera-'));
  const clipPath = join(workDir, 'broadcast.y4m');

  console.log('\nQR-Stream camera tests\n');
  const { transmission, frameCount } = await renderClip(clipPath);
  console.log(
    `  rendered ${frameCount} frames of a ${transmission.blockCount}-block stream ` +
      `at version ${transmission.version}`,
  );

  const server = spawn(process.execPath, [resolve(root, 'tools/serve.js'), String(PORT), root], {
    stdio: 'ignore',
  });
  await new Promise((r) => setTimeout(r, 700));

  const browser = await chromium.launch({
    args: [
      '--use-fake-device-for-media-stream',
      '--use-fake-ui-for-media-stream',
      `--use-file-for-fake-video-capture=${clipPath}`,
    ],
  });
  const context = await browser.newContext({
    permissions: ['camera'],
    viewport: { width: 1400, height: 1000 },
  });

  const problems = [];
  const page = await context.newPage();
  page.on('pageerror', (error) => problems.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') problems.push(message.text());
  });

  let failures = 0;
  const check = (ok, name, detail = '') => {
    if (ok) console.log(`  ok   ${name}`);
    else {
      failures++;
      console.error(`  FAIL ${name}${detail ? `\n       ${detail}` : ''}`);
    }
  };

  try {
    await page.goto(`${BASE}/app/receive.html`, { waitUntil: 'networkidle' });
    await page.click('#start');

    await page.waitForFunction(() => !document.querySelector('#result-card').hidden, {
      timeout: 90000,
    });

    const state = await page.evaluate(() => ({
      status: document.querySelector('#status').textContent.trim(),
      name: document.querySelector('#result-name').textContent,
      text: document.querySelector('#result-text').textContent,
      verified: !document.querySelector('#verify-badge').hidden,
      blocks: document.querySelector('#stat-blocks').textContent,
      seen: Number(document.querySelector('#stat-seen').textContent),
      dupes: Number(document.querySelector('#stat-dupes').textContent),
      scanRate: Number(document.querySelector('#stat-scanrate').textContent),
      message: document.querySelector('#message').hidden
        ? ''
        : document.querySelector('#message').textContent,
    }));

    check(state.message === '', 'no error was reported', state.message);
    check(state.status.includes('Complete'), 'the scanner reached the complete state', state.status);
    check(state.name === 'camera-test.txt', 'the filename survived the transfer', state.name);
    check(state.verified, 'the payload checksum verified');
    check(state.text === MESSAGE, 'the decoded text matches what was broadcast');
    check(state.seen > 0, `frames were read from the camera (${state.seen})`);
    check(state.scanRate > 1, `the scan loop ran at a usable rate (${state.scanRate}/s)`);
    check(
      state.dupes > 0,
      'repeated frames from the looping clip were recognised as repeats',
      `duplicates: ${state.dupes}`,
    );

    // Filming a second, different broadcast must not merge with the first.
    await page.click('#again');
    const reset = await page.evaluate(() => ({
      hidden: document.querySelector('#result-card').hidden,
      blocks: document.querySelector('#stat-blocks').textContent,
    }));
    check(reset.hidden && reset.blocks === '0 / 0', 'receiving another resets the session');

    check(problems.length === 0, 'the page reported no errors', problems.join('; '));
  } finally {
    await browser.close();
    server.kill();
    await rm(workDir, { recursive: true, force: true });
  }

  console.log(failures === 0 ? '\nall camera tests passed\n' : `\n${failures} failed\n`);
  process.exit(failures > 0 ? 1 : 0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
