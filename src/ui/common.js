/** Shared bits of UI plumbing: theming, element lookup, small formatters. */

export const $ = (selector, root = document) => root.querySelector(selector);
export const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

/** Look up every element with an id, keyed by a camelCased version of that id. */
export function collectRefs(root = document) {
  const refs = {};
  for (const element of root.querySelectorAll('[id]')) {
    refs[element.id.replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = element;
  }
  return refs;
}

export function setText(element, value) {
  if (element && element.textContent !== String(value)) element.textContent = String(value);
}

/**
 * Theme handling. Defaults to the system preference and remembers an explicit
 * choice, because someone demoing this in a dark room and someone reading it on
 * a laptop outdoors want opposite things.
 */
export function initTheme() {
  const stored = localStorage.getItem('qrstream-theme');
  if (stored === 'dark' || stored === 'light') {
    document.documentElement.dataset.theme = stored;
  }

  for (const button of $$('[data-theme-toggle]')) {
    button.addEventListener('click', () => {
      const current =
        document.documentElement.dataset.theme ||
        (matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark');
      const next = current === 'dark' ? 'light' : 'dark';
      document.documentElement.dataset.theme = next;
      localStorage.setItem('qrstream-theme', next);
    });
  }
}

/** Mark the nav link matching the current page. */
export function markCurrentPage() {
  const here = location.pathname.split('/').pop() || 'index.html';
  for (const link of $$('.topbar nav a')) {
    const target = link.getAttribute('href')?.split('/').pop();
    if (target === here) link.setAttribute('aria-current', 'page');
  }
}

/** Set up a circular progress indicator, returning a setter for 0..1. */
export function progressRing(container, { size = 148, stroke = 9 } = {}) {
  const radius = (size - stroke) / 2;
  const circumference = 2 * Math.PI * radius;
  const gradientId = `ring-${Math.random().toString(36).slice(2, 8)}`;

  container.innerHTML = `
    <svg width="${size}" height="${size}" aria-hidden="true">
      <defs>
        <linearGradient id="${gradientId}" x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stop-color="var(--accent)" />
          <stop offset="100%" stop-color="var(--accent-2)" />
        </linearGradient>
      </defs>
      <circle class="track" cx="${size / 2}" cy="${size / 2}" r="${radius}"
              stroke-width="${stroke}" />
      <circle class="value" cx="${size / 2}" cy="${size / 2}" r="${radius}"
              stroke-width="${stroke}" stroke="url(#${gradientId})"
              stroke-dasharray="${circumference}" stroke-dashoffset="${circumference}" />
    </svg>
    <div class="readout"><span class="pct">0%</span><span class="sub"></span></div>
  `;

  const value = container.querySelector('.value');
  const pct = container.querySelector('.pct');
  const sub = container.querySelector('.sub');

  return {
    set(fraction, subtitle = '') {
      const clamped = Math.max(0, Math.min(1, fraction));
      value.style.strokeDashoffset = String(circumference * (1 - clamped));
      pct.textContent = `${Math.floor(clamped * 100)}%`;
      sub.textContent = subtitle;
    },
  };
}

/**
 * A grid of cells, one per source block, that lights up as blocks are recovered.
 *
 * This is the clearest possible illustration of how a fountain code differs
 * from the old sequential scheme: cells fill in scattered, out of order, and
 * sometimes several at once as the peeling decoder cascades.
 */
export function blockMap(container) {
  let count = 0;
  let cells = [];

  return {
    reset(blockCount) {
      count = blockCount;
      container.innerHTML = '';
      if (!blockCount) return;
      // Shrink the cells as the block count grows, so a large transfer still
      // fits on screen without the map turning into a scrollbar.
      const cell = blockCount <= 120 ? 14 : blockCount <= 600 ? 9 : blockCount <= 2500 ? 6 : 4;
      container.style.setProperty('--cell', `${cell}px`);
      const fragment = document.createDocumentFragment();
      cells = [];
      for (let i = 0; i < blockCount; i++) {
        const cell = document.createElement('i');
        fragment.append(cell);
        cells.push(cell);
      }
      container.append(fragment);
    },
    update(mask) {
      if (!count || mask.length !== count) return;
      for (let i = 0; i < count; i++) {
        const on = mask[i] === 1;
        if (on !== cells[i].classList.contains('on')) cells[i].classList.toggle('on', on);
      }
    },
  };
}

/** Trigger a browser download for a byte payload. */
export function downloadBytes(bytes, name, mime) {
  const blob = new Blob([bytes], { type: mime || 'application/octet-stream' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = name || 'download';
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

/** Show a transient message in a `.message` element. */
export function showMessage(element, text, kind = '') {
  if (!element) return;
  element.textContent = text;
  element.className = `message ${kind}`.trim();
  element.hidden = !text;
}
