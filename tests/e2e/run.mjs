#!/usr/bin/env node
/**
 * Browser end-to-end tests.
 *
 * The unit tests prove the codec and the protocol in isolation; these prove the
 * pages actually work in a browser -- that the modules load, the canvas paints,
 * the controls are wired up, and a complete transfer really does run through
 * rendered pixels. A camera cannot be scripted, so the receiver's decode path is
 * exercised through the Loopback Lab, which uses the same scanner and the same
 * `ReceiverSession`.
 */

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { chromium } from 'playwright';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../..');
const PORT = Number(process.env.PORT ?? 8321);
const BASE = `http://localhost:${PORT}`;

let failures = 0;
let passes = 0;

async function check(name, fn) {
  try {
    await fn();
    passes++;
    console.log(`  ok   ${name}`);
  } catch (error) {
    failures++;
    console.error(`  FAIL ${name}\n       ${error.message}`);
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function main() {
  const server = spawn(process.execPath, [resolve(root, 'tools/serve.js'), String(PORT), root], {
    stdio: 'ignore',
  });
  await new Promise((r) => setTimeout(r, 700));

  const browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });

  // Any uncaught error or failed request in a page is a test failure: a broken
  // import path would otherwise leave a page that merely looks fine.
  const problems = [];
  context.on('page', (page) => {
    page.on('pageerror', (error) => problems.push(`${page.url()}: ${error.message}`));
    page.on('requestfailed', (request) =>
      problems.push(`${page.url()}: request failed ${request.url()}`),
    );
    page.on('console', (message) => {
      if (message.type() === 'error') problems.push(`${page.url()}: console ${message.text()}`);
    });
  });

  const page = await context.newPage();

  console.log('\nQR-Stream browser tests\n');

  await check('landing page loads and links to the apps', async () => {
    await page.goto(`${BASE}/index.html`, { waitUntil: 'networkidle' });
    assert((await page.title()).includes('QR-Stream'), 'unexpected title');
    assert(await page.locator('a[href="app/send.html"]').first().isVisible(), 'no send link');
    assert(await page.locator('a[href="app/receive.html"]').first().isVisible(), 'no receive link');
  });

  await check('legacy sender URL redirects to the new page', async () => {
    await page.goto(`${BASE}/mainhtml/sender.html`, { waitUntil: 'networkidle' });
    assert(page.url().endsWith('/app/send.html'), `landed on ${page.url()}`);
  });

  await check('sender renders a QR symbol and advances frames', async () => {
    await page.goto(`${BASE}/app/send.html`, { waitUntil: 'networkidle' });
    await page.fill('#text-input', 'hello from the end to end test '.repeat(60));
    await page.click('#start');
    await page.waitForFunction(() => Number(document.querySelector('#stat-frames').textContent) > 3, {
      timeout: 10000,
    });

    // The canvas must contain an actual symbol, not a blank white square.
    const ink = await page.evaluate(() => {
      const canvas = document.querySelector('#qr-canvas');
      const data = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
      let dark = 0;
      for (let i = 0; i < data.length; i += 4) if (data[i] < 128) dark++;
      return dark / (data.length / 4);
    });
    assert(ink > 0.1 && ink < 0.75, `implausible dark module ratio ${ink.toFixed(3)}`);

    const blocks = Number(await page.textContent('#stat-blocks'));
    assert(blocks > 0, 'no block count reported');
    await page.click('#stop');
  });

  await check('sender pause and resume actually stop the frame counter', async () => {
    await page.goto(`${BASE}/app/send.html`, { waitUntil: 'networkidle' });
    await page.fill('#text-input', 'pause test '.repeat(200));
    await page.click('#start');
    await page.waitForFunction(() => Number(document.querySelector('#stat-frames').textContent) > 2);
    await page.click('#pause');
    const frozen = await page.textContent('#stat-frames');
    await page.waitForTimeout(600);
    assert((await page.textContent('#stat-frames')) === frozen, 'frames advanced while paused');
    await page.click('#pause');
    await page.waitForFunction(
      (was) => Number(document.querySelector('#stat-frames').textContent) > Number(was),
      frozen,
      { timeout: 5000 },
    );
  });

  await check('sender rejects an empty payload with a visible message', async () => {
    await page.goto(`${BASE}/app/send.html`, { waitUntil: 'networkidle' });
    await page.click('#start');
    assert(await page.locator('#message').isVisible(), 'no error shown');
    assert(
      (await page.textContent('#message')).toLowerCase().includes('text'),
      'error text is unhelpful',
    );
  });

  await check('receiver page loads and reports a stopped scanner', async () => {
    await page.goto(`${BASE}/app/receive.html`, { waitUntil: 'networkidle' });
    assert((await page.textContent('#status')).includes('Stopped'), 'unexpected initial status');
    assert(await page.locator('#ring svg').isVisible(), 'progress ring did not render');
    assert(await page.evaluate(() => typeof window.jsQR === 'function'), 'scanner not loaded');
  });

  await check('receiver explains itself when no camera can be opened', async () => {
    await page.goto(`${BASE}/app/receive.html`, { waitUntil: 'networkidle' });
    await page.click('#start');
    await page.waitForSelector('#message:not([hidden])', { timeout: 10000 });
    const text = await page.textContent('#message');
    assert(text.length > 20, 'error message too terse to be useful');
  });

  // The headline test: a real payload, really encoded, really rasterised, really
  // decoded, with a third of the frames thrown away.
  await check('a full transfer completes through pixels at 30% frame loss', async () => {
    await page.goto(`${BASE}/app/lab.html`, { waitUntil: 'networkidle' });
    await page.selectOption('#payload', 'text-small');
    await page.selectOption('#speed', '0');
    await page.locator('#loss').fill('30');
    await page.click('#run');
    await page.waitForSelector('#verdict:not([hidden])', { timeout: 120000 });

    const verdict = await page.textContent('#verdict');
    assert(verdict.includes('byte-for-byte'), `transfer failed: ${verdict}`);
    assert(
      (await page.getAttribute('#verdict', 'class')).includes('ok'),
      `verdict not marked as success: ${verdict}`,
    );
    assert((await page.textContent('#phase')).includes('Complete'), 'phase did not reach Complete');
  });

  await check('a binary payload survives 70% frame loss', async () => {
    await page.goto(`${BASE}/app/lab.html`, { waitUntil: 'networkidle' });
    await page.selectOption('#payload', 'random-8');
    await page.selectOption('#speed', '0');
    await page.locator('#loss').fill('70');
    await page.click('#run');
    await page.waitForSelector('#verdict:not([hidden])', { timeout: 180000 });

    const verdict = await page.textContent('#verdict');
    assert(verdict.includes('byte-for-byte'), `transfer failed: ${verdict}`);

    const dropped = Number(await page.textContent('#stat-dropped'));
    const decoded = Number(await page.textContent('#stat-decoded'));
    assert(dropped > decoded * 1.5, `loss simulation did not bite: ${dropped} vs ${decoded}`);
    assert(
      Number(await page.textContent('#stat-unreadable')) === 0,
      'some rendered frames could not be decoded at all',
    );
  });

  await check('theme toggle persists across pages', async () => {
    await page.goto(`${BASE}/index.html`, { waitUntil: 'networkidle' });
    await page.click('[data-theme-toggle]');
    const chosen = await page.evaluate(() => document.documentElement.dataset.theme);
    await page.goto(`${BASE}/app/send.html`, { waitUntil: 'networkidle' });
    assert(
      (await page.evaluate(() => document.documentElement.dataset.theme)) === chosen,
      'theme did not carry over',
    );
  });

  await check('no page reported an error while running', async () => {
    assert(problems.length === 0, `page problems:\n       ${problems.join('\n       ')}`);
  });

  await browser.close();
  server.kill();

  console.log(`\n${passes} passed, ${failures} failed\n`);
  process.exit(failures > 0 ? 1 : 0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
