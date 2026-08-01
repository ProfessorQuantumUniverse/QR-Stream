#!/usr/bin/env node
/**
 * Verifies the single-file build.
 *
 * These pages are opened over `file://` with no server anywhere, which is the
 * situation they exist for. The test also asserts that nothing is fetched over
 * the network: a single stray `<link>` or `<script src>` left un-inlined would
 * make the build useless on the machine it is meant for, and would still look
 * perfectly fine on a developer's laptop.
 */

import { readdir } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { chromium } from 'playwright';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const dist = join(root, 'dist');

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
  const files = await readdir(dist).catch(() => []);
  if (files.length === 0) {
    console.error('dist/ is empty — run `npm run build` first.');
    process.exit(1);
  }

  const browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 1400, height: 1000 } });

  const remoteRequests = [];
  const problems = [];
  context.on('page', (page) => {
    page.on('pageerror', (error) => problems.push(`${page.url()}: ${error.message}`));
    page.on('console', (message) => {
      if (message.type() === 'error') problems.push(`${page.url()}: ${message.text()}`);
    });
    page.on('request', (request) => {
      if (!request.url().startsWith('file://') && !request.url().startsWith('data:')) {
        remoteRequests.push(request.url());
      }
    });
  });

  const page = await context.newPage();
  const url = (name) => pathToFileURL(join(dist, name)).href;

  console.log('\nQR-Stream single-file build tests\n');

  for (const name of ['index.html', 'send.html', 'receive.html', 'lab.html']) {
    await check(`${name} loads from file:// with no server`, async () => {
      await page.goto(url(name));
      await page.waitForLoadState('domcontentloaded');
      assert((await page.title()).includes('QR-Stream'), 'unexpected title');
      // A page whose inlined CSS failed would still render, so check a computed
      // style that only the stylesheet provides.
      const styled = await page.evaluate(
        () => getComputedStyle(document.body).fontFamily.includes('system-ui'),
      );
      assert(styled, 'stylesheet was not inlined');
    });
  }

  await check('the sender streams frames from a file:// page', async () => {
    await page.goto(url('send.html'));
    await page.fill('#text-input', 'offline build test '.repeat(80));
    await page.click('#start');
    await page.waitForFunction(
      () => Number(document.querySelector('#stat-frames').textContent) > 3,
      { timeout: 15000 },
    );
    const ink = await page.evaluate(() => {
      const canvas = document.querySelector('#qr-canvas');
      const data = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
      let dark = 0;
      for (let i = 0; i < data.length; i += 4) if (data[i] < 128) dark++;
      return dark / (data.length / 4);
    });
    assert(ink > 0.1 && ink < 0.75, `implausible dark module ratio ${ink.toFixed(3)}`);
  });

  await check('a full transfer completes in the offline lab build', async () => {
    await page.goto(url('lab.html'));
    await page.selectOption('#payload', 'text-small');
    await page.selectOption('#speed', '0');
    await page.locator('#loss').fill('40');
    await page.click('#run');
    await page.waitForSelector('#verdict:not([hidden])', { timeout: 120000 });
    const verdict = await page.textContent('#verdict');
    assert(verdict.includes('byte-for-byte'), `transfer failed: ${verdict}`);
  });

  await check('navigation between built pages stays inside dist/', async () => {
    await page.goto(url('index.html'));
    await page.click('a[href="send.html"]');
    await page.waitForLoadState('domcontentloaded');
    assert(page.url().endsWith('/send.html'), `navigated to ${page.url()}`);
    assert((await page.title()).includes('Send'), 'wrong page after navigation');
  });

  await check('no page requested anything over the network', async () => {
    assert(remoteRequests.length === 0, `network requests: ${remoteRequests.join(', ')}`);
  });

  await check('no page reported an error', async () => {
    assert(problems.length === 0, `page problems:\n       ${problems.join('\n       ')}`);
  });

  await browser.close();
  console.log(`\n${passes} passed, ${failures} failed\n`);
  process.exit(failures > 0 ? 1 : 0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
