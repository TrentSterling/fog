// Build with Node alone. No package install, CDN, bundler, or network is needed.
import { readFile, writeFile, mkdir, copyFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = name => readFile(resolve(root, name), 'utf8');
const modules = ['presets.js', 'world.js', 'sim.js', 'fog.js', 'app.js', 'lab-tools.js', 'learning.js'];
const [template, style, three, threeLicense, license, ...source] = await Promise.all([
  read('src/template.html'), read('src/style.css'), read('vendor/three.cjs'),
  read('vendor/three-LICENSE.txt'), read('LICENSE'), ...modules.map(name => read('src/' + name))
]);
const inlineScript = script => script.replace(/<\/script/gi, '<\\/script');
const sourceBlock = source.map((text, i) => `\n/* Source: src/${modules[i]} */\n${text}`).join('\n');
const replacements = {
  '/*__STYLE__*/': style,
  '/*__THREE__*/': inlineScript(`/* Three.js r180 · MIT\n${threeLicense}\n*/\n(function () { const exports = {};\n${three}\nwindow.THREE = exports;\n})();`),
  '/*__APP__*/': inlineScript(`\n/* FogLab 0.1.0\n${license}\n*/\n${sourceBlock}`)
};
let html = template;
for (const [placeholder, contents] of Object.entries(replacements)) {
  if (html.split(placeholder).length !== 2) throw new Error(`Expected one ${placeholder} in the template`);
  html = html.replace(placeholder, () => contents);
}
if (html.includes('/*__PREVIEW_URI__*/')) {
  const png = await readFile(resolve(root, 'assets/foglab-preview.png'));
  html = html.replaceAll('/*__PREVIEW_URI__*/', `data:image/png;base64,${png.toString('base64')}`);
}
if (/\/\*__[A-Z_]+__\*\//.test(html)) throw new Error('An unfilled build placeholder remains');
const dist = resolve(root, 'dist');
await mkdir(resolve(dist, 'assets'), { recursive: true });
await Promise.all([
  writeFile(resolve(dist, 'index.html'), html),
  writeFile(resolve(dist, 'FogLab.html'), html),
  writeFile(resolve(dist, '.nojekyll'), ''),
  copyFile(resolve(root, 'assets/foglab-preview.png'), resolve(dist, 'assets/foglab-preview.png'))
]);
const manifest = {
  name: 'FogLab', version: '0.1.0', three: 'r180',
  htmlBytes: Buffer.byteLength(html),
  sha256: createHash('sha256').update(html).digest('hex'),
  modules: modules.map(name => 'src/' + name)
};
await writeFile(resolve(dist, 'build.json'), JSON.stringify(manifest, null, 2) + '\n');
console.log(`Built dist/index.html and dist/FogLab.html (${manifest.htmlBytes.toLocaleString()} bytes each). All runtime assets are embedded.`);
