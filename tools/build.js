#!/usr/bin/env node
/**
 * Builds self-contained, single-file versions of each page into `dist/`.
 *
 * The point is the air gap. A machine that is deliberately not on any network
 * cannot fetch a stylesheet, cannot resolve an ES module graph over `file://`,
 * and probably should not be running a web server just to open a page. So each
 * page is flattened into one HTML file with every stylesheet, script, module
 * and icon inlined -- copy it onto a USB stick, open it, done.
 *
 * This is deliberately a small bundler rather than a dependency: adding a build
 * toolchain to a project whose whole claim is "no runtime dependencies" would
 * be a poor trade, and the module graph here is small and acyclic.
 */

import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = join(root, 'dist');

/** Pages to build, and the flat filename each gets in `dist/`. */
const PAGES = [
  ['index.html', 'index.html'],
  ['app/send.html', 'send.html'],
  ['app/receive.html', 'receive.html'],
  ['app/lab.html', 'lab.html'],
];

const PAGE_NAMES = new Set(PAGES.map(([, name]) => name));

// --------------------------------------------------------------- ES modules

/**
 * Flattens a module graph into one script.
 *
 * Each module becomes an IIFE that returns its exports, and imports become
 * destructuring from a registry. Wrapping rather than concatenating means two
 * modules can use the same private name without colliding, which a flat
 * concatenation would silently get wrong.
 */
class ModuleBundler {
  constructor() {
    this.bodies = new Map();
    this.order = [];
    this.visiting = new Set();
  }

  /** Add a module file and everything it depends on. Returns its registry id. */
  async addFile(path) {
    const id = relative(root, path).split('\\').join('/');
    if (this.bodies.has(id)) return id;
    if (this.visiting.has(id)) {
      throw new Error(`import cycle at ${id}; this bundler assumes an acyclic graph`);
    }
    this.visiting.add(id);

    const source = await readFile(path, 'utf8');
    const { body, exports } = await this.transform(source, dirname(path));

    this.visiting.delete(id);
    this.bodies.set(id, `${body}\nreturn {${[...exports].join(', ')}};`);
    this.order.push(id);
    return id;
  }

  /**
   * Rewrite one module's imports and exports, recursing into its dependencies.
   *
   * @returns {Promise<{body: string, exports: Set<string>}>}
   */
  async transform(source, baseDir) {
    const exports = new Set();
    let body = source;

    // `import { a, b as c } from './x.js';` or `import * as ns from './x.js';`,
    // possibly spread over several lines.
    const pattern = /^[ \t]*import\s+([\s\S]*?)\s+from\s+['"]([^'"]+)['"];?[ \t]*$/gm;
    const found = [...body.matchAll(pattern)].map((match) => ({
      clause: match[1].trim(),
      specifier: match[2],
      text: match[0],
    }));

    for (const entry of found) {
      if (!entry.specifier.startsWith('.')) {
        throw new Error(`only relative imports are supported, got "${entry.specifier}"`);
      }
      const id = await this.addFile(resolve(baseDir, entry.specifier));
      const registry = `__qrs[${JSON.stringify(id)}]`;

      let binding;
      if (entry.clause.startsWith('*')) {
        binding = `const ${entry.clause.replace(/^\*\s*as\s+/, '')} = ${registry};`;
      } else if (entry.clause.startsWith('{')) {
        // `a as b` is valid in an import clause but must become `a: b` here.
        binding = `const {${entry.clause.slice(1, -1).replace(/\s+as\s+/g, ': ')}} = ${registry};`;
      } else {
        throw new Error(`default imports are not used in this project: "${entry.clause}"`);
      }
      // A function replacement, because `$` sequences in a replacement
      // *string* are substitution patterns and would corrupt the code.
      body = body.replace(entry.text, () => binding);
    }

    if (/^\s*export\s+default/m.test(body)) {
      throw new Error('default exports are not used in this project');
    }

    // `export function foo` and friends: drop the keyword, keep the declaration.
    body = body.replace(
      /^[ \t]*export\s+(async\s+function|function|class|const|let|var)\s+([A-Za-z_$][\w$]*)/gm,
      (_, keyword, name) => {
        exports.add(name);
        return `${keyword} ${name}`;
      },
    );

    // `export { a, b as c };`, including re-exports of imported bindings.
    body = body.replace(/^[ \t]*export\s*\{([^}]*)\};?[ \t]*$/gm, (_, list) => {
      for (const item of list.split(',')) {
        const name = item.trim();
        if (name) exports.add(name.split(/\s+as\s+/).pop().trim());
      }
      return '';
    });

