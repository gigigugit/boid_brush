import { existsSync } from 'node:fs';
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const targetRoot = path.join(repoRoot, 'capacitor', 'www');

const rootFiles = [
  'app.html',
  'app.js',
  'blob-stroke.js',
  'boid-renderer.js',
  'brushes.js',
  'circle.png',
  'compositor.js',
  'demo.html',
  'fluid-renderer.js',
  'index.html',
  'platform-bridge.js',
  'psd-io.js',
  'selection.js',
  'stamp-presets.js',
  'ui.js',
  'wasm-bridge.js',
  'webgpu-boid-sim.js',
  'webgpu-fluid-sim.js'
];

const rootDirs = [
  'docs',
  'playground',
  path.join('wasm-sim', 'pkg')
];

const copyItem = async relativePath => {
  const from = path.join(repoRoot, relativePath);
  const to = path.join(targetRoot, relativePath);
  await mkdir(path.dirname(to), { recursive: true });
  await cp(from, to, { recursive: true, force: true });
};

const writeNativeIndex = async () => {
  const source = await readFile(path.join(repoRoot, 'index.html'), 'utf8');
  const redirect = `<script>\n  const target = new URL('./app.html', window.location.href);\n  target.search = window.location.search;\n  target.hash = window.location.hash;\n  window.location.replace(target.toString());\n</script>`;
  const nativeIndex = source.replace(
    '<a class="main-app" href="app.html">',
    `${redirect}\n  <a class="main-app" href="app.html">`
  );
  await writeFile(path.join(targetRoot, 'index.html'), nativeIndex, 'utf8');
};

if (existsSync(targetRoot)) await rm(targetRoot, { recursive: true });
await mkdir(targetRoot, { recursive: true });
await Promise.all([...rootFiles, ...rootDirs].map(copyItem));
await writeNativeIndex();
console.log(`Prepared Capacitor web assets in ${targetRoot}`);
