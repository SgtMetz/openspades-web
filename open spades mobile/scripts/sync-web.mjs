// Copies the compiled engine, Three.js and game media from the web build (../browser/dist) into web/.
// Run after rebuilding the web port:  node scripts/sync-web.mjs     GPL-3.0-or-later.
//
// Files that are mobile-specific and maintained in web/ are NOT overwritten:
//   index.html, mobile.css, main.js (fork of browser/dist/main.js), touch.js, native.js
import {cp, rm, stat} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const source = path.resolve(process.argv[2] || path.join(here, '../../browser/dist'));
const target = path.resolve(here, '../web');
const shared = ['engine', 'vendor', 'assets', 'audio.js', 'hud.js', 'models.js', 'viewweapon.js', 'OPENSPADES-LICENSE.txt'];

try { await stat(path.join(source, 'engine/openspades.wasm')); }
catch { console.error(`No web build at ${source}. Build the web port first (browser/build.ps1) or pass its dist path.`); process.exit(1); }

for (const item of shared) {
  const from = path.join(source, item), to = path.join(target, item);
  await rm(to, {recursive: true, force: true});
  await cp(from, to, {recursive: true});
  console.log('copied', item);
}
console.log(`\nweb/ is up to date with ${source}.`);
console.log('If browser/dist/main.js changed, merge those changes into web/main.js by hand (it is a mobile fork).');