    return { body, exports };
  }

  /** The finished script: every module, in dependency order. */
  render() {
    const parts = ['const __qrs = {};'];
    for (const id of this.order) {
      parts.push(`__qrs[${JSON.stringify(id)}] = (() => {\n${this.bodies.get(id)}\n})();`);
    }
    return parts.join('\n\n');
  }
}

// ---------------------------------------------------------------- HTML pass

/** A literal `</script>` inside an inline script would end the element early. */
function escapeForScript(code) {
  return code.replace(/<\/script>/gi, '<\\/script>');
}

async function buildPage(sourcePath, outputName) {
  const pageDir = dirname(join(root, sourcePath));
  let html = await readFile(join(root, sourcePath), 'utf8');

  for (const match of [...html.matchAll(/<link[^>]+rel=["']stylesheet["'][^>]*>/gi)]) {
    const href = /href=["']([^"']+)["']/i.exec(match[0])?.[1];
    if (!href) continue;
    const css = await readFile(resolve(pageDir, href), 'utf8');
    html = html.replace(match[0], () => `<style>\n${css}\n</style>`);
  }

  for (const match of [...html.matchAll(/<link[^>]+rel=["']icon["'][^>]*>/gi)]) {
    const href = /href=["']([^"']+)["']/i.exec(match[0])?.[1];
    if (!href) continue;
    const svg = await readFile(resolve(pageDir, href), 'utf8');
    const encoded = Buffer.from(svg, 'utf8').toString('base64');
    html = html.replace(
      match[0],
      () => `<link rel="icon" href="data:image/svg+xml;base64,${encoded}">`,
    );
  }

  // Classic scripts, i.e. the vendored decoder.
  const classic = /<script(?![^>]*type=["']module["'])[^>]*\ssrc=["']([^"']+)["'][^>]*><\/script>/gi;
  for (const match of [...html.matchAll(classic)]) {
    const code = await readFile(resolve(pageDir, match[1]), 'utf8');
    html = html.replace(match[0], () => `<script>\n${escapeForScript(code)}\n</script>`);
  }

  // Module scripts, both `src=` and inline.
  const modules = /<script[^>]*type=["']module["'][^>]*>([\s\S]*?)<\/script>/gi;
  for (const match of [...html.matchAll(modules)]) {
    const src = /\ssrc=["']([^"']+)["']/i.exec(match[0])?.[1];
    const bundler = new ModuleBundler();
    let script;

    if (src) {
      const id = await bundler.addFile(resolve(pageDir, src));
      script = `${bundler.render()}\n\nvoid __qrs[${JSON.stringify(id)}];`;
    } else {
      const { body } = await bundler.transform(match[1], pageDir);
      script = `${bundler.render()}\n\n${body}`;
    }

    html = html.replace(
      match[0],
      () => `<script>\n(() => {\n${escapeForScript(script)}\n})();\n</script>`,
    );
  }

  // Flatten inter-page links: in dist/ everything sits in one directory.
  html = html.replace(/href=["']([^"']*?)([\w-]+\.html)["']/gi, (whole, _prefix, file) =>
    PAGE_NAMES.has(file) ? `href="${file}"` : whole,
  );

  await writeFile(join(outDir, outputName), html, 'utf8');
  return Buffer.byteLength(html, 'utf8');
}

// --------------------------------------------------------------------- main

async function main() {
  await rm(outDir, { recursive: true, force: true });
  await mkdir(outDir, { recursive: true });

  console.log('Building self-contained pages into dist/\n');
  let total = 0;
  for (const [source, output] of PAGES) {
    const bytes = await buildPage(source, output);
    total += bytes;
    console.log(`  ${output.padEnd(16)}${(bytes / 1024).toFixed(0).padStart(6)} kB`);
  }
  console.log(`  ${'-'.repeat(22)}`);
  console.log(`  ${'total'.padEnd(16)}${(total / 1024).toFixed(0).padStart(6)} kB\n`);
  console.log('Each file opens straight from the filesystem: no server, no network.');
}

main().catch((error) => {
  console.error(`\nBuild failed: ${error.message}\n`);
  process.exit(1);
});
