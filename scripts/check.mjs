// Check the public deliverable, including executable syntax after HTML embedding.
import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { Script } from 'node:vm';
import assert from 'node:assert/strict';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
for (const name of await readdir(resolve(root, 'src'))) {
  if (name.endsWith('.js')) new Script(await readFile(resolve(root, 'src', name), 'utf8'), { filename: name });
}
const html = await readFile(resolve(root, 'dist/index.html'), 'utf8');
const download = await readFile(resolve(root, 'dist/FogLab.html'), 'utf8');
assert.equal(download, html, 'The downloadable HTML must match the hosted demo');
const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map(match => match[1]);
assert.equal(new Set(ids).size, ids.length, 'Duplicate static HTML ids');
assert(!/<script\b[^>]*\bsrc=/i.test(html), 'Offline deliverable contains an external script');
assert(!/<link\b[^>]*\brel=["']stylesheet/i.test(html), 'Offline deliverable contains an external stylesheet');
assert(!/\/workspace\/|C:\\\\trontstack|__PREVIEW_URI__/.test(html), 'Local path or build placeholder leaked into deliverable');
const scripts = [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)];
assert(scripts.length >= 2, 'Expected embedded Three.js and application scripts');
for (let i = 0; i < scripts.length; i++) new Script(scripts[i][1], { filename: `dist:inline-${i}.js` });
assert(html.includes('https://github.com/TrentSterling/fog'), 'Missing public source link');
assert(html.includes('https://tront.xyz/fog/'), 'Missing canonical destination');
console.log(`Checked ${scripts.length} embedded scripts, ${ids.length} unique ids, and identical offline/hosted output.`);
